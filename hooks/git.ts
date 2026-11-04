// File work on the person's own machine, through git. Modest and safe: it never
// pushes, never force-anything, and never throws away local changes (a pull
// with uncommitted changes is refused, a failed merge with no conflicts is
// aborted back to where it was).
import type { FilesReport } from './lib/events.ts'
import type { Shell } from './port.ts'

type Hunk = NonNullable<FilesReport['hunks']>[number]
type Out = { code: number; out: string; err: string }

const SEP = '\x1f'

export async function git(sh: Shell, args: string[], timeoutMs = 20_000): Promise<Out> {
  const r = await sh.run(['git', ...args], { timeoutMs })
  return { code: r.exitCode, out: r.stdout, err: r.stderr }
}

async function gitOk(sh: Shell, args: string[], timeoutMs?: number): Promise<string | null> {
  try {
    const r = await git(sh, args, timeoutMs)
    return r.code === 0 ? r.out.trim() : null
  } catch {
    return null
  }
}

export async function repoRoot(sh: Shell): Promise<string | null> {
  return gitOk(sh, ['rev-parse', '--show-toplevel'])
}

export async function head(sh: Shell): Promise<string | null> {
  return gitOk(sh, ['rev-parse', 'HEAD'])
}

async function branchName(sh: Shell): Promise<string | undefined> {
  return (await gitOk(sh, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? undefined
}

/** The git branch this folder is on ("HEAD" when detached). */
export const currentBranch = branchName

async function isDirty(sh: Shell): Promise<boolean> {
  const s = await gitOk(sh, ['status', '--porcelain', '--untracked-files=no'])
  return !!s
}

/** For hello: repo, branch, dirty. Undefined outside a repository or without a shell (not the CLI). */
export async function gitInfo(sh: Shell): Promise<{ repo?: string; branch?: string; dirty?: boolean } | undefined> {
  const root = await repoRoot(sh)
  if (!root) return undefined
  const remote = await gitOk(sh, ['remote', 'get-url', 'origin'])
  const m = remote?.match(/[/:]([^/:]+\/[^/]+?)(\.git)?$/)
  const repo = m ? m[1] : root.replace(/\\/g, '/').split('/').filter(Boolean).pop()
  return { repo, branch: await branchName(sh), dirty: await isDirty(sh) }
}

function commitsOf(text: string): { sha: string; subject: string; author?: string }[] {
  return text.split('\n').filter(Boolean).map((l) => {
    const [sha = '', subject = '', author] = l.split(SEP)
    return { sha: sha.slice(0, 12), subject, author: author || undefined }
  })
}

// ------------------------------------------------------------ conflicts

type Parsed = { start: number; end: number; mine: string; theirs: string; line: number }

/** Finds `<<<<<<<` … `=======` … `>>>>>>>` blocks (with or without a diff3 base). */
export function parseConflicts(text: string): Parsed[] {
  const lines = text.split('\n')
  const out: Parsed[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) { i++; continue }
    const start = i
    const mine: string[] = []
    const theirs: string[] = []
    let j = i + 1
    let part: 'mine' | 'base' | 'theirs' = 'mine'
    let closed = false
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (part === 'mine' && l.startsWith('|||||||')) { part = 'base'; continue }
      if ((part === 'mine' || part === 'base') && l.startsWith('=======')) { part = 'theirs'; continue }
      if (part === 'theirs' && l.startsWith('>>>>>>>')) { closed = true; break }
      if (part === 'mine') mine.push(l)
      else if (part === 'theirs') theirs.push(l)
    }
    if (!closed) break
    out.push({ start, end: j, mine: mine.join('\n'), theirs: theirs.join('\n'), line: start + 1 })
    i = j + 1
  }
  return out
}

/** Replaces each picked block with its side; blocks without a pick keep their markers. */
export function applyPicks(text: string, file: string, picks: Record<string, 'mine' | 'theirs' | 'claude'>): { text: string; left: number } {
  const lines = text.split('\n')
  const blocks = parseConflicts(text)
  let left = 0
  for (let n = blocks.length - 1; n >= 0; n--) {
    const b = blocks[n]
    const pick = picks[`${file}#${n + 1}`]
    if (pick !== 'mine' && pick !== 'theirs') { left++; continue }
    const body = pick === 'mine' ? b.mine : b.theirs
    lines.splice(b.start, b.end - b.start + 1, ...(body === '' ? [] : body.split('\n')))
  }
  return { text: lines.join('\n'), left }
}

async function conflictedFiles(sh: Shell): Promise<string[]> {
  const out = await gitOk(sh, ['diff', '--name-only', '--diff-filter=U'])
  return out ? out.split('\n').filter(Boolean) : []
}

