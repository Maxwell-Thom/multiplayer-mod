// Reading a Claude Code session (its transcript file, one JSON record a line) as the turns of a
// conversation, to bring it into a space: each prompt the person typed, what Claude answered,
// and the tools it used, in order. Each turn keeps the id of the message it ended on, so the
// person's own Claude Code can carry on from a copy of the session forked exactly there.
import { chunkImport } from './lib/helpers.ts'
import type { ImportTurn } from './lib/types.ts'

/** One turn of a session, and the message it ended on (for `--resume-session-at`). */
export type SessionTurn = ImportTurn & { uuid?: string }

export type ParsedSession = {
  /** Claude Code's own title for it, else its first prompt. */
  title: string
  /** The model it last answered on. */
  model?: string
  turns: SessionTurn[]
}

type Rec = {
  type?: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  turnOrigin?: string
  timestamp?: string
  aiTitle?: string
  summary?: string
  message?: { role?: string; model?: string; content?: unknown }
}

type Block = { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean }

const isMessage = (r: Rec) => (r.type === 'user' || r.type === 'assistant') && !r.isSidechain
const blocks = (r: Rec): Block[] => (Array.isArray(r.message?.content) ? (r.message!.content as Block[]).filter((b) => b && typeof b === 'object') : [])

/** What Claude Code puts in a prompt that the person didn't type. */
const stripInjected = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

/** A slash command the person ran: `/name args`, from Claude Code's command markup. */
function slashCommand(s: string): string | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(s)?.[1]?.trim()
  if (!name) return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim()
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`
}

/** Output Claude Code wrote for a local command or a `!` shell line: not a prompt to Claude. */
const isLocalOutput = (s: string) => /^\s*<(local-command-|bash-|task-notification|user-memory-input)/.test(s)

/** The text a person typed in a user message, or undefined when it isn't a prompt. */
function promptOf(r: Rec): { text: string; command?: boolean } | undefined {
  if (r.type !== 'user' || r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) return undefined
  // Typed by the person, or sent by a program as the prompt (`claude -p`); not hooks' or tasks' notices.
  if (r.turnOrigin !== undefined && r.turnOrigin !== 'human' && r.turnOrigin !== 'sdk') return undefined
  const c = r.message?.content
  if (typeof c === 'string') {
    if (isLocalOutput(c)) return undefined
    const cmd = slashCommand(c)
    if (cmd) return { text: cmd, command: true }
    const t = stripInjected(c)
    return t ? { text: t } : undefined
  }
  const bs = blocks(r)
  if (!bs.length || bs.every((b) => b.type === 'tool_result')) return undefined
  const parts = bs.map((b) => (b.type === 'text' ? stripInjected(b.text ?? '') : b.type === 'image' ? '[image]' : b.type === 'document' ? '[document]' : '')).filter(Boolean)
  const t = parts.join('\n\n').trim()
  if (!t || isLocalOutput(t)) return undefined
  const cmd = slashCommand(t)
  return cmd ? { text: cmd, command: true } : { text: t }
}

/** A tool use in a line, the way the web app shows a step. */
function stepText(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const pick = (...keys: string[]) => keys.map((k) => i[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const s = pick('command') ?? pick('file_path', 'notebook_path', 'path') ?? pick('pattern') ?? pick('url') ?? pick('query')
    ?? pick('description', 'prompt', 'subject') ?? Object.values(i).find((v): v is string => typeof v === 'string') ?? ''
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > 300 ? `${line.slice(0, 299)}…` : line || name
}

/** The session's current line, oldest first: from its newest message back, across compactions. */
function currentLine(recs: Rec[]): Rec[] {
  const byId = new Map<string, Rec>()
  for (const r of recs) if (r.uuid) byId.set(r.uuid, r)
  let leaf: Rec | undefined
  for (let i = recs.length - 1; i >= 0 && !leaf; i--) if (isMessage(recs[i]) && recs[i].uuid) leaf = recs[i]
  const line: Rec[] = []
  const seen = new Set<string>()
  for (let r = leaf; r && r.uuid && !seen.has(r.uuid); ) {
    seen.add(r.uuid)
    line.push(r)
    // After /compact the line restarts at a boundary that points back to what came before.
    const next = (r.parentUuid ? byId.get(r.parentUuid) : undefined) ?? (r.logicalParentUuid ? byId.get(r.logicalParentUuid) : undefined)
    r = next
  }
  return line.reverse()
}

export function parseSession(jsonl: string): ParsedSession {
  const recs: Rec[] = []
  for (const l of jsonl.split('\n')) {
    if (!l.trim()) continue
    try { recs.push(JSON.parse(l) as Rec) } catch { /* a line being written as it was read */ }
  }
  let title = ''
  for (const r of recs) {
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim()) title = r.aiTitle.trim()
    else if (!title && r.type === 'summary' && typeof r.summary === 'string') title = r.summary.trim()
  }

  const turns: (SessionTurn & { command?: boolean; ids: Map<string, number> })[] = []
  let model: string | undefined
  for (const r of currentLine(recs)) {
    if (!isMessage(r)) continue
    const p = promptOf(r)
    if (p) {
      const at = r.timestamp ? Date.parse(r.timestamp) : NaN
      turns.push({ prompt: p.text, text: '', steps: [], at: Number.isFinite(at) ? at : undefined, command: p.command, ids: new Map() })
      continue
    }
    const t = turns[turns.length - 1]
    if (!t) continue
    if (r.type === 'assistant') {
      const m = r.message?.model
      if (m && !m.startsWith('<')) { t.model = m; model = m }
      for (const b of blocks(r)) {
        if (b.type === 'text' && b.text?.trim()) t.text = t.text ? `${t.text}\n\n${b.text.trim()}` : b.text.trim()
        else if (b.type === 'tool_use' && b.name) {
          if (b.id) t.ids.set(b.id, t.steps!.length)
          t.steps!.push({ tool: b.name, text: stepText(b.name, b.input) })
        }
      }
      if (r.uuid) t.uuid = r.uuid
    } else {
      for (const b of blocks(r)) {
        const i = b.type === 'tool_result' && b.is_error && b.tool_use_id ? t.ids.get(b.tool_use_id) : undefined
        if (i !== undefined) t.steps![i].failed = true
      }
    }
  }

  // A slash command that didn't set Claude going was the person's, not a turn; nor is a last
  // prompt Claude never answered (the session can only carry on from an answer).
  const kept = turns.filter((t) => !(t.command && !t.uuid))
  while (kept.length && !kept[kept.length - 1].uuid) kept.pop()
  const out: SessionTurn[] = kept.map(({ command: _c, ids: _i, steps, ...t }) => ({ ...t, ...(steps?.length ? { steps } : {}) }))
  return { title: title || clipLine(out[0]?.prompt ?? '') || 'Claude Code session', model, turns: out }
}

function clipLine(s: string, n = 80): string {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

/** Where Claude Code keeps a session's transcript: `<config>/projects/<the folder, as a name>/<id>.jsonl`. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  const dir = configDir.replace(/[\\/]+$/, '')
  return `${dir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

/** Turns cut and grouped into requests the server takes (see `chunkImport` in the protocol). */
export const chunkTurns = (turns: SessionTurn[]) => chunkImport(turns)
