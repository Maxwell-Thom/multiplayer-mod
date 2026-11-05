// Moving a conversation's work from one person's Claude Code to another's, machine to machine.
//
// Classic git only, through the person's own git and curl (the engine writes only text): the
// work travels as one git bundle. Its last commit, the snapshot, holds the changes that weren't
// committed, on top of the commits that weren't pushed, and its message says what the other
// side needs to know. Packing never touches the real index; unpacking checks everything before
// it writes, keeps the changes uncommitted as they were, and never overwrites, pushes or throws
// anything away. Without git, the files travel the same way, in a bundle of their own.
import { privateSource } from './lib/privacy.ts'
import type { Port } from './port.ts'

/** What moving needs of the engine: processes, text files, folder listings, and where a path really lands. */
export type MoveShell = Pick<Port, 'run' | 'read' | 'write' | 'list'> & { realPath?: Port['realPath'] }

/** Bigger than this, the work should go through the remote (commit and push) instead. */
export const MOVE_MAX_BYTES = 200 * 1024 * 1024
/** The relay's part size. */
export const MOVE_PART_BYTES = 8 * 1024 * 1024

/** What the snapshot's message tells the Claude Code it goes to. */
export interface MoveManifest {
  v: 1
  /** The project's fingerprint (git.ts repoPrint), or null without one. */
  repo: string | null
  branch: string | null
  /** The commit the snapshot sits on; null without git. */
  head: string | null
  /** What the other side can fetch from the remote (the upstream); null: the whole history came. */
  base: string | null
  /** Who it comes from (names a file written beside one that was different). */
  from: string
  /** Paths that stayed behind: private, ignored, or kept by git LFS. */
  left: string[]
}

/** `sent`: without git, each file's blob id as it left, so a move back can update what wasn't touched since. */
export type Packed = { bytes: number; sha256: string; summary: string; left: string[]; sent?: Record<string, string> }
type Done = { summary: string; conflict?: boolean }
type Failed = { error: string }

const SUBJECT = 'Multiplayer snapshot'
// The snapshot is an object the mod makes, never on anyone's branch: it carries its own name.
const SNAP_ID = { GIT_AUTHOR_NAME: 'Multiplayer', GIT_AUTHOR_EMAIL: 'multiplayer@localhost', GIT_COMMITTER_NAME: 'Multiplayer', GIT_COMMITTER_EMAIL: 'multiplayer@localhost' }
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const WINDOWS_BAD = /[<>:"|?*\\]|[. ]$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i
/**
 * Files that make this computer run something without anyone choosing to: Claude Code's own
 * settings and hooks, MCP servers, editor and IDE tasks, git hooks and attributes, hooks run on
 * commit (pre-commit, lefthook, husky, lint-staged), direnv. A move never brings them in by
 * itself; they come the usual way (committed and pushed), where people see them. package.json
 * counts when its scripts or hook settings change (packageRunsCode).
 */
const RUNS_CODE = /(^|\/)(\.claude|\.vscode|\.idea|\.husky|\.githooks|\.devcontainer|\.multiplayer)(\/|$)|(^|\/)(\.mcp\.json|\.envrc|\.gitmodules|\.gitattributes|\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pre-commit-config\.ya?ml|\.?lefthook(-local)?\.ya?ml|\.huskyrc(\.\w+)?|\.lintstagedrc(\.\w+)?|lint-staged\.config\.\w+|\.simple-git-hooks(\.\w+)?)$/i
/** package.json settings that run something on install or commit. */
const PACKAGE_RUNS = ['scripts', 'husky', 'simple-git-hooks', 'lint-staged', 'pre-commit', 'gitHooks', 'ghooks', 'config']
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = new RegExp('[\u0000-\u001f\u007f\u2028\u2029]', 'g')

export function manifestMessage(m: MoveManifest): string {
  return `${SUBJECT}\n\n${JSON.stringify(m)}\n`
}

function readManifest(message: string): MoveManifest | null {
  const i = message.indexOf('\n\n')
  if (i < 0 || !message.startsWith(SUBJECT)) return null
  try {
    const m = JSON.parse(message.slice(i + 2)) as MoveManifest
    if (!m || m.v !== 1 || typeof m.from !== 'string' || !Array.isArray(m.left)) return null
    // What the sender wrote goes into a line everyone reads: plain text only, and short.
    const plain = (t: string, n: number) => t.replace(CONTROL_ALL, ' ').replace(/·/g, '-').replace(/\s+/g, ' ').trim().slice(0, n)
    return { ...m, from: plain(m.from, 40) || 'them', left: m.left.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => plain(x, 120)) }
  } catch {
    return null
  }
}

type Out = { code: number; out: string; err: string }

/**
 * check-ignore and check-attr refuse literal pathspecs. They only answer about the names given
 * (already checked to be plain), so they run without it.
 */
const NO_MAGIC_ASKED = { GIT_LITERAL_PATHSPECS: '0' }

