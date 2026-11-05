// A branch's own Claude Code session: how it's started and how its output reads.
//
// Each shared branch is a real Claude Code session on the sender's machine. Its turns
// stay in it word for word; Claude Code's own compaction handles length; a branch is
// forked natively from its parent (`--resume <parent> --fork-session`, at the message
// its fork point ended on). The session asks permission through the turn's MCP
// endpoint on the server (`--permission-prompt-tool`), and records decisions there.

import { isModelName, isSite, usesCredits } from './lib/helpers.ts'

/** Where this turn's session comes from. */
export type SessionPlan =
  | { kind: 'new'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'fork'; from: string; at?: string }

export type ChildOptions = {
  plan: SessionPlan
  /** A pinned model (alias or id) and effort, as the branch has them. */
  model?: string
  effort?: string
  /** Stable instructions for the session (kept the same on every turn, so the prompt cache holds). */
  system: string
  /** The session's name in Claude Code (/resume's picker, the terminal title). */
  name: string
  /** This turn's MCP endpoint on the server. */
  mcpUrl: string
  /** Sites the space lets shared turns open without asking. */
  sites: readonly string[]
  /** Load this mod in the child (only its privacy filter runs there). */
  pluginDir?: string
  /** False for a one-off session nobody resumes (a recap). */
  persist: boolean
  /** The project's setup only: no user-level settings, plugins, MCP servers or CLAUDE.md. */
  projectSetup?: boolean
  /** With projectSetup: what of the person's user settings stays anyway (see keptUserSettings). */
  keep?: Record<string, unknown>
  /** What the branch's pin sets for its session (turnSettings), merged with `keep` into one --settings. */
  settings?: Record<string, unknown>
  /** The model to run on when the pinned one is overloaded. */
  fallback?: string
  /** What the turn may spend, in dollars (someone else's turn, capped by its runner). */
  budgetUsd?: number
  /** Claude Code's guess at the next prompt, after the turn (its prompt suggestions). */
  suggestions?: boolean
  /**
   * The permission mode to start in: 'plan' for a plan turn (Claude plans first, and its plan
   * comes to the sender to approve); another to leave a plan the session was left in.
   */
  permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'auto'
}

/**
 * What a project-setup session keeps of the person's own user settings: their protections
 * (deny and ask rules, hooks) and how they sign in (apiKeyHelper). Never anything that
 * loosens them (allow rules, a default mode). Undefined when there's nothing to keep.
 */
export function keptUserSettings(user: unknown): Record<string, unknown> | undefined {
  if (!user || typeof user !== 'object') return undefined
  const u = user as Record<string, unknown>
  const p = (u.permissions && typeof u.permissions === 'object' ? u.permissions : {}) as Record<string, unknown>
  const rules = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  const deny = rules(p.deny)
  const ask = rules(p.ask)
  const out: Record<string, unknown> = {}
  if (deny.length || ask.length) out.permissions = { ...(deny.length ? { deny } : {}), ...(ask.length ? { ask } : {}) }
  if (u.hooks && typeof u.hooks === 'object') out.hooks = u.hooks
  if (u.disableAllHooks === true) out.disableAllHooks = true
  if (typeof u.apiKeyHelper === 'string') out.apiKeyHelper = u.apiKeyHelper
  return Object.keys(out).length ? out : undefined
}

/** Claude Code's own program, as it names itself in CLAUDE_CODE_EXECPATH: an absolute path, never a name looked up on PATH. */
export function isClaudeProgram(p: string | undefined): p is string {
  if (!p || /[\0\r\n]/.test(p)) return false
  return /^[A-Za-z]:[\\/]/.test(p) ? /[\\/]claude\.exe$/i.test(p) : p.startsWith('/') && /\/claude$/.test(p)
}

/** A session name as Claude Code shows it: one line, no quotes or control characters. */
export function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/["'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Multiplayer'
}

export const TOOL_APPROVE = 'mcp__multiplayer__approve'
export const TOOL_DECISION = 'mcp__multiplayer__propose_decision'
export const TOOL_QUESTION = 'mcp__multiplayer__add_question'
/** Looking at and stopping what's set up for later is harmless; setting it up asks (it runs on the person's plan). */
export const TOOL_SCHEDULE_LOOK = ['mcp__multiplayer__list_schedules', 'mcp__multiplayer__stop_schedule']

/** Claude Code's arguments for one turn of a branch session (the prompt goes on standard input). */
/** How long the turn's MCP calls may wait quietly (a person deciding on a permission prompt). */
export const MCP_WAIT_MS = 15 * 60_000