async function readRepoFile(sh: Shell, root: string, file: string): Promise<string | null> {
  try {
    const t = await sh.read(`${root}/${file}`)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

export async function conflictHunks(sh: Shell): Promise<Hunk[]> {
  const root = await repoRoot(sh)
  if (!root) return []
  const hunks: Hunk[] = []
  for (const file of await conflictedFiles(sh)) {
    const text = await readRepoFile(sh, root, file)
    if (text === null) continue
    parseConflicts(text).forEach((b, n) => hunks.push({ id: `${file}#${n + 1}`, file, line: String(b.line), mine: b.mine, theirs: b.theirs }))
  }
  return hunks
}

async function mergeInProgress(sh: Shell): Promise<boolean> {
  return (await gitOk(sh, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== null
}

// -------------------------------------------------------------- actions

export async function filesStatus(sh: Shell): Promise<FilesReport> {
  const root = await repoRoot(sh)
  if (!root) return { state: 'no-repo' }
  const gitBranch = await branchName(sh)
  const checks: { ok: boolean; text: string }[] = []
  const hunks = await conflictHunks(sh)
  if (hunks.length) return { state: 'conflict', gitBranch, hunks }
  const fetched = await gitOk(sh, ['fetch', '--quiet'], 30_000)
  if (fetched === null) checks.push({ ok: false, text: 'Could not fetch from the remote; showing what was last fetched.' })
  const upstream = await gitOk(sh, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const dirty = await isDirty(sh)
  checks.push({ ok: !dirty, text: dirty ? 'You have uncommitted changes.' : 'No uncommitted changes.' })
  if (!upstream) {
    checks.push({ ok: false, text: `${gitBranch ?? 'This branch'} has no upstream branch to compare with.` })
    return { state: 'clean', gitBranch, checks }
  }
  const log = (await gitOk(sh, ['log', `--format=%H${SEP}%s${SEP}%an`, '--max-count=50', 'HEAD..@{u}'])) ?? ''
  const commits = commitsOf(log)
  return {
    state: commits.length ? 'incoming' : 'clean',
    gitBranch,
    incoming: commits.length ? { from: upstream, commits } : undefined,
    checks,
  }
}

export async function filesPull(sh: Shell): Promise<FilesReport> {
  const root = await repoRoot(sh)
  if (!root) return { state: 'no-repo' }
  const gitBranch = await branchName(sh)
  if (await isDirty(sh)) return { state: 'error', gitBranch, error: 'You have uncommitted changes. Commit or stash them first; nothing was pulled.' }
  const ff = await git(sh, ['pull', '--ff-only', '--no-rebase'], 60_000).catch((e: Error) => ({ code: 1, out: '', err: e.message }))
  if (ff.code === 0) return { state: 'pulled', gitBranch, checks: [{ ok: true, text: ff.out.trim().split('\n').pop() || 'Up to date.' }] }
  const merge = await git(sh, ['pull', '--no-rebase', '--no-edit'], 60_000).catch((e: Error) => ({ code: 1, out: '', err: e.message }))
  if (merge.code === 0) return { state: 'pulled', gitBranch, checks: [{ ok: true, text: 'Merged the incoming commits.' }] }
  const hunks = await conflictHunks(sh)
  if (hunks.length) return { state: 'conflict', gitBranch, hunks }
  if (await mergeInProgress(sh)) await gitOk(sh, ['merge', '--abort'])
  return { state: 'error', gitBranch, error: (merge.err || ff.err).trim().slice(0, 600) || 'git pull failed.' }
}

/** Applies picks per hunk. Hunks picked `claude` are returned for a combine turn. */
export async function filesResolve(sh: Shell, picks: Record<string, 'mine' | 'theirs' | 'claude'>): Promise<{ report: FilesReport; forClaude: Hunk[] }> {
  const root = await repoRoot(sh)
  if (!root) return { report: { state: 'no-repo' }, forClaude: [] }
  const gitBranch = await branchName(sh)
  for (const file of await conflictedFiles(sh)) {
    const text = await readRepoFile(sh, root, file)
    if (text === null) continue
    const { text: next, left } = applyPicks(text, file, picks)
    if (next !== text) await sh.write(`${root}/${file}`, next)
    if (left === 0) await gitOk(sh, ['add', '--', file])
  }
  return finishResolve(sh, gitBranch, picks)
}

/** After picks or a combine turn: commit the merge once nothing is left, else say what is. */
export async function finishResolve(sh: Shell, gitBranch?: string, picks: Record<string, string> = {}): Promise<{ report: FilesReport; forClaude: Hunk[] }> {
  const hunks = await conflictHunks(sh)
  if (hunks.length) {
    return { report: { state: 'resolving', gitBranch, hunks }, forClaude: hunks.filter((h) => picks[h.id] === 'claude') }
  }
  const unmerged = await conflictedFiles(sh)
  if (unmerged.length) return { report: { state: 'resolving', gitBranch, checks: unmerged.map((f) => ({ ok: false, text: `${f} still needs \`git add\`.` })) }, forClaude: [] }
  if (await mergeInProgress(sh)) {
    const c = await git(sh, ['commit', '--no-edit'], 30_000).catch((e: Error) => ({ code: 1, out: '', err: e.message }))
    if (c.code !== 0) return { report: { state: 'error', gitBranch, error: c.err.trim().slice(0, 600) || 'git commit failed.' }, forClaude: [] }
  }
  return { report: { state: 'resolved', gitBranch, checks: [{ ok: true, text: 'All conflicts resolved.' }] }, forClaude: [] }
}

export function combinePrompt(hunks: Hunk[]): string {
  // File names can come from other people's commits: quoted, as names and nothing more.
  const files = [...new Set(hunks.map((h) => h.file))].map((f) => JSON.stringify(f.slice(0, 300)))
  return [
    `Some files have git merge conflicts that need combining (their paths, quoted): ${files.join(', ')}.`,
    'For each conflict block (between <<<<<<< and >>>>>>>), write one version that keeps the intent of both sides, remove the markers, and then run `git add` on the file.',
    'Do not commit, push, reset or discard anything; only edit the conflicted blocks.',
  ].join('\n')
}

// ------------------------------------------------- what a turn changed

/** The folder as a shared turn starts: what was already changed stays its person's. */
export type WorkStart = { root: string; head: string | null; upstream: string | null; email: string; dirty: Map<string, string> }

/** What a turn left: files it changed and left uncommitted, the commits it made, where they're pushed. */
export type WorkEnd = { uncommitted: string[]; commits: { sha: string; subject: string }[]; pushed?: string }

/** `git status` as path → status letters (porcelain v1, -z: "XY path", a rename's old path next). */
async function statusMap(sh: Shell, root: string, paths?: string[]): Promise<Map<string, string>> {
  const r = await git(sh, ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', ...(paths?.length ? ['--', ...paths] : [])])
  const out = new Map<string, string>()
  if (r.code !== 0) return out
  const items = r.out.split('\0')
  for (let i = 0; i < items.length; i++) {
    const e = items[i]
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    out.set(e.slice(3), xy)
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  return out
}

/** Each changed path's content as git hashes it (a deleted one: its status), to tell later edits apart. */
async function signatures(sh: Shell, root: string, st: Map<string, string>, only?: Set<string>): Promise<Map<string, string>> {
  const sig = new Map<string, string>()
  const toHash: string[] = []
  for (const [p, xy] of st) {
    if (only && !only.has(p)) continue
    if (xy.includes('D')) sig.set(p, `D${xy}`)
    else toHash.push(p)
  }
  for (let i = 0; i < Math.min(toHash.length, 600); i += 100) {
    const chunk = toHash.slice(i, i + 100)
    const r = await git(sh, ['-C', root, 'hash-object', '--', ...chunk]).catch(() => null)
    const hashes = r && r.code === 0 ? r.out.trim().split('\n') : []
    chunk.forEach((p, k) => sig.set(p, hashes.length === chunk.length ? hashes[k] : `?${st.get(p)}`))
  }
  for (const p of toHash.slice(600)) sig.set(p, `?${st.get(p)}`)
  return sig
}

/** Before a shared turn: null outside a git repository. */
export async function workStart(sh: Shell): Promise<WorkStart | null> {
  const root = await repoRoot(sh)
  if (!root) return null
  const st = await statusMap(sh, root)
  return {
    root,
    head: await head(sh),
    upstream: await gitOk(sh, ['rev-parse', '@{u}']),
    email: (await gitOk(sh, ['config', 'user.email'])) ?? '',
    dirty: await signatures(sh, root, st),
  }
}

/** Where a commit is on the remote: the branch name without its remote ("main"), else undefined. */
async function pushedTo(sh: Shell, root: string, sha: string): Promise<string | undefined> {
  const r = await gitOk(sh, ['-C', root, 'branch', '-r', '--contains', sha, '--format=%(refname:short)'])
  const refs = (r ?? '').split('\n').map((x) => x.trim()).filter((x) => x && !x.endsWith('/HEAD'))
  const upstream = await gitOk(sh, ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const ref = refs.find((x) => x === upstream) ?? refs[0]
  return ref ? ref.replace(/^[^/]+\//, '') : undefined
}

const shared = (p: string) => !p.startsWith('.multiplayer/')

/** After a shared turn: what it changed, against what was there when it started. */
export async function workEnd(sh: Shell, start: WorkStart): Promise<WorkEnd> {
  const root = start.root
  const st = await statusMap(sh, root)
  const again = await signatures(sh, root, st, new Set([...st.keys()].filter((p) => start.dirty.has(p))))
  const uncommitted = [...st.keys()].filter((p) => shared(p) && (!start.dirty.has(p) || again.get(p) !== start.dirty.get(p))).sort()
  let commits: WorkEnd['commits'] = []
  const now = await head(sh)
  if (now && now !== start.head) {
    // Only the turn's own commits: not ones pulled in during it (on the remote before, or someone else's).
    const log = (await gitOk(sh, ['-C', root, 'log', `--format=%H${SEP}%s${SEP}%ae`, '--max-count=50', 'HEAD', ...(start.head ? [`^${start.head}`] : []), ...(start.upstream ? [`^${start.upstream}`] : [])])) ?? ''
    commits = log.split('\n').filter(Boolean).map((l) => l.split(SEP))
      .filter(([, , ae]) => !start.email || !ae || ae.toLowerCase() === start.email.toLowerCase())
      .map(([sha = '', subject = '']) => ({ sha: sha.slice(0, 12), subject }))
  }
  const pushed = commits.length ? await pushedTo(sh, root, commits[0].sha) : undefined
  return { uncommitted, commits, ...(pushed ? { pushed } : {}) }
}

/**
 * Later: a turn's uncommitted files since committed (their commits join the turn's) or put
 * back, and whether its commits have been pushed. Null outside a repository.
 */
export async function workRecheck(sh: Shell, w: { files: string[]; commits: { sha: string; subject: string }[]; pushed?: string; at: number }): Promise<WorkEnd | null> {
  const root = await repoRoot(sh)
  if (!root) return null
  let files = w.files
  let commits = w.commits
  if (files.length) {
    const st = await statusMap(sh, root, files)
    const gone = files.filter((p) => !st.has(p))
    files = files.filter((p) => st.has(p))
    if (gone.length) {
      const email = ((await gitOk(sh, ['config', 'user.email'])) ?? '').toLowerCase()
      const log = (await gitOk(sh, ['-C', root, 'log', `--format=%H${SEP}%s${SEP}%ae`, '--max-count=20', `--since=${new Date(w.at - 60_000).toISOString()}`, 'HEAD', '--', ...gone])) ?? ''
      const later = log.split('\n').filter(Boolean).map((l) => l.split(SEP))
        .filter(([, , ae]) => !email || !ae || ae.toLowerCase() === email)
        .map(([sha = '', subject = '']) => ({ sha: sha.slice(0, 12), subject }))
        .filter((c) => !commits.some((x) => x.sha === c.sha))
      commits = [...later, ...commits]
    }
  }
  const pushed = commits.length ? (await pushedTo(sh, root, commits[0].sha)) : undefined
  return { uncommitted: files, commits, ...(pushed ? { pushed } : {}) }
}

/** Which of these commits this folder's checkout has (12-character shas), among commits since `since`. */
export async function commitsHere(sh: Shell, shas: string[], since: number): Promise<string[]> {
  if (!shas.length) return []
  const root = await repoRoot(sh)
  if (!root) return []
  const out = (await gitOk(sh, ['-C', root, 'rev-list', `--since=${new Date(since - 7 * 86_400_000).toISOString()}`, '--max-count=20000', 'HEAD'], 30_000)) ?? ''
  const have = new Set(out.split('\n').map((x) => x.trim().slice(0, 12)).filter(Boolean))
  return shas.filter((s) => have.has(s.slice(0, 12)))
}

/** After a shared turn: the commits it made, when they are all on the upstream branch. */
export async function pushedSince(sh: Shell, startHead: string | null): Promise<{ branch: string; commits: { sha: string; subject: string }[] } | null> {
  if (!startHead) return null
  const now = await head(sh)
  if (!now || now === startHead) return null
  const upstream = await gitOk(sh, ['rev-parse', '@{u}'])
  if (!upstream) return null
  const ahead = await gitOk(sh, ['rev-list', '--count', '@{u}..HEAD'])
  if (ahead === null || Number(ahead) > 0) return null
  const log = (await gitOk(sh, ['log', `--format=%H${SEP}%s`, '--max-count=50', `${startHead}..HEAD`])) ?? ''
  const commits = commitsOf(log).map(({ sha, subject }) => ({ sha, subject }))
  if (!commits.length) return null
  return { branch: (await branchName(sh)) ?? 'HEAD', commits }
}