async function git(sh: MoveShell, args: string[], o: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {}): Promise<Out> {
  try {
    // Paths are names, never patterns (":(glob)**" is a file called that, not every file).
    const r = await sh.run(['git', ...args], { cwd: o.cwd, env: { GIT_LITERAL_PATHSPECS: '1', ...o.env }, stdin: o.stdin, timeoutMs: o.timeoutMs ?? 60_000 })
    return { code: r.exitCode, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { code: 1, out: '', err: (err as Error).message }
  }
}

async function gitText(sh: MoveShell, args: string[], cwd: string, env?: Record<string, string>): Promise<string | null> {
  const r = await git(sh, args, { cwd, env })
  return r.code === 0 ? r.out.trim() : null
}

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const parentOf = (p: string) => slash(p).replace(/\/[^/]*$/, '')
const baseOf = (p: string) => slash(p).split('/').pop() ?? p
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "1 commit and 2 changed files". */
export function workText(commits: number, files: number): string {
  return [commits ? plural(commits, 'commit') : '', files ? plural(files, 'changed file') : ''].filter(Boolean).join(' and ') || 'nothing new'
}

/** "a, b and c". */
function listText(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const clip200 = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)

/** A file URL curl reads (curl copies and cuts files: the engine writes only text). */
export function fileUrl(path: string): string {
  const p = slash(path)
  const enc = encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
  return /^[A-Za-z]:/.test(p) ? `file:///${enc}` : `file://${enc}`
}

/** A path inside the folder, written plainly: not absolute, never climbing out, nothing odd in it. */
function plainPath(p: string): boolean {
  if (!p || CONTROL.test(p) || p.includes('\\') || p.startsWith('/')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** Nothing that lands in .git (in any case, or as Windows spells it with trailing dots). */
function intoGit(p: string): boolean {
  return p.split('/').some((seg) => diskName(seg) === '.git' || /^git~\d+$/i.test(seg))
}

/**
 * A name as a disk may read it: macOS drops invisible marks, Windows drops trailing dots and
 * spaces, and neither minds case. So ".cl‌aude" and ".claude " are both .claude there.
 */
function diskName(seg: string): string {
  // NFKC folds look-alikes (a full-width dot), and upper- then lower-casing folds letters a disk
  // upper-cases into plain ones (ſ is S to Windows).
  return seg.normalize('NFKC').replace(/[​-‏‪-‮⁠-⁯﻿]/g, '').replace(/[. ]+$/, '').toUpperCase().toLowerCase()
}

/** Could run commands here: by its name as a disk reads it, or behind a Windows short name (CLAUDE~1, MCP~1.JSO). */
function runsCode(path: string): boolean {
  const segs = path.split('/')
  return segs.some((s) => /~\d+(\.[^.]*)?$/.test(s)) || RUNS_CODE.test(segs.map(diskName).join('/'))
}

function windowsBad(p: string): boolean {
  return p.split('/').some((seg) => WINDOWS_BAD.test(seg) || WINDOWS_RESERVED.test(seg))
}

async function exists(sh: MoveShell, path: string): Promise<boolean> {
  const p = slash(path)
  const list = await sh.list(parentOf(p)).catch(() => undefined)
  return !!list?.some((e) => e.name === baseOf(p))
}

async function sizeOf(sh: MoveShell, path: string): Promise<number | null> {
  const p = slash(path)
  const list = await sh.list(parentOf(p)).catch(() => undefined)
  const e = list?.find((x) => x.name === baseOf(p))
  return e ? e.size : null
}

/** NUL-separated output, empty pieces dropped. */
const zsplit = (s: string) => s.split('\0').filter(Boolean)

/** The folder's whole status, path → its two-letter code; null when git can't say. */
async function statusOf(sh: MoveShell, root: string): Promise<Map<string, string> | null> {
  const r = await git(sh, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], { cwd: root, timeoutMs: 120_000 })
  if (r.code !== 0) return null
  return new Map(zsplit(r.out).map((l) => [l.slice(3), l.slice(0, 2)]))
}

/** The changed paths among `paths` (a path names itself, or every file in a folder of that name). */
function among(status: Map<string, string>, paths: string[]): string[] {
  const exact = new Set(paths)
  const folders = paths.map((p) => `${p.replace(/\/+$/, '')}/`)
  return [...status.keys()].filter((f) => exact.has(f) || folders.some((d) => f.startsWith(d)))
}

/** Which of `paths` (under `base`) are files there now: one listing per folder, however many names. */
async function filesThere(sh: MoveShell, base: string, paths: string[]): Promise<string[]> {
  const lists = new Map<string, { name: string; kind: string }[] | null>()
  const out: string[] = []
  for (const p of paths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (!lists.has(dir)) lists.set(dir, (await sh.list(dir ? `${base}/${dir}` : base).catch(() => null)) ?? null)
    if (lists.get(dir)?.some((e) => e.name === baseOf(p) && e.kind === 'file')) out.push(p)
  }
  return out
}

/** A package.json whose scripts or hook settings differ between `before` (a commit, or none) and this entry. */
async function packageRunsCode(sh: MoveShell, cwd: string, gitDir: string[], before: string | null, e: Entry): Promise<boolean> {
  // (As a disk reads the name: PACKAGE.JSON is package.json on most of them.)
  if (diskName(baseOf(e.path)) !== 'package.json' || e.status === 'D') return false
  const read = async (sha: string | null) => (sha ? (await git(sh, [...gitDir, 'cat-file', 'blob', sha], { cwd })).out : '{}')
  const was = before ? await gitText(sh, [...gitDir, 'rev-parse', '-q', '--verify', `${before}:${e.path}`], cwd) : null
  const pick = (text: string) => {
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      return JSON.stringify(PACKAGE_RUNS.map((k) => j?.[k] ?? null))
    } catch {
      return 'unreadable'
    }
  }
  return pick(await read(was)) !== pick(await read(e.sha))
}

/** The changes a snapshot carries (`git diff-tree` against its parent, or its whole tree when it has none). */
type Entry = { path: string; mode: string; sha: string; status: string }

async function entriesOf(sh: MoveShell, cwd: string, ref: string, gitDir: string[], root: boolean): Promise<Entry[] | null> {
  return root ? diffEntries(sh, cwd, gitDir, `${ref}^`, ref) : treeEntries(sh, cwd, gitDir, ref)
}

/** The files that differ from `a` to `b` (both commits), as `b` has them. */
async function diffEntries(sh: MoveShell, cwd: string, gitDir: string[], a: string, b: string): Promise<Entry[] | null> {
  const r = await git(sh, [...gitDir, 'diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', a, b], { cwd })
  if (r.code !== 0) return null
  const parts = r.out.split('\0')
  const out: Entry[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i]
    if (!head.startsWith(':')) break
    const [, mode, , sha, status] = head.slice(1).split(' ')
    out.push({ path: parts[i + 1], mode, sha, status: status ?? 'M' })
  }
  return out
}

/** Every file of a commit. */
async function treeEntries(sh: MoveShell, cwd: string, gitDir: string[], ref: string): Promise<Entry[] | null> {
  const r = await git(sh, [...gitDir, 'ls-tree', '-r', '-z', '--full-tree', ref], { cwd })
  if (r.code !== 0) return null
  return zsplit(r.out).map((line) => {
    const tab = line.indexOf('\t')
    const [mode, , sha] = line.slice(0, tab).split(' ')
    return { path: line.slice(tab + 1), mode, sha, status: 'A' }
  })
}