export function childArgs(o: ChildOptions): string[] {
  const session = o.plan.kind === 'new' ? ['--session-id', o.plan.id]
    : o.plan.kind === 'resume' ? ['--resume', o.plan.id]
    : ['--resume', o.plan.from, '--fork-session', ...(o.plan.at ? ['--resume-session-at', o.plan.at] : [])]
  // Only plain hostnames become rules: anything else could add a rule of its own to the list.
  const allowed = [TOOL_DECISION, TOOL_QUESTION, ...TOOL_SCHEDULE_LOOK, ...o.sites.filter(isSite).map((s) => `WebFetch(domain:${s})`)]
  const merged = { ...(o.projectSetup && o.keep ? o.keep : {}), ...(o.settings ?? {}) }
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...session,
    ...(o.model && isModelName(o.model) ? ['--model', o.model] : []),
    ...(o.effort && /^(low|medium|high|xhigh|max)$/.test(o.effort) ? ['--effort', o.effort] : []),
    ...(o.fallback && isModelName(o.fallback) ? ['--fallback-model', o.fallback] : []),
    ...(o.budgetUsd && o.budgetUsd > 0 && Number.isFinite(o.budgetUsd) ? ['--max-budget-usd', String(o.budgetUsd)] : []),
    // With its value: bare, the flag would take the next argument as one.
    ...(o.suggestions ? ['--prompt-suggestions', 'true'] : []),
    '--append-system-prompt', o.system,
    '--name', cleanName(o.name),
    // `timeout`: its permission prompt waits for a person, silently. Claude Code gives up on an MCP
    // call that's quiet for 5 minutes (found live: an approval left 5 minutes failed); the server
    // answers within 4 ("ask again"), so 15 is never reached.
    '--mcp-config', JSON.stringify({ mcpServers: { multiplayer: { type: 'http', url: o.mcpUrl, timeout: MCP_WAIT_MS } } }),
    '--permission-prompt-tool', TOOL_APPROVE,
    ...(o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
    '--allowedTools', allowed.join(','),
    // The person's own protections hold even when their user settings are left out.
    ...(o.projectSetup ? ['--setting-sources', 'project,local'] : []),
    // One --settings for all of it: Claude Code reads only the last one given.
    ...(Object.keys(merged).length ? ['--settings', JSON.stringify(merged)] : []),
    ...(o.pluginDir ? ['--plugin-dir', o.pluginDir] : []),
    ...(o.persist ? [] : ['--no-session-persistence']),
  ]
}

/**
 * What a branch's pin sets for its session beyond its flags, as Claude Code's own settings keys.
 * `credits`: this turn may use its runner's usage credits (fast mode, a Fable advisor). Without
 * that, both are set outright, so no settings file (the project's, say) turns either on: fast mode
 * off, and the advisor the pin's or `ownAdvisor` (the person's own) where that bills nothing, else off.
 */
export function turnSettings(pin: { fast?: boolean; style?: string; advisor?: string; thinking?: boolean }, o: { credits: boolean; ownAdvisor?: string }): Record<string, unknown> {
  const free = (m: string | undefined): m is string => !!m && (m === 'off' || !usesCredits({ name: m }))
  const advisor = o.credits ? pin.advisor : free(pin.advisor) ? pin.advisor : free(o.ownAdvisor) ? o.ownAdvisor : 'off'
  return {
    ...(!o.credits ? { fastMode: false } : pin.fast ? { fastMode: true } : {}),
    // Unset, each is as its Claude Code has it; an advisor of 'off' turns its own off.
    ...(pin.style ? { outputStyle: pin.style } : {}),
    ...(advisor ? { advisorModel: advisor } : {}),
    ...(pin.thinking === false ? { alwaysThinkingEnabled: false } : {}),
  }
}

/** A random v4 UUID, for a new session's id. */
export function newSessionId(): string {
  const b = new Uint8Array(16)
  try { crypto.getRandomValues(b) } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256) }
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** What a turn's session did, read from its stream-json output. Only the main loop counts, not subagents. */
export type RunEvent =
  /** `commands`: the skills the session has (its init's skills; slash_commands where it lists none). */
  | { kind: 'init'; sessionId: string; model: string; commands?: string[] }
  /** The text written so far, the part still streaming included. */
  | { kind: 'text'; text: string }
  /** `parent`: the Agent tool call whose subagent made this one. */
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; parent?: string }
  | { kind: 'tool-result'; id: string; isError: boolean; text: string }
  /** An assistant message the session stored: a turn's last one is where a later fork starts. */
  | { kind: 'message'; uuid: string; model?: string }
  | { kind: 'rate'; status: string; resetsAt?: number; type?: string }
  /** `fastState`: whether fast mode ran ('on', 'off', 'cooldown'), as the result says; `fastReason`: why not, its code. */
  | { kind: 'result'; isError: boolean; subtype: string; text: string; usage?: ResultUsage; errors: string[]; fastState?: string; fastReason?: string }
  /** Claude Code's guess at the next prompt, written after the result. */
  | { kind: 'suggestion'; text: string }
  /** Something Claude Code said about the session (fast mode turned off, and the like). */
  | { kind: 'notice'; text: string }

export type ResultUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Reads stream-json lines as they arrive, keeping the turn's text in order. */
export class StreamReader {
  private buf = ''
  /** Text blocks the session finished. */
  private done: string[] = []
  /** The text block streaming now. */
  private partial = ''
  /** What Claude thought (its thinking blocks), as Claude Code shows it, folded. */
  private thoughts: string[] = []