/** What's wrong with where the changes would land, or null. */
async function placeProblem(sh: MoveShell, cwd: string, gitDir: string[], entries: Entry[], windows: boolean): Promise<string | null> {
  const outside: string[] = []
  for (const e of entries) {
    if (!plainPath(e.path) || intoGit(e.path)) { outside.push(e.path); continue }
    if (e.mode === '120000' && e.status !== 'D') {
      // A link: only to somewhere else inside the folder.
      const target = await git(sh, [...gitDir, 'cat-file', 'blob', e.sha], { cwd })
      const joined = [...e.path.split('/').slice(0, -1), ...slash(target.out.trim()).split('/')]
      const stack: string[] = []
      let ok = target.code === 0 && !/^([A-Za-z]:|\/)/.test(target.out.trim())
      for (const seg of joined) {
        if (seg === '..') { if (!stack.pop()) ok = false } else if (seg && seg !== '.') stack.push(seg)
      }
      if (!ok || intoGit(stack.join('/'))) outside.push(e.path)
    }
  }
  if (outside.length) return `This work has files that would land outside this folder or inside .git: ${clip200(listText(outside.slice(0, 5)))}. Nothing was changed.`
  if (windows) {
    const bad = entries.filter((e) => e.status !== 'D' && windowsBad(e.path)).map((e) => e.path)
    if (bad.length) return clip200(`These files can’t exist on Windows: ${bad.slice(0, 8).join(', ')}`)
  }
  return null
}

/** A temporary folder for this transfer, kept out of git. */
async function tempFolder(sh: MoveShell, dir: string): Promise<void> {
  await sh.write(`${dir}/.gitignore`, '*\n')
}

/** The SHA-256 both sides compute of the pack (git's own, in a temporary sha256 repository). */
export async function fileSha(sh: MoveShell, file: string): Promise<string | null> {
  const dir = parentOf(file)
  const repo = `${dir}/sha.git`
  if (!(await exists(sh, repo)) && (await git(sh, ['init', '-q', '--bare', '--object-format=sha256', repo])).code !== 0) return null
  const r = await git(sh, ['--git-dir', repo, 'hash-object', '--no-filters', '--', slash(file)], { timeoutMs: 120_000 })
  const sha = r.out.trim()
  return r.code === 0 && /^[0-9a-f]{64}$/.test(sha) ? sha : null
}