  get thinking(): string {
    return this.thoughts.filter((t) => t.trim()).join('\n\n')
  }

  /** The answer so far: finished blocks, then the one streaming. */
  get text(): string {
    return [...this.done, this.partial].filter((t) => t.trim()).join('\n\n')
  }

  push(chunk: string): RunEvent[] {
    this.buf += chunk
    const out: RunEvent[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let m: Json
      try { m = obj(JSON.parse(line)) } catch { continue }
      out.push(...this.read(m))
    }
    return out
  }

  private read(m: Json): RunEvent[] {
    const sub = m.parent_tool_use_id != null && m.parent_tool_use_id !== ''
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          // The skills, which Claude can run when a prompt names one; Claude Code's own commands it can't (an older Claude Code that lists no skills: all of them).
          const list = Array.isArray(m.skills) ? m.skills : m.slash_commands
          const commands = Array.isArray(list) ? (list as unknown[]).filter((c): c is string => typeof c === 'string') : undefined
          return [{ kind: 'init', sessionId: str(m.session_id), model: str(m.model), ...(commands ? { commands } : {}) }]
        }
        if (m.subtype === 'notification' && !sub) {
          const text = (str(m.text) || str(m.message)).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 300)
          return text ? [{ kind: 'notice', text }] : []
        }
        return []
      case 'stream_event': {
        if (sub) return []
        const e = obj(m.event)
        if (e.type === 'content_block_start' && obj(e.content_block).type === 'text') this.partial = ''
        const d = obj(e.delta)
        if (e.type === 'content_block_delta' && d.type === 'text_delta') {
          this.partial += str(d.text)
          return [{ kind: 'text', text: this.text }]
        }
        return []
      }
      case 'assistant': {
        // A subagent's text is its own (its result comes back to Claude as the Agent tool's
        // result); its tool calls show, under the Agent step.
        if (sub) {
          const content = Array.isArray(obj(m.message).content) ? (obj(m.message).content as unknown[]) : []
          return content.map(obj).filter((c) => c.type === 'tool_use').map((c) => ({ kind: 'tool' as const, id: str(c.id), name: str(c.name), input: obj(c.input), parent: str(m.parent_tool_use_id) }))
        }
        const msg = obj(m.message)
        const out: RunEvent[] = []
        const content = Array.isArray(msg.content) ? msg.content : []
        let wrote = false
        for (const raw of content) {
          const c = obj(raw)
          if (c.type === 'text' && str(c.text).trim()) { this.done.push(str(c.text)); wrote = true }
          if (c.type === 'thinking' && str(c.thinking).trim()) this.thoughts.push(str(c.thinking))
          // The plan Claude puts up for approval (plan mode) is part of its answer: everyone reads it.
          if (c.type === 'tool_use' && str(c.name) === 'ExitPlanMode' && str(obj(c.input).plan).trim()) { this.done.push(str(obj(c.input).plan)); wrote = true }
          if (c.type === 'tool_use') out.push({ kind: 'tool', id: str(c.id), name: str(c.name), input: obj(c.input) })
        }
        if (wrote) { this.partial = ''; out.unshift({ kind: 'text', text: this.text }) }
        if (m.uuid) out.push({ kind: 'message', uuid: str(m.uuid), model: str(msg.model) || undefined })
        return out
      }
      case 'user': {
        // A subagent's tool results end its steps too (its prompt and other text stay out).
        const content = Array.isArray(obj(m.message).content) ? (obj(m.message).content as unknown[]) : []
        const out: RunEvent[] = []
        for (const raw of content) {
          const c = obj(raw)
          if (c.type !== 'tool_result') continue
          const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => str(obj(x).text)).join('\n') : ''
          out.push({ kind: 'tool-result', id: str(c.tool_use_id), isError: c.is_error === true, text: t })
        }
        return out
      }
      case 'rate_limit_event': {
        const r = obj(m.rate_limit_info)
        const at = typeof r.resetsAt === 'number' ? (r.resetsAt < 1e12 ? r.resetsAt * 1000 : r.resetsAt) : undefined
        return [{ kind: 'rate', status: str(r.status), resetsAt: at, type: str(r.rateLimitType) || undefined }]
      }
      case 'result': {
        const errors = Array.isArray(m.errors) ? m.errors.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []
        return [{ kind: 'result', isError: m.is_error === true, subtype: str(m.subtype), text: str(m.result), usage: obj(m.usage) as ResultUsage, errors, ...(str(m.fast_mode_state) ? { fastState: str(m.fast_mode_state) } : {}), ...(str(m.fast_mode_disabled_reason) ? { fastReason: str(m.fast_mode_disabled_reason) } : {}) }]
      }
      case 'prompt_suggestion': {
        const text = str(m.suggestion).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 2000)
        return text ? [{ kind: 'suggestion', text }] : []
      }
      default:
        return []
    }
  }
}

/** A tool result that is a permission refusal (shown as denied, not failed). */
export function isRefusal(text: string): boolean {
  return /denied by its owner|permission|requires approval|not allowed|was denied|user rejected|nobody answered/i.test(text)
}