/** Part `n` of the pack, cut out with curl (it reads byte ranges of a file). */
export async function cutPart(sh: MoveShell, file: string, n: number, size: number, out: string): Promise<boolean> {
  const start = n * MOVE_PART_BYTES
  const end = Math.min(start + MOVE_PART_BYTES, size) - 1
  if (end < start) return sh.write(out, '').then(() => true, () => false)
  try {
    const r = await sh.run(['curl', '-sS', '--range', `${start}-${end}`, '-o', slash(out), fileUrl(file)], { timeoutMs: 60_000 })
    return r.exitCode === 0
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ packing

/**
 * Packs the conversation's work into `out`: in a repository, the commits that weren't pushed and
 * a snapshot of `paths` (relative to its root); without one, the files at `paths` (relative to
 * the folder). Private, ignored and LFS files stay behind, named in `left`.
 */
export async function packWork(sh: MoveShell, o: { folder: string; paths: string[]; out: string; transferId: string; repo: string | null; from: string }): Promise<Packed | Failed> {
  const dir = parentOf(o.out)
  await tempFolder(sh, dir)
  const root = await gitText(sh, ['rev-parse', '--show-toplevel'], o.folder)
  const base = root ?? slash(o.folder)
  const left: string[] = []
  /** What may travel of `paths`: not private, not ignored, not kept by LFS; the rest is named in `left`. */
  const sift = async (paths: string[]): Promise<string[]> => {
    let keep: string[] = []
    for (const p of paths) {
      if (!plainPath(p) || intoGit(p) || privateSource('Read', { file_path: `${base}/${p}` }, o.folder)) { if (!left.includes(p)) left.push(p) } else keep.push(p)
    }
    if (root && keep.length) {
      // Ignored (as git would leave it out) or kept by LFS (the remote has it, not this pack).
      const ignored = new Set(zsplit((await git(sh, ['check-ignore', '-z', '--stdin'], { cwd: root, env: NO_MAGIC_ASKED, stdin: keep.join('\0') + '\0' })).out))
      const attr = zsplit((await git(sh, ['check-attr', '-z', '--stdin', 'filter'], { cwd: root, env: NO_MAGIC_ASKED, stdin: keep.join('\0') + '\0' })).out)
      const lfs = new Set<string>()
      for (let i = 0; i + 2 < attr.length; i += 3) if (attr[i + 2] === 'lfs') lfs.add(attr[i])
      for (const p of keep) if ((ignored.has(p) || lfs.has(p)) && !left.includes(p)) left.push(p)
      keep = keep.filter((p) => !ignored.has(p) && !lfs.has(p))
    }
    return keep
  }
  const keep = await sift([...new Set(o.paths)])
  const ref = `refs/multiplayer/out/${o.transferId}`
  let commits = 0
  let files = 0
  let manifest: MoveManifest
  let sent: Record<string, string> | undefined
  if (root) {
    const branch = await gitText(sh, ['rev-parse', '--abbrev-ref', 'HEAD'], root)
    const head = await gitText(sh, ['rev-parse', '--verify', '-q', 'HEAD'], root)
    if (!branch || branch === 'HEAD' || !head) return { error: 'Your folder isn’t on a branch with commits, so there’s nothing to build the move on.' }
    // What changed of these paths, against HEAD (status lists none it didn't change). A folder's
    // path lists the files in it, so those are sifted again before anything is added.
    // (The whole status, filtered here: a command line can't hold thousands of names.)
    const status = await statusOf(sh, root)
    if (!status) return { error: 'Couldn’t read what changed in this folder.' }
    const changed = keep.length ? await sift(among(status, keep)) : []
    // The snapshot: HEAD plus these paths as they are now, in an index of its own.
    const env = { GIT_INDEX_FILE: `${dir}/index` }
    if ((await git(sh, ['read-tree', 'HEAD'], { cwd: root, env })).code !== 0) return { error: 'Couldn’t read this folder’s commit to pack the work.' }
    if (changed.length) {
      const add = await git(sh, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, env, stdin: changed.join('\0'), timeoutMs: 120_000 })
      if (add.code !== 0) return { error: `Couldn’t pack the changed files: ${add.err.trim().split('\n')[0]}` }
    }
    const tree = await gitText(sh, ['write-tree'], root, env)
    if (!tree) return { error: 'Couldn’t pack the changed files.' }
    const upstream = await gitText(sh, ['merge-base', 'HEAD', '@{upstream}'], root)
    commits = Number(await gitText(sh, ['rev-list', '--count', upstream ? `${upstream}..HEAD` : 'HEAD'], root)) || 0
    files = changed.length
    manifest = { v: 1, repo: o.repo, branch, head, base: upstream, from: o.from, left }
    const snap = await git(sh, ['commit-tree', tree, '-p', head, '-F', '-'], { cwd: root, env: SNAP_ID, stdin: manifestMessage(manifest) })
    if (snap.code !== 0 || (await git(sh, ['update-ref', ref, snap.out.trim()], { cwd: root })).code !== 0) return { error: 'Couldn’t pack the work.' }
    const bundle = await git(sh, ['bundle', 'create', '-q', slash(o.out), ref, ...(upstream ? [`^${upstream}`] : [])], { cwd: root, timeoutMs: 300_000 })
    if (bundle.code !== 0) return { error: `Couldn’t pack the work: ${bundle.err.trim().split('\n')[0]}` }
  } else {
    // Without git: the files themselves, in a repository of the transfer's own.
    const tmp = `${dir}/out`
    if ((await git(sh, ['init', '-q', tmp])).code !== 0) return { error: 'Couldn’t pack the files.' }
    const gd = ['--git-dir', `${tmp}/.git`, '--work-tree', slash(o.folder)]
    // The files of these paths that are there (each a file, not a folder), told to git on stdin.
    const there = await sift(await filesThere(sh, slash(o.folder), keep))
    if (there.length && (await git(sh, [...gd, 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: o.folder, stdin: there.join('\0'), timeoutMs: 120_000 })).code !== 0) return { error: 'Couldn’t pack the files.' }
    const tree = await gitText(sh, [...gd, 'write-tree'], o.folder)
    files = there.length
    // Each file's blob id as it leaves: a move back updates the ones nobody touched since.
    sent = Object.fromEntries((tree ? (await treeEntries(sh, o.folder, gd, tree)) ?? [] : []).map((e) => [e.path, e.sha]))
    manifest = { v: 1, repo: null, branch: null, head: null, base: null, from: o.from, left }
    const snap = tree ? await git(sh, [...gd, 'commit-tree', tree, '-F', '-'], { cwd: o.folder, env: SNAP_ID, stdin: manifestMessage(manifest) }) : undefined
    if (!snap || snap.code !== 0 || (await git(sh, [...gd, 'update-ref', ref, snap.out.trim()], { cwd: o.folder })).code !== 0) return { error: 'Couldn’t pack the files.' }
    const bundle = await git(sh, [...gd, 'bundle', 'create', '-q', slash(o.out), ref], { cwd: o.folder, timeoutMs: 300_000 })
    if (bundle.code !== 0) return { error: 'Couldn’t pack the files.' }
  }
  const bytes = await sizeOf(sh, o.out)
  if (bytes === null) return { error: 'Couldn’t pack the work.' }
  if (bytes > MOVE_MAX_BYTES) return { error: 'The work is over 200 MB, too big to send this way. Commit and push it, then move it.' }
  const sha256 = await fileSha(sh, o.out)
  if (!sha256) return { error: 'Moving work needs git 2.29 or newer here.' }
  return { bytes, sha256, summary: workText(commits, files), left, ...(sent ? { sent } : {}) }
}

// ---------------------------------------------------------------- unpacking

/**
 * Brings the work in `file` into this folder. Everything is checked before anything is written:
 * the same project, the same branch, no changes of this person's own to those files, and every
 * file landing inside the folder under a name this computer can hold. The changes stay
 * uncommitted, as they were; a commit made here meanwhile is kept (three-way, never overwritten).
 */
export async function unpackWork(sh: MoveShell, o: { folder: string; file: string; expectRepo: string | null; transferId: string; windows: boolean; sent?: Record<string, string>; onArrived?: (paths: string[]) => void }): Promise<Done | Failed> {
  const dir = parentOf(o.file)
  const root = await gitText(sh, ['rev-parse', '--show-toplevel'], o.folder)
  const snap = `refs/multiplayer/snap/${o.transferId}`
  const from = `refs/multiplayer/out/${o.transferId}`
  const notThisProject = { error: 'This folder isn’t a copy of the project this work comes from.' }
  const fetchArgs = ['-c', 'fetch.fsckObjects=true']
  if (!root) return unpackPlain(sh, { ...o, dir, snap, from, notThisProject })

  // The commits it builds on are on the remote: fetch them first (offline, it may have them already).
  await git(sh, ['fetch', '-q', 'origin'], { cwd: root, timeoutMs: 120_000 })
  const got = await git(sh, [...fetchArgs, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', slash(o.file), `${from}:${snap}`], { cwd: root, timeoutMs: 300_000 })
  const forget = async () => { await git(sh, ['update-ref', '-d', snap], { cwd: root }) }
  if (got.code !== 0) {
    await forget()
    if (/prerequisite/i.test(got.err)) return { error: 'This folder doesn’t have the commits this work builds on. Pull, then try again.' }
    return { error: `The work that arrived couldn’t be read: ${got.err.trim().split('\n').pop()?.slice(0, 150) || 'git refused it'}.` }
  }
  const fail = async (error: string): Promise<Failed> => { await forget(); return { error } }
  const m = readManifest((await gitText(sh, ['log', '-1', '--format=%B', snap], root)) ?? '')
  if (!m || !m.head) return fail('The work that arrived couldn’t be read.')
  if ((m.repo ?? null) !== (o.expectRepo ?? null)) return fail(notThisProject.error)
  const branch = await gitText(sh, ['rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (m.branch && branch !== m.branch) return fail(`Your folder is on ${branch ?? 'no branch'}, and this conversation’s work is on ${m.branch}. Switch to ${m.branch}, then try again.`)
  const all = await entriesOf(sh, root, snap, [], true)
  const head = await gitText(sh, ['rev-parse', `${snap}^`], root)
  const cur = await gitText(sh, ['rev-parse', 'HEAD'], root)
  // What its commits bring is checked like the changes: nothing outside the folder or in .git.
  const since = cur && head ? await gitText(sh, ['merge-base', cur, head], root) : null
  const brought = head ? (since ? await diffEntries(sh, root, [], since, head) : await treeEntries(sh, root, [], head)) : null
  if (!all || !head || !brought) return fail('The work that arrived couldn’t be read.')
  const place = await placeProblem(sh, root, [], [...all, ...brought], o.windows)
  if (place) return fail(place)
  // Commits land without anyone looking at them: none may change what runs commands here, or
  // replace a file this folder keeps for its person (git overwrites ignored files without asking).
  const runs: string[] = []
  for (const e of brought) if (runsCode(e.path) || (await packageRunsCode(sh, root, [], since, e))) runs.push(e.path)
  if (runs.length) return fail(`Its commits change ${listText(runs.slice(0, 3))}, which can run commands in your Claude Code, so they don’t come in this way. Ask ${m.from} to push them, then pull them from the Files panel.`)
  const replaced = (await keptHere(sh, root, o.folder, brought.filter((e) => e.status !== 'D').map((e) => e.path))).names
  if (replaced.length) return fail(`Its commits would replace ${listText(replaced.slice(0, 3))}, which this folder keeps for you (private or ignored). Ask ${m.from} to push them, then pull them yourself.`)
  // Left out of the changes: what could run commands here, and what holds secrets or this folder ignores.
  const held = await heldBack(sh, root, o.folder, all, { cwd: root, gitDir: [], before: `${snap}^` })
  const heldSet = new Set([...held.code, ...held.secret])
  const entries = all.filter((e) => !heldSet.has(e.path))
  if (heldSet.size && !(await onlyEntries(sh, root, dir, snap, entries))) return fail('The work that arrived couldn’t be read.')
  const mine = await ownChanges(sh, root, entries.map((e) => e.path))
  if (mine) return fail(mine)
  const notes = [
    ...heldNotes(held),
    ...(m.left.length ? [`${listText(m.left.slice(0, 4))}${m.left.length > 4 ? ` and ${m.left.length - 4} more` : ''} stayed on ${m.from}’s computer`] : []),
  ]

  // The commits: fast-forward, or merge with what's here (conflicts wait in the Files panel).
  const commits = cur ? Number(await gitText(sh, ['rev-list', '--count', `${cur}..${head}`], root)) || 0 : 0
  const files = entries.length
  const came = workText(commits, files)
  if (cur !== head && commits > 0) {
    const ff = (await git(sh, ['merge-base', '--is-ancestor', cur ?? head, head], { cwd: root })).code === 0
    const r = ff
      ? await git(sh, ['merge', '--ff-only', '-q', head], { cwd: root, timeoutMs: 120_000 })
      : await git(sh, ['merge', '--no-edit', '-q', head], { cwd: root, timeoutMs: 120_000 })
    if (r.code !== 0) {
      if (await unmerged(sh, root)) {
        const them = commits === 1 ? 'the commit conflicts' : `the ${commits} commits conflict`
        const after = files ? `, and ${files === 1 ? 'the changed file comes' : `the ${files} changed files come`} in after` : ''
        return { summary: clip200(`${came} came along · ${them} with what was here: resolve ${commits === 1 ? 'it' : 'them'} in the Files panel${after}`), conflict: true }
      }
      if ((await git(sh, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root })).code === 0) await git(sh, ['merge', '--abort'], { cwd: root })
      return fail(`The commits couldn’t be brought into your folder: ${r.err.trim().split('\n')[0]?.slice(0, 150) || 'git refused'}.`)
    }
  }
  const applied = await applyEntries(sh, root, snap, entries)
  if ('error' in applied) return applied
  o.onArrived?.(entries.filter((e) => e.status !== 'D').map((e) => e.path))
  return { summary: clip200([`${came} came along`, ...(applied.conflict ? [applied.conflict] : []), ...notes].join(' · ')), ...(applied.conflict ? { conflict: true } : {}) }
}

/** Of the incoming changes, what stays out: files that could run commands, and private or ignored ones. */
async function heldBack(sh: MoveShell, root: string | null, folder: string, entries: Entry[], pkg: { cwd: string; gitDir: string[]; before: string | null }): Promise<{ code: string[]; secret: string[] }> {
  const base = root ?? slash(folder)
  const code: string[] = []
  for (const e of entries) if (runsCode(e.path) || (await packageRunsCode(sh, pkg.cwd, pkg.gitDir, pkg.before, e))) code.push(e.path)
  const rest = entries.filter((e) => !code.includes(e.path) && e.status !== 'D').map((e) => e.path)
  const secret = rest.filter((p) => privateSource('Read', { file_path: `${base}/${p}` }, folder))
  // Git overwrites ignored files without asking (they're the person's own: a .env, a build).
  const open = rest.filter((p) => !secret.includes(p))
  if (root && open.length) {
    const ignored = new Set(zsplit((await git(sh, ['check-ignore', '-z', '--stdin'], { cwd: root, env: NO_MAGIC_ASKED, stdin: open.join('\0') + '\0' })).out))
    secret.push(...open.filter((p) => ignored.has(p)))
    // …or one of the person's own files where an incoming path, or a folder on its way, would go.
    for (const p of (await keptHere(sh, root, folder, open.filter((x) => !ignored.has(x)))).paths) if (!secret.includes(p)) secret.push(p)
  }
  return { code, secret }
}

/**
 * The person's own files (untracked, and private or ignored) that incoming `paths` would replace:
 * at the path itself, or where a folder on its way would have to go. Names are matched the way
 * this disk does (in any case, where git says it ignores case). `names` as they are here.
 */
async function keptHere(sh: MoveShell, root: string, folder: string, paths: string[]): Promise<{ paths: string[]; names: string[] }> {
  if (!paths.length) return { paths: [], names: [] }
  const anyCase = (await gitText(sh, ['config', '--get', 'core.ignorecase'], root)) === 'true'
  const same = (a: string, b: string) => (anyCase ? diskName(a) === diskName(b) : a === b)
  const lists = new Map<string, { name: string; kind: string }[] | null>()
  const look = async (dir: string) => {
    if (!lists.has(dir)) lists.set(dir, (await sh.list(dir ? `${root}/${dir}` : root).catch(() => null)) ?? null)
    return lists.get(dir) ?? null
  }
  const found = new Map<string, string[]>()
  for (const p of paths) {
    const segs = p.split('/')
    let here = ''
    for (let i = 0; i < segs.length; i++) {
      const e = (await look(here))?.find((x) => same(x.name, segs[i]))
      if (!e) break
      here = here ? `${here}/${e.name}` : e.name
      if (i === segs.length - 1 || (e.kind !== 'dir' && e.kind !== 'directory')) { found.set(here, [...(found.get(here) ?? []), p]); break }
    }
  }
  const names = [...found.keys()]
  if (!names.length) return { paths: [], names: [] }
  // Files git keeps aren't the person's own: a commit changing them is a normal change.
  const tracked = new Set(zsplit((await git(sh, ['ls-files', '-z', '--', ...names], { cwd: root })).out))
  const untracked = names.filter((n) => !tracked.has(n))
  const kept = new Set(untracked.filter((n) => privateSource('Read', { file_path: `${root}/${n}` }, folder)))
  const open = untracked.filter((n) => !kept.has(n))
  if (open.length) for (const n of zsplit((await git(sh, ['check-ignore', '-z', '--stdin'], { cwd: root, env: NO_MAGIC_ASKED, stdin: open.join('\0') + '\0' })).out)) kept.add(n)
  const ks = names.filter((n) => kept.has(n))
  return { names: ks, paths: [...new Set(ks.flatMap((n) => found.get(n) ?? []))] }
}

function heldNotes(held: { code: string[]; secret: string[] }): string[] {
  const one = (n: number, a: string, b: string) => (n === 1 ? a : b)
  return [
    ...(held.code.length ? [`left out, as ${one(held.code.length, 'it', 'they')} can run commands in your Claude Code: ${listText(held.code.slice(0, 4))}`] : []),
    ...(held.secret.length ? [`left out, as ${one(held.secret.length, 'it holds', 'they hold')} secrets or this folder ignores ${one(held.secret.length, 'it', 'them')}: ${listText(held.secret.slice(0, 4))}`] : []),
  ]
}

/**
 * The snapshot again with only `entries` of its changes, built up from the commit under it, so
 * the names left out are never even read into an index (git on Windows refuses some of them).
 */
async function onlyEntries(sh: MoveShell, root: string, dir: string, snap: string, entries: Entry[]): Promise<boolean> {
  const env = { GIT_INDEX_FILE: `${dir}/held-index` }
  if ((await git(sh, ['read-tree', `${snap}^`], { cwd: root, env })).code !== 0) return false
  if (entries.length) {
    const info = entries.map((e) => (e.status === 'D' ? `0 ${'0'.repeat(e.sha.length || 40)}\t${e.path}` : `${e.mode} ${e.sha}\t${e.path}`)).join('\0') + '\0'
    if ((await git(sh, ['update-index', '-z', '--index-info'], { cwd: root, env, stdin: info })).code !== 0) return false
  }
  const tree = await gitText(sh, ['write-tree'], root, env)
  const message = await gitText(sh, ['log', '-1', '--format=%B', snap], root)
  if (!tree || message === null) return false
  const c = await git(sh, ['commit-tree', tree, '-p', `${snap}^`, '-F', '-'], { cwd: root, env: SNAP_ID, stdin: `${message}\n` })
  return c.code === 0 && (await git(sh, ['update-ref', snap, c.out.trim()], { cwd: root })).code === 0
}

/** Changes of this person's own to these paths, said as the refusal; null when there are none. */
async function ownChanges(sh: MoveShell, root: string, paths: string[]): Promise<string | null> {
  if (!paths.length) return null
  const status = await statusOf(sh, root)
  if (!status) return 'Couldn’t read what changed in your folder. Try again.'
  const wanted = new Set(paths)
  const dirty = [...status.keys()].filter((f) => wanted.has(f))
  if (!dirty.length) return null
  // Only line endings differ (this folder's settings changed after checkout): not their changes.
  const untracked = dirty.some((f) => status.get(f) === '??')
  // (Asked file by file: a name list ignores the line-ending option. A few files at most: more is real work.)
  let onlyEndings = !untracked && dirty.length <= 50
  for (const f of onlyEndings ? dirty : []) {
    if ((await git(sh, ['diff', '--ignore-cr-at-eol', '--quiet', '--', f], { cwd: root })).code !== 0) { onlyEndings = false; break }
  }
  if (onlyEndings) {
    return `Your copies of ${dirty.length} of these files differ from your last commit only in line endings. Run git add --renormalize . to tidy them, then try again.`
  }
  return `Your folder has your own changes to ${dirty.length} of these files. Commit or stash them, then try again.`
}

async function unmerged(sh: MoveShell, root: string): Promise<boolean> {
  return !!(await gitText(sh, ['diff', '--name-only', '--diff-filter=U'], root))
}

/**
 * The snapshot's changes onto this folder, three-way, then left uncommitted as they were.
 * `conflict`: what the Files panel now has to resolve.
 */
async function applyEntries(sh: MoveShell, root: string, snap: string, entries: Entry[]): Promise<{ conflict?: string } | Failed> {
  if (entries.length) {
    const r = await git(sh, ['cherry-pick', '--no-commit', snap], { cwd: root, timeoutMs: 120_000 })
    if (r.code !== 0) {
      if (!(await unmerged(sh, root))) {
        return { error: `The changed files couldn’t be brought into your folder: ${r.err.trim().split('\n')[0]?.slice(0, 150) || 'git refused'}.` }
      }
      // Left as git leaves them, for the Files panel.
      await git(sh, ['cherry-pick', '--quit'], { cwd: root })
      await git(sh, ['update-ref', '-d', snap], { cwd: root })
      const n = ((await gitText(sh, ['diff', '--name-only', '--diff-filter=U'], root)) ?? '').split('\n').filter(Boolean).length
      return { conflict: `${plural(n, 'file')} conflict${n === 1 ? 's' : ''} with what was here: resolve ${n === 1 ? 'it' : 'them'} in the Files panel` }
    }
    // Uncommitted and unstaged, as on the computer it came from; nothing else of the index moves.
    await git(sh, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, stdin: entries.map((e) => e.path).join('\0') })
  }
  await git(sh, ['update-ref', '-d', snap], { cwd: root })
  return {}
}

/** After the Files panel resolved a merge the move brought: the changes that waited come in. */
export async function applySnapshot(sh: MoveShell, o: { folder: string; transferId: string }): Promise<Done | Failed> {
  const root = await gitText(sh, ['rev-parse', '--show-toplevel'], o.folder)
  const snap = `refs/multiplayer/snap/${o.transferId}`
  if (!root || !(await gitText(sh, ['rev-parse', '-q', '--verify', snap], root))) return { error: 'Nothing is waiting to come in.' }
  if ((await unmerged(sh, root)) || (await git(sh, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root })).code === 0) return { error: 'Resolve the conflicts in the Files panel first.' }
  const entries = await entriesOf(sh, root, snap, [], true)
  if (!entries) return { error: 'The work that waited couldn’t be read.' }
  const mine = await ownChanges(sh, root, entries.map((e) => e.path))
  if (mine) return { error: mine }
  const applied = await applyEntries(sh, root, snap, entries)
  if ('error' in applied) return applied
  return { summary: `${plural(entries.length, 'changed file')} came in${applied.conflict ? ` · ${applied.conflict}` : ''}`, ...(applied.conflict ? { conflict: true } : {}) }
}

/** Where the incoming copy of a file that's different here goes: "notes (from Riley).txt". */
export function besideName(path: string, from: string, n = 1): string {
  const who = `${from.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 40) || 'them'}${n > 1 ? ` ${n}` : ''}`
  const dirPart = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const name = path.slice(dirPart.length)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${dirPart}${name.slice(0, dot)} (from ${who})${name.slice(dot)}` : `${dirPart}${name} (from ${who})`
}

/**
 * Without git here: each file is written where it was, over the copy here only when that's the
 * one that left this computer untouched since (`sent`); otherwise beside it, under a name nothing
 * here has yet, so no one's copy is ever written over.
 */
async function unpackPlain(sh: MoveShell, o: { folder: string; file: string; expectRepo: string | null; windows: boolean; dir: string; snap: string; from: string; notThisProject: Failed; sent?: Record<string, string>; onArrived?: (paths: string[]) => void }): Promise<Done | Failed> {
  const tmp = `${o.dir}/in`
  if ((await git(sh, ['init', '-q', tmp])).code !== 0) return { error: 'Couldn’t read the work that arrived.' }
  const gd = ['--git-dir', `${tmp}/.git`]
  const got = await git(sh, ['-c', 'fetch.fsckObjects=true', ...gd, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', slash(o.file), `${o.from}:${o.snap}`], { cwd: tmp, timeoutMs: 300_000 })
  // Work that builds on commits (from a repository) can't land in a folder without one.
  if (got.code !== 0) return /prerequisite/i.test(got.err) ? o.notThisProject : { error: 'The work that arrived couldn’t be read.' }
  const m = readManifest((await gitText(sh, [...gd, 'log', '-1', '--format=%B', o.snap], tmp)) ?? '')
  if (!m) return { error: 'The work that arrived couldn’t be read.' }
  if ((m.repo ?? null) !== (o.expectRepo ?? null) || m.head) return o.notThisProject
  const entries = (await entriesOf(sh, tmp, o.snap, gd, false)) ?? []
  const place = await placeProblem(sh, tmp, gd, entries, o.windows)
  if (place) return { error: place }
  // Out into a folder of the transfer's own, then copied where each goes.
  const stage = `${o.dir}/stage`
  await tempFolder(sh, stage)
  if (entries.length && (await git(sh, [...gd, '--work-tree', stage, 'checkout', '-q', '-f', o.snap, '--', '.'], { cwd: tmp, timeoutMs: 120_000 })).code !== 0) {
    return { error: 'Couldn’t read the files that arrived.' }
  }
  const beside: [string, string][] = []
  const held = await heldBack(sh, null, o.folder, entries, { cwd: tmp, gitDir: gd, before: null })
  const heldSet = new Set([...held.code, ...held.secret])
  const coming = entries.filter((e) => !heldSet.has(e.path))
  // What now holds what came, under the names it's here by: carried on in the next move. Never a
  // file of the person's own that a copy went beside.
  const landed: string[] = []
  for (const e of coming) {
    if (e.mode === '120000' || e.mode === '160000') continue
    // A file already here, in any case (NOTES.txt is notes.txt on most disks): its name as it is.
    const here = async (p: string) => {
      const dirPart = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''
      const list = await sh.list(parentOf(`${o.folder}/${p}`)).catch(() => undefined)
      const x = list?.find((f) => diskName(f.name) === diskName(baseOf(p)))
      return x ? `${dirPart}${x.name}` : null
    }
    const idOf = async (p: string) => gitText(sh, ['hash-object', '--no-filters', '--', slash(`${o.folder}/${p}`)], tmp)
    let to = e.path
    const there = await here(e.path)
    if (there) {
      const now = await idOf(there)
      if (now === e.sha) { landed.push(there); continue }
      if (o.sent?.[e.path] && now === o.sent[e.path]) {
        // The copy that left here, untouched since: it's updated where it is.
        to = there
      } else {
        // Different here: beside it, never over a copy someone kept (the same bytes are left as they are).
        let n = 1
        let alongside = await here(besideName(e.path, m.from))
        while (alongside && (await idOf(alongside)) !== e.sha && n < 50) alongside = await here(besideName(e.path, m.from, ++n))
        to = besideName(e.path, m.from, n)
        beside.push([there, to])
        if (alongside) { if ((await idOf(alongside)) === e.sha) landed.push(alongside); continue }
      }
    }
    const r = await sh.run(['curl', '-sS', '--create-dirs', '-o', slash(`${o.folder}/${to}`), fileUrl(`${stage}/${e.path}`)], { timeoutMs: 120_000 }).catch(() => ({ exitCode: 1 }))
    if (r.exitCode !== 0) return { error: `Couldn’t write ${to} in your folder.` }
    landed.push(to)
  }
  const besideText = beside.length === 1
    ? ` · ${beside[0][0]} was different here, so ${m.from}’s is ${beside[0][1]}`
    : beside.length ? ` · ${beside.length} files were different here, so ${m.from}’s copies sit beside them, named “(from ${m.from})”` : ''
  const leftText = m.left.length ? ` · ${listText(m.left.slice(0, 4))} stayed on ${m.from}’s computer` : ''
  const heldText = heldNotes(held).map((x) => ` · ${x}`).join('')
  o.onArrived?.(landed)
  return { summary: clip200(`${workText(0, coming.length)} came along${besideText}${heldText}${leftText}`) }
}

// ----------------------------------------------------------------- releasing

/**
 * The half of "move, not copy" on the computer the work left, once it arrived: the paths that
 * went are set aside in a stash (never dropped, never cleaned). One edited since it was packed
 * stays as it is, named in `kept`. Without git, the files stay where they are.
 */
export async function releaseWork(sh: MoveShell, o: { folder: string; paths: string[]; to: string; transferId: string }): Promise<{ kept: string[]; noRepo?: true }> {
  const root = await gitText(sh, ['rev-parse', '--show-toplevel'], o.folder)
  const ref = `refs/multiplayer/out/${o.transferId}`
  if (!root) return { kept: [], noRepo: true }
  if (!(await gitText(sh, ['rev-parse', '-q', '--verify', ref], root))) return { kept: [...o.paths] }
  const entries = (await entriesOf(sh, root, ref, [], true)) ?? []
  const asked = new Set(o.paths)
  const stash: string[] = []
  const kept: string[] = []
  for (const e of entries) {
    if (!asked.has(e.path)) continue
    const there = await exists(sh, `${root}/${e.path}`)
    const now = there ? await gitText(sh, ['hash-object', '--', e.path], root) : null
    const sent = e.status === 'D' ? null : e.sha
    if (now === sent) stash.push(e.path)
    else kept.push(e.path)
  }
  if (stash.length) {
    const r = await git(sh, ['stash', 'push', '--include-untracked', '-q', '-m', `Multiplayer: moved to ${o.to}’s Claude Code`, '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: root, stdin: stash.join('\0'), timeoutMs: 120_000 })
    if (r.code !== 0) return { kept: [...kept, ...stash] }
  }
  await git(sh, ['update-ref', '-d', ref], { cwd: root })
  return { kept }
}

// ------------------------------------------------------------------ arriving

/**
 * The conversation moved here from a Claude Code that was offline, so only what it pushed can
 * come: pulled (fast-forward only) when this folder is on that branch and has no changes of its
 * own. Never pushes, never discards. Null outside git.
 */
export async function pullMoved(sh: MoveShell, o: { folder: string; branch: string }): Promise<{ pulled: number } | { note: string } | null> {
  const root = await gitText(sh, ['rev-parse', '--show-toplevel'], o.folder)
  if (!root) return null
  const on = await gitText(sh, ['rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (on !== o.branch) return { note: `this folder is on ${on ?? 'no branch'}, not ${o.branch}` }
  if (await gitText(sh, ['status', '--porcelain', '--untracked-files=no'], root)) return { note: 'this folder has uncommitted changes' }
  const before = await gitText(sh, ['rev-parse', 'HEAD'], root)
  const r = await git(sh, ['pull', '--ff-only', '-q'], { cwd: root, timeoutMs: 120_000 })
  if (r.code !== 0) return { note: 'it needs a merge, so pull it from the Files panel' }
  const after = await gitText(sh, ['rev-parse', 'HEAD'], root)
  if (!before || !after || before === after) return { pulled: 0 }
  return { pulled: Number(await gitText(sh, ['rev-list', '--count', `${before}..${after}`], root)) || 0 }
}

// -------------------------------------------------------------------- copies

/**
 * A copy of a turn's files made outside git, for someone's browser: a plain .tar (any computer
 * opens one) of those of `paths` that may travel. Private files, anything outside the folder, and
 * files no longer there stay out, named in `left`.
 */
export async function packFiles(sh: MoveShell, o: { folder: string; paths: string[]; out: string }): Promise<{ bytes: number; sha256: string; files: string[]; left: string[] } | Failed> {
  await tempFolder(sh, parentOf(o.out))
  const folder = slash(o.folder)
  // Where the folder really is: a file goes only if it's really there, with no link on its way.
  const realFolder = sh.realPath ? slash((await sh.realPath(folder).catch(() => undefined)) ?? '') : null
  const sameFile = (a: string, b: string) => (/^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b)
  const files: string[] = []
  const left: string[] = []
  for (const p of [...new Set(o.paths)]) {
    let ok = plainPath(p) && !intoGit(p) && !privateSource('Read', { file_path: `${folder}/${p}` }, o.folder)
    if (ok) {
      // A file, not a folder (which tar would take whole) and not a link.
      const e = (await sh.list(parentOf(`${folder}/${p}`)).catch(() => undefined))?.find((x) => x.name === baseOf(p))
      ok = !!e && e.kind === 'file'
    }
    if (ok && realFolder !== null) {
      const real = await sh.realPath!(`${folder}/${p}`).catch(() => undefined)
      ok = !!realFolder && !!real && sameFile(slash(real), `${realFolder}/${p}`)
    }
    ;(ok ? files : left).push(p)
  }
  if (!files.length) return { error: 'none of those files are there any more' }
  try {
    // Run from the folder, the names in a file (a command line can't hold thousands), and the
    // archive by a relative path: GNU tar reads "C:/…" as another computer's path.
    const list = `${parentOf(o.out)}/files.list`
    // Each name as ./name: tar reads a line starting with "-" as an option.
    await sh.write(list, files.map((f) => `./${f}`).join('\n') + '\n')
    const r = await sh.run(['tar', '-cf', relativePath(folder, slash(o.out)), '--no-recursion', '-T', list], { cwd: folder, timeoutMs: 300_000 })
    if (r.exitCode !== 0) return { error: `the files couldn’t be packed (${r.stderr.trim().split('\n')[0]?.slice(0, 120) || 'tar failed'})` }
  } catch {
    return { error: 'tar isn’t on this computer' }
  }
  const bytes = await sizeOf(sh, o.out)
  if (bytes === null) return { error: 'the files couldn’t be packed' }
  if (bytes > MOVE_MAX_BYTES) return { error: 'they come to over 200 MB, too big to send this way' }
  const sha256 = await fileSha(sh, o.out)
  if (!sha256) return { error: 'sending files needs git 2.29 or newer here' }
  return { bytes, sha256, files, left }
}

/** `to` relative to the folder `from` (both absolute, forward slashes), without a drive letter. */
function relativePath(from: string, to: string): string {
  const win = /^[A-Za-z]:/.test(from)
  const a = from.replace(/\/+$/, '').split('/')
  const b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length && (win ? a[i].toLowerCase() === b[i].toLowerCase() : a[i] === b[i])) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.'
}
