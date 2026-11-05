// The runner: this person's Claude Code running their turns of a shared
// Multiplayer conversation. It does what packages/sim's SimRunner does over the
// same wire, with a real Claude Code session in place of the simulated answer.
//
// Shape of a shared turn here:
//   poll → turn requested for me → (limit? decline) → (parts clash? runner.check)
//   → queued until this session is idle → runner.start (the server hands back the
//   turn's MCP token) → the branch's own Claude Code session runs it (child.ts):
//   resumed, forked from its parent's at the fork point, or new; given only what it
//   doesn't hold → its stream-json becomes steps and live text → runner.done (or
//   runner.fail). Permission questions reach the person through the turn's MCP
//   endpoint (the web app, or /multiplayer allow here).
import type { SessionRateLimit, TurnCompleteInput } from 'claude-code'

import type { MultiplayerMemo, MultiplayerView } from '../types'
import { StreamReader, childArgs, isClaudeProgram, isRefusal, keptUserSettings, newSessionId, type ResultUsage, type RunEvent, type SessionPlan } from './child.ts'
import {
  HttpError, Wire, createSpace, health, joinSpace, logoutAccount, normalizeServer, pollDevice, redeemPair, startDevice, webLink,
  type DevicePoll, type DeviceStart, type Health, type StoredAccount, type StoredSession,
} from './client.ts'
import * as fmt from './format.ts'
import * as G from './git.ts'
import type { Command } from './lib/commands.ts'
import { type FolderView, buildSessionTurn, parseReplies } from './lib/context.ts'
import type { FilesAction, FilesReport, LocalAction, LocalReport, LocalSession, SpaceEvent } from './lib/events.ts'
import { type AskQuestion, clip, fileType, fmtSize, historyTurns, isActive, isMain, isModelName, isOneOff, mainOf, memberName } from './lib/helpers.ts'
import { type ParsedSession, chunkTurns, parseSession, transcriptPath } from './transcript.ts'
import { apply } from './lib/reduce.ts'
import { insideFolder, privateSource, privateStepText } from './lib/privacy.ts'
import type { Port } from './port.ts'
import type { Branch, MemberId, Presence, RunnerInfo, SpaceState, Step, Turn, TurnFailure, TurnMode, TurnWork, Usage } from './lib/types.ts'
import { FILE_MAX_BYTES, WORK_COMMITS_MAX, WORK_FILES_MAX } from './lib/types.ts'
import { BRIDGED_TOOLS, type CommandResponse, type RunnerHello, type RunnerInbound } from './lib/wire.ts'

export const PLUGIN = 'multiplayer'
export const PANE = 'multiplayer'

const STORE_SESSIONS = 'sessions'
const STORE_ACTIVE = 'activeSpace'
const STORE_PAUSED = 'paused'
const STORE_NAME = 'name'
/** Each branch's own Claude Code session on this machine, by `<space>:<branch>` (before they were kept per folder). */
const STORE_BRANCHES = 'branchSessions'
/** The same, by folder: Claude Code keeps a session under the folder it ran in. */
const STORE_BRANCHES_BY_FOLDER = 'branchSessionsByFolder'
/** The biggest session file the mod can read (Claude Code reads files for mods up to 4 MiB). */
const SESSION_MAX_BYTES = 4 * 1024 * 1024
/** This Claude Code's account sign-ins, one per server (from /multiplayer login). */
const STORE_ACCOUNTS = 'accounts'
/** Claude Code sessions brought into spaces: session id → where they went (newest last). */
const STORE_BROUGHT = 'brought'
type Brought = { sessionId: string; spaceId: string; conversationId: string; at: number }
/** A Claude Code session's transcript file. */
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
/** How many of the newest session files a listing looks at, and how many it lists. */
const LOCAL_SCAN = 60
const LOCAL_MAX = 25

/** One folder, however it's spelled (Windows' folders don't care about case or slashes). */
function folderKeyOf(p: string): string {
  const c = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(c) ? c.toLowerCase() : c
}

/** Said to the person when the sessions shared turns run in can't sign in. */
export const SIGN_IN_HELP = 'Shared turns run in a Claude Code session of their own on this machine, and it can’t sign in. Run /login here (a token in CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY doesn’t reach sessions a mod starts).'
const NO_PROGRAM = 'Multiplayer couldn’t find the Claude Code program on this machine to run shared turns in.'
// Why a turn stopped when its Claude Code left the space mid-turn (only its runner sees the detail).
const MOVED_MID_TURN = 'This Claude Code was signed in to another space before the turn finished.'
const SIGNED_OUT_MID_TURN = 'This Claude Code was signed out of the space before the turn finished.'
/** The program that started this PowerShell: Claude Code. */
const PARENT_PS = '(Get-CimInstance Win32_Process -Filter "ProcessId=$((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)").ExecutablePath'
/** The program that started this shell (Linux, then macOS), then `claude` on PATH. */
const PARENT_SH = 'readlink "/proc/$PPID/exe" 2>/dev/null; ps -o comm= -p "$PPID" 2>/dev/null; command -v claude 2>/dev/null'

export const EMPTY_VIEW: MultiplayerView = {
  isSignedIn: false, space: '', code: '', link: '', me: '', status: 'not signed in', needsYou: false, people: [], turns: [], approval: null,
}

export type Decision = 'allow-once' | 'allow-always' | 'deny'

/**
 * A branch's Claude Code session here: what it holds, and the message each turn it ran ended
 * on (to fork from). `rewind`: a turn that isn't part of the shared history (it failed, or
 * someone took it over) was left at its end, so the next turn forks back to `through`.
 */
export type BranchSession = { id: string; through: string | null; at: Record<string, string>; state?: string; rewind?: boolean }

/** A permission prompt waiting on this person; `always` is what "always" covers, absent when only once is possible. */
type Pending = { requestId: string; tool: string; title: string; always?: string; questions?: AskQuestion[]; i: number | undefined }

/** The shared turn this runner is running (one at a time). */
export type Active = {
  turnId: string
  branchId: string
  label: string
  mode: TurnMode
  parts: number
  /** A private lane or a recap: only this person sees it, so their own profile stays on. */
  private: boolean
  /** The model named in runner.start, then the one the session reports. */
  model: string
  /** Text so far, the block streaming now included. */
  live: string
  steps: number
  stepText: Map<number, Step>
  /** The session's tool calls, by id, to the steps they show as. */
  toolSteps: Map<string, number>
  /** Latest running step per tool name, for matching a permission question to its step. */
  current: Map<string, number>
  lastDelta: number
  deltaTimer: { cancel: () => void } | null
  /** `left`: this Claude Code signed in to another space, or out of this one, mid-turn. */
  stopped: null | 'server' | 'takeover' | 'gone' | 'left'
  /** The space the turn belongs to, as it was when it started: a later switch doesn't move it. */
  wire: Wire | null
  spaceId: string
  /** The branch session's process has ended: what's left is reporting how it went. */
  exited: boolean
  /** Settles once the turn's ending has been sent (or given up on). */
  finished: Promise<void>
  settle: () => void
  /** Ends the branch session's process (a stop, a take-over). */
  kill: (() => void) | null
  startHead: string | null
  /** The folder as the turn started (null: not a git repository; undefined: couldn't tell). */
  work0: G.WorkStart | null | undefined
  /** Files Claude's edit steps named. */
  touched: Set<string>
  chain: Promise<unknown>
  approvals: Map<string, Pending>
}

/**
 * A shared turn's changes in this folder that aren't all pushed yet. The runner checks them
 * again now and then, and tells the space when they're committed or pushed. `sent`: the last
 * report the space has.
 */
type WorkEntry = {
  turnId: string
  spaceId: string
  at: number
  /** What `files` are relative to: the repository's root (or the folder, outside git). */
  root: string
  files: string[]
  commits: { sha: string; subject: string }[]
  pushed?: string
  noRepo?: boolean
  sent: string
}

/** Each folder's WorkEntry list, by folder. */
const STORE_WORK = 'work'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001f\u007f\u2028\u2029]/g
const workPending = (e: WorkEntry) => !!e.noRepo || e.files.length > 0 || (e.commits.length > 0 && !e.pushed)

type Job =
  | { kind: 'shared'; turnId: string; noticed?: boolean }
  | { kind: 'combine'; requestId: string; prompt: string; noticed?: boolean }

export type RunnerOptions = { server: string; name: string }

async function soft<T>(f: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await f()
  } catch {
    return undefined
  }
}

function randomId(prefix: string): string {
  const alpha = 'abcdefghijkmnopqrstuvwxyz23456789'
  const bytes = new Uint8Array(12)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (const b of bytes) out += alpha[b % alpha.length]
  return `${prefix}_${out}`
}

function matches(text: string, prompt: string): boolean {
  if (!text || !prompt) return false
  if (text === prompt) return true
  const head = prompt.slice(0, 160)
  return text.includes(head) || (text.length > 40 && prompt.includes(text.slice(0, 160)))
}

function usageOf(u: ResultUsage | undefined): Usage | undefined {
  if (!u || typeof u.input_tokens !== 'number') return undefined
  return { input: u.input_tokens, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }
}

function when(at: number | undefined): string {
  if (!at) return ''
  const mins = Math.round((at - Date.now()) / 60_000)
  if (mins <= 1) return 'in a minute'
  if (mins < 90) return `in ${mins} minutes`
  return `in about ${Math.round(mins / 60)} hours`
}

export class Runner {
  io!: Port
  readonly opts: RunnerOptions

  session: StoredSession | null = null
  wire: Wire | null = null
  state: SpaceState | null = null
  me: MemberId = ''
  presence: Presence[] = []
  runners: RunnerInfo[] = []
  runnerSession = ''

  /** Bumped to retire a poll loop. */
  gen = 0
  phase: 'off' | 'connecting' | 'online' | 'reconnecting' | 'superseded' | 'signed-out' = 'off'
  paused = false
  /** The person's own turn is running in this session. */
  busy = false
  /** The server was told a shared turn waits for that turn to finish (its sender's screen says so). */
  heldBusy = false
  queue: Job[] = []
  handling = new Set<string>()
  cooldown = new Map<string, number>()
  active: Active | null = null
  /** Turns whose process ended, still sending how it went. */
  ending = new Set<Active>()
  /** Bumped each time this Claude Code leaves a space (for another, or none); `leftWhy` says how. */
  room = 0
  leftWhy = ''
  /** The goodbye to the space it left, while it's being said. */
  leaving: { spaceId: string; memberId: string; done: Promise<void> } | null = null
  /** This Claude Code is closing: nothing more goes to any server. */
  closing = false
  combine: { requestId: string; prompt: string; ccTurnId: string | null; wire: Wire | null } | null = null
  /** /multiplayer share: the draft this session's Claude is writing (or wrote), and where it goes. */
  share: { prompt: string; branchId: string; ccTurnId: string | null; draft?: string } | null = null
  rateLimits: SessionRateLimit[] = []
  /** Long-poll seconds; lowered if the host cuts long requests short. */
  wait = 25
  resyncStreak = 0
  cwd = ''
  home = ''
  lastBranchId: string | null = null
  modelOk = new Map<string, boolean>()
  /** A branch session here can sign in (checked once it's true; rechecked while it isn't). */
  childOk = false
  /** Claude Code's own program, once found. */
  program: string | undefined
  private pumping = false
  private peopleAt = 0
  private lastStatus: string | undefined = undefined
  private lastView = ''
  /** This Claude Code's sign-in to its person's account on the configured server, when it has one. */
  account: StoredAccount | null = null
  /** /multiplayer login waiting for its person to approve it in the web app. */
  private login: (DeviceStart & { server: string }) | null = null
  private loginGen = 0
  /** What to do once signed in: the start or join that asked for it. */
  private afterLogin: (() => Promise<string>) | null = null
  private servers = new Map<string, Health>()

  constructor(opts: RunnerOptions) {
    this.opts = opts
  }

  // ================================================================ lifecycle

  /**
   * From session.start: read what is stored and start polling. Never waits on the network.
   *
   * Only one Claude Code runs a person's turns, and a new one doesn't take them from another
   * that is still here: a session nobody is at (`interactive` false: `claude -p`, an SDK host)
   * never connects by itself, and a new interactive one first asks whether another of theirs is
   * connected. `/multiplayer resume` moves them on purpose.
   */
  async init(io: Port, cwd: string, interactive = true): Promise<void> {
    this.io = io
    this.closing = false
    this.cwd = cwd
    this.home = (await soft(() => io.home())) || ''
    const memo = await soft(() => io.getMemo())
    // The same process going on (a /clear or a resume) or the same session after a reload of
    // this mod: still the runner it was. Anything else is a new Claude Code.
    const known = this.runnerSession || memo?.runnerSession || ''
    this.runnerSession = known || randomId('rs')
    this.paused = (await soft(() => io.storeGet(STORE_PAUSED))) === true
    this.account = (await this.accountFor(normalizeServer(this.opts.server))) ?? null
    this.session = await this.loadSession()
    // The module reloaded while a branch session ran a turn: unloading ended that process, so the turn is lost.
    const lost = memo?.active && this.session ? memo.active.turnId : null
    await this.saveMemo()
    await soft(() => io.registerCommand({
      name: 'multiplayer',
      description: 'Multiplayer: run your turns of a shared Claude conversation here',
      argumentHint: 'start <space> | join <code> [name] | connect <pairing code> | status | open | pause | resume | allow | deny | stop | sharing | unshare <name|all> | share <what> | post [text] | take-home | leave',
      immediate: true,
    }))
    // Paused too: connected, so the web app shows it paused and can resume it.
    if (this.session && interactive) {
      if (known) this.connect()
      else void this.connectUnlessElsewhere()
    }
    if (lost && this.session) {
      const w = new Wire(io.fetch, this.session, this.runnerSession)
      void soft(() => w.command({ type: 'runner.fail', turnId: lost, failure: { reason: 'error', detail: 'Claude Code reloaded the Multiplayer mod while running this turn.' } }))
    }
    this.refresh()
  }

  stop(): void {
    this.gen++
    this.closing = true
    this.phase = 'off'
  }

  /**
   * This Claude Code is closing, and the sessions of its shared turns with it: tell the server,
   * so a running turn can be retried and a waiting one goes back to the draft now, not after
   * the lease. A few seconds at most.
   */
  async bye(): Promise<void> {
    const w = this.wire
    // Stop first: nothing (a poll, a turn's last word) goes after the goodbye.
    this.stop()
    if (!w) return
    await Promise.race([w.bye(), this.io.sleep(3000)])
  }

  /**
   * How a turn ends, sent until the server has it: a network blip at the end of a turn would
   * otherwise lose the answer, and the turn would wait out the lease and run again elsewhere.
   */
  private async finishCommand(cmd: Command, w: Wire): Promise<void> {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
      // Through the turn's own space, even after a switch; never after this Claude Code said goodbye.
      if (this.closing) return
      const r = await w.command(cmd)
      if (r.ok || !r.network) return
      if (wait >= 30_000 * 4) return
      this.io.log(`multiplayer: couldn’t reach the server to finish a turn (${r.error}); trying again`, true)
      await this.io.sleep(wait)
    }
  }

  private async loadSession(): Promise<StoredSession | null> {
    const list = (await soft(() => this.io.storeGet(STORE_SESSIONS))) as StoredSession[] | undefined
    const activeId = await soft(() => this.io.storeGet(STORE_ACTIVE))
    if (!Array.isArray(list) || !list.length) return null
    return list.find((s) => s.spaceId === activeId) ?? null
  }

  private async saveSession(s: StoredSession): Promise<void> {
    const list = ((await soft(() => this.io.storeGet(STORE_SESSIONS))) as StoredSession[] | undefined) ?? []
    const next = [s, ...(Array.isArray(list) ? list : []).filter((x) => !(x.spaceId === s.spaceId && x.server === s.server))].slice(0, 20)
    await this.io.storeSet(STORE_SESSIONS, next)
    await this.io.storeSet(STORE_ACTIVE, s.spaceId)
    if (s.name) await this.io.storeSet(STORE_NAME, s.name)
  }

  private async forgetSession(): Promise<void> {
    const s = this.session
    if (!s) return
    const list = ((await soft(() => this.io.storeGet(STORE_SESSIONS))) as StoredSession[] | undefined) ?? []
    await soft(() => this.io.storeSet(STORE_SESSIONS, (Array.isArray(list) ? list : []).filter((x) => x.spaceId !== s.spaceId)))
    await soft(() => this.io.storeDelete(STORE_ACTIVE))
  }

  async saveMemo(): Promise<void> {
    const a = this.active
    const memo: MultiplayerMemo = {
      runnerSession: this.runnerSession,
      active: a ? { turnId: a.turnId, branchId: a.branchId } : null,
    }
    await soft(() => this.io.setMemo(memo))
  }

  /** Starts a fresh poll loop for the stored session (a new gen retires any old one). */
  connect(): void {
    if (!this.session) return
    const gen = ++this.gen
    this.wire = new Wire(this.io.fetch, this.session, this.runnerSession)
    this.phase = 'connecting'
    this.resyncStreak = 0
    this.refresh()
    void this.loop(gen)
  }

  private async loop(gen: number): Promise<void> {
    let backoff = 1000
    let needHello = true
    // Paused, it keeps polling and picks nothing up (pickUp checks), so Resume in the web app reaches it.
    while (gen === this.gen) {
      const startedAt = Date.now()
      try {
        if (needHello || !this.state) {
          await this.resync()
          await this.hello()
          needHello = false
          this.phase = 'online'
          this.react([])
          void this.childProblem().then((p) => { if (p) this.io.log(`${p.reason === 'not-signed-in' ? SIGN_IN_HELP : p.detail}`) })
        }
        const r = await this.pollOnce(this.wait)
        if (gen !== this.gen) return
        if (r === 'superseded') {
          this.phase = 'superseded'
          this.refresh()
          this.io.toast('Multiplayer: another Claude Code signed in as you is running your turns now. Type /multiplayer resume to take them back here.')
          void this.watchSuperseded(gen)
          return
        }
        backoff = 1000
        void this.refreshPeople()
        // A push from a terminal, outside any turn: noticed within a few minutes.
        if (!this.active) void this.recheckWork(false)
      } catch (err) {
        if (gen !== this.gen) return
        const status = err instanceof HttpError ? err.status : 0
        if (status === 401 || status === 403) {
          this.phase = 'signed-out'
          this.refresh()
          this.io.toast('Multiplayer: this space no longer accepts your sign-in. Join again with /multiplayer join <code>.')
          return
        }
        // A long poll the host cut short: ask for shorter ones from now on.
        if (!status && this.wait > 10 && Date.now() - startedAt > this.wait * 800) {
          this.wait = 10
          this.io.log(`multiplayer: a ${Math.round((Date.now() - startedAt) / 1000)}s long poll failed (${(err as Error).message}); polling with wait=10 from now on`, true)
        }
        needHello = true
        this.phase = 'reconnecting'
        this.refresh()
        await soft(() => this.io.sleep(backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  /**
   * Who's here and whose Claude is connected. Polls don't carry either, so a session
   * that has been up a while looks again, at most once a minute (and when the pane opens).
   */
  async refreshPeople(force = false): Promise<void> {
    if (!this.wire || (!force && Date.now() - this.peopleAt < 60_000)) return
    this.peopleAt = Date.now()
    const w = this.wire
    const snap = await soft(() => w.snapshot())
    if (!snap || w !== this.wire) return
    this.presence = snap.presence
    this.runners = snap.runners
    this.refresh()
  }

  /**
   * The newer Claude Code may be short-lived (a `claude -p` run, a quick session in another
   * folder). Once the server no longer sees it, take the turns back here, so nobody's turns
   * go unrun until they type /multiplayer resume.
   */
  private async watchSuperseded(gen: number, again = true): Promise<void> {
    while (gen === this.gen && this.phase === 'superseded') {
      await soft(() => this.io.sleep(30_000))
      if (gen !== this.gen || this.phase !== 'superseded' || !this.wire) return
      const snap = await soft(() => this.wire!.snapshot())
      if (gen !== this.gen) return
      if (!snap) continue
      const mine = snap.runners.find((x) => x.memberId === snap.me)
      if (mine?.connected) continue
      this.io.toast(`Multiplayer: the other Claude Code signed in as you has gone, so your turns run here ${again ? 'again' : 'now'}.`)
      this.connect()
      return
    }
  }

  /**
   * A new Claude Code with a stored sign-in: if another of this person's is connected and
   * running their turns (in another window, on another computer), they stay there, and this
   * one takes over only once that one is gone, or on /multiplayer resume.
   */
  private async connectUnlessElsewhere(): Promise<void> {
    const s = this.session
    if (!s) return
    const gen = ++this.gen
    const w = new Wire(this.io.fetch, s, this.runnerSession)
    const snap = await soft(() => w.snapshot())
    if (gen !== this.gen || this.session !== s) return
    const mine = snap?.runners.find((x) => x.memberId === snap.me)
    if (!snap || !mine?.connected) { this.connect(); return }
    this.wire = w
    this.state = snap.state
    this.me = snap.me
    this.presence = snap.presence
    this.runners = snap.runners
    this.phase = 'superseded'
    this.refresh()
    this.io.toast('Multiplayer: another Claude Code signed in as you is running your turns. Type /multiplayer resume to run them here instead.')
    void this.watchSuperseded(gen, false)
  }

  /** A turn of this person's that another of their Claude Codes is running right now. */
  private turnRunningElsewhere(): Turn | undefined {
    if (this.active || !this.state) return undefined
    const mine = this.runners.find((x) => x.memberId === this.me)
    if (!mine?.connected) return undefined
    return Object.values(this.state.turns).find((t) => t.runnerId === this.me && !!t.startedAt && (t.status === 'running' || t.status === 'approval'))
  }

  /**
   * Taking the turns over on purpose while another Claude Code is in the middle of one: saying
   * hello now would end that turn, so wait for it to finish there first.
   */
  private async connectAfter(turnId: string): Promise<void> {
    const gen = ++this.gen
    this.phase = 'superseded'
    this.refresh()
    for (let i = 0; i < 1200 && gen === this.gen; i++) {
      await soft(() => this.io.sleep(3000))
      if (gen !== this.gen) return
      await soft(() => this.resync())
      const t = this.state?.turns[turnId]
      if (t && (t.status === 'running' || t.status === 'approval')) continue
      this.connect()
      return
    }
  }

  /** Connect now, or once a turn running in another of this person's Claude Codes ends. Says which. */
  private async takeOver(): Promise<'now' | 'after'> {
    if (this.session && !this.wire) this.wire = new Wire(this.io.fetch, this.session, this.runnerSession)
    await soft(() => this.resync())
    const busy = this.turnRunningElsewhere()
    if (busy) { void this.connectAfter(busy.id); return 'after' }
    this.connect()
    return 'now'
  }

  async resync(): Promise<void> {
    const w = this.wire
    if (!w) return
    const snap = await w.snapshot()
    if (w !== this.wire) return
    this.peopleAt = Date.now()
    this.state = snap.state
    this.me = snap.me
    this.presence = snap.presence
    this.runners = snap.runners
    if (this.session && this.session.spaceName !== snap.state.space.name) {
      this.session = { ...this.session, spaceName: snap.state.space.name }
    }
  }

  async hello(): Promise<void> {
    const w = this.wire
    if (!w) return
    const info = await this.helloInfo()
    const tools = await this.bridgeTools()
    if (w !== this.wire) return
    await w.hello(info, this.active ? [this.active.turnId] : [], tools)
  }

  /**
   * The tools a turn's background session lacks that this interactive Claude Code has
   * (artifacts, which `-p` leaves off): its turns get them through this mod.
   */
  private async bridgeTools(): Promise<RunnerHello['tools']> {
    const all = (await soft(() => this.io.listTools?.() ?? Promise.resolve([]))) ?? []
    const want = new Set<string>(BRIDGED_TOOLS)
    return all.filter((t) => want.has(t.name)).map((t) => ({ name: t.name, description: t.description }))
  }

  /** A turn's session called a bridged tool: make the call here, for the turn this runner runs. */
  private async bridged(m: Extract<RunnerInbound, { kind: 'tool.request' }>): Promise<void> {
    const answer = (text: string, isError?: boolean) => void soft(() => this.wire!.live({ kind: 'tool.result', requestId: m.requestId, text, ...(isError ? { isError: true } : {}) }))
    if (!this.wire) return
    if (this.active?.turnId !== m.turnId) return answer('That shared turn isn’t running here.', true)
    // Claude hands a file it made to everyone in the space.
    if (m.tool === 'share_file') { const [text, isError] = await this.shareFile(m); return answer(text, isError) }
    if (!(BRIDGED_TOOLS as readonly string[]).includes(m.tool) || !this.io.callTool) return answer(`${m.tool} isn’t available here.`, true)
    try {
      const r = await this.io.callTool(m.tool, m.input, m.approved === true)
      answer(r.text, r.isError)
    } catch (err) {
      answer(`${m.tool} failed: ${(err as Error).message}`, true)
    }
  }

  /** Reads a file of this computer's and puts it into the space, from the shared turn running here. */
  private async shareFile(m: Extract<RunnerInbound, { kind: 'tool.request' }>): Promise<[string, boolean?]> {
    const a = this.active
    const t = this.turn(m.turnId)
    const w = a?.wire ?? this.wire
    if (!a || !t || !w || !this.io.readBytes) return ['Sharing a file isn’t available here.', true]
    const raw = typeof m.input.path === 'string' ? m.input.path.trim() : ''
    if (!raw) return ['Give the file’s path.', true]
    // A colon past the drive names a hidden stream (Windows), not the file.
    if (raw.replace(/^[a-z]:/i, '').includes(':')) return ['That path names a hidden stream: share the file itself.', true]
    const given = /^([a-z]:)?[\\/]/i.test(raw) ? raw : `${this.cwd}/${raw}`
    // Where it really lands (links followed, `..` folded), and the folder resolved the same way:
    // the check and the read are on that one path, so a link or a spelling can't step outside.
    const real = await soft(() => this.io.realPath!(given))
    const root = await soft(() => this.io.realPath!(this.cwd))
    if (!this.io.realPath || !real || !root) return [`Couldn’t find ${raw} on this computer.`, true]
    // A file outside the project, or a secret, only with its owner's say: this very call allowed
    // in Multiplayer, or that kind shared for the space (docs/PRIVACY.md).
    const src = privateSource('mcp__multiplayer__share_file', { path: real.replace(/[. ]+$/, '') }, root)
    if (src && !m.approved && !this.state?.sharing?.[this.me]?.[src.id]) return [`${raw} is one of ${src.label}: it isn't shared from here unless its owner allows it in the space. Share a file in the project instead, or ask them.`, true]
    const name = (typeof m.input.name === 'string' && m.input.name.trim()) || raw.split(/[\\/]/).pop() || 'file'
    let base64: string
    try { base64 = await this.io.readBytes(real) } catch (err) { return [`Couldn’t read ${raw}: ${(err as Error).message}`, true] }
    const size = Math.floor((base64.length * 3) / 4)
    if (size > FILE_MAX_BYTES) return [`${name} is ${(size / 1048576).toFixed(1)} MB; a shared file can be up to ${FILE_MAX_BYTES / 1048576} MB.`, true]
    try {
      const f = await w.upload({ branchId: t.branchId, name, turnId: t.id, from: 'claude' }, base64, fileType(name))
      return [`Shared ${f.name} (${fmtSize(f.size)}) with everyone in the space: they can download it under your answer. Say in your answer what it is.`]
    } catch (err) {
      return [`Couldn’t share ${name}: ${(err as Error).message}`, true]
    }
  }

  /**
   * The files of this conversation (attached to its prompts, shared from its answers), saved in
   * `.multiplayer/files/` in this folder (kept out of git) so Claude reads them with its own tools:
   * images and PDFs as Claude Code's Read shows them, documents with its skills. Fetched once each,
   * with a short link (curl), since the engine writes only text. The note says where each one is.
   */
  private async fetchFiles(s: SpaceState, t: Turn, w: Wire): Promise<string> {
    const ids: string[] = []
    for (const x of [...historyTurns(s, t.branchId).filter((h) => h.id !== t.id), t]) {
      for (const p of x.parts) for (const id of p.files ?? []) if (!ids.includes(id)) ids.push(id)
      for (const id of x.files ?? []) if (!ids.includes(id)) ids.push(id)
    }
    const known = ids.map((id) => s.files?.[id]).filter((f): f is NonNullable<typeof f> => !!f)
    if (!known.length) return ''
    const dir = `${this.cwd}/.multiplayer`
    await soft(() => this.io.write(`${dir}/.gitignore`, '# Multiplayer keeps files people share here. Not for git.\n*\n'))
    const lines: string[] = []
    for (const f of known.slice(-50)) {
      const safe = f.name.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
      const rel = `.multiplayer/files/${f.id}/${safe}`
      const who = f.from === 'claude' ? `shared by Claude in ${memberName(s, f.by)}'s turn` : `from ${memberName(s, f.by)}`
      const have = (await soft(() => this.io.list(`${dir}/files/${f.id}`)))?.some((e) => e.name === safe)
      if (!have) {
        const url = await soft(() => w.fileLink(f.id))
        const r = url ? await soft(() => this.io.run(['curl', '-sSfL', '--create-dirs', '--max-time', '120', '-o', `${dir}/files/${f.id}/${safe}`, url], { timeoutMs: 130_000 })) : undefined
        if (!r || r.exitCode !== 0) { lines.push(`- ${f.name} (${who}): couldn't be fetched to this computer`); continue }
      }
      lines.push(`- ${f.name} (${who}, ${fmtSize(f.size)}): ${rel}`)
    }
    return `\n\n[Multiplayer] Files in this conversation, saved in this folder. Read the ones the prompt is about with your tools (Read shows images and PDFs; use your skills for Word, Excel and PowerPoint):\n${lines.join('\n')}`
  }

  async helloInfo(): Promise<RunnerHello['info']> {
    const io = this.io
    const version = await soft(() => io.version())
    const model = await soft(() => io.model())
    const cwd = (await soft(() => io.cwd())) ?? this.cwd
    const git = await soft(() => G.gitInfo(io))
    const sandbox = await soft(() => io.sandbox())
    const focus = this.lastBranchId && this.state?.branches[this.lastBranchId]
      ? { conversationId: this.state.branches[this.lastBranchId].conversationId, branchId: this.lastBranchId }
      : undefined
    return { kind: 'claude-code', version, model, cwd, git, sandbox, paused: this.paused, focus, ...(this.heldBusy ? { busy: true } : {}) }
  }

  /** Tells the server whether a shared turn is waiting for the person's own prompt here. */
  private holdBusy(on: boolean): void {
    if (this.heldBusy === on) return
    this.heldBusy = on
    if (this.phase === 'online') void soft(() => this.hello())
  }

  /** One long-poll: folds the events in, routes the inbox, reacts. */
  async pollOnce(waitSeconds: number): Promise<'ok' | 'superseded'> {
    if (!this.wire || !this.state) throw new Error('not connected')
    const w = this.wire
    const r = await w.poll(this.state.seq, waitSeconds)
    // Signed in again meanwhile (here or to another space): this answer is the old connection's.
    if (w !== this.wire || !this.state) return 'ok'
    if (r.superseded) return 'superseded'
    // The server restarted and doesn't know this runner: say hello again (with any turn it runs).
    if (r.hello) await soft(() => this.hello())
    if (r.resync) {
      // Twice in a row with nothing new: a newer runner session took over this member.
      this.resyncStreak++
      if (this.resyncStreak >= 2) return 'superseded'
      await this.resync()
      this.inbox(r.live)
      this.react([])
      return 'ok'
    }
    this.resyncStreak = 0
    const fresh: SpaceEvent[] = []
    for (const e of r.events) {
      if (e.seq > this.state.seq) {
        this.state = apply(this.state, e)
        fresh.push(e)
      }
    }
    if (r.seq > this.state.seq) this.state = { ...this.state, seq: r.seq }
    this.inbox(r.live)
    this.react(fresh)
    return 'ok'
  }

  private inbox(live: RunnerInbound[]): void {
    for (const m of live) {
      if (m.kind === 'approval.request') this.onApproval(m)
      else if (m.kind === 'approval.cleared') this.onApprovalCleared(m.turnId, m.requestId)
      else if (m.kind === 'files.request') void this.files(m.requestId, m.action)
      else if (m.kind === 'local.request') void this.local(m.requestId, m.action)
      else if (m.kind === 'tool.request') void this.bridged(m)
      else if (m.kind === 'pause' || m.kind === 'resume') void this.setPaused(m.kind === 'pause')
    }
  }

  /** Paused from the web app or with /multiplayer pause: finish the turn in hand, pick up nothing new. */
  private async setPaused(paused: boolean): Promise<void> {
    if (this.paused === paused) return
    this.paused = paused
    await soft(() => this.io.storeSet(STORE_PAUSED, paused))
    this.io.toast(paused ? 'Multiplayer: paused from the web app. No new turns are picked up here.' : 'Multiplayer: resumed. Picking up your turns here.')
    await soft(() => this.hello())
    if (!paused) this.pickUp()
    this.refresh()
  }

  private react(events: SpaceEvent[]): void {
    for (const e of events) {
      if (e.type === 'member.updated' && e.memberId === this.me && e.patch.limit) {
        this.io.toast('Multiplayer: your plan’s limit was reached; your turns go back to the draft until it resets.')
      }
    }
    this.watchActive()
    this.pruneQueue()
    this.pickUp()
    this.refresh()
  }

  // ============================================================ picking up

  turn(id: string): Turn | undefined {
    return this.state?.turns[id]
  }

  private mine(t: Turn | undefined): t is Turn {
    return !!t && t.runnerId === this.me && t.status === 'requested'
  }

  private drop(turnId: string): void {
    this.handling.delete(turnId)
    this.refresh()
  }

  private label(t: Turn): string {
    return this.state ? fmt.turnLabel(this.state, t, this.me) : 'a shared turn'
  }

  pickUp(): void {
    if (!this.state || this.paused || this.phase !== 'online') return
    const now = Date.now()
    const ready = Object.values(this.state.turns)
      .filter((t) => this.mine(t) && !this.handling.has(t.id) && (this.cooldown.get(t.id) ?? 0) <= now)
      .sort((a, b) => a.requestedAt - b.requestedAt)
    for (const t of ready) {
      this.handling.add(t.id)
      void this.prepare(t.id).catch((err: Error) => {
        this.io.log(`multiplayer: could not pick up a turn: ${err.message}`, true)
        this.drop(t.id)
      })
    }
  }

  private async prepare(turnId: string): Promise<void> {
    const io = this.io
    let t = this.turn(turnId)
    if (!this.mine(t) || !this.wire) return this.drop(turnId)
    const label = this.label(t)

    const limit = await this.limitNow(true)
    if (limit) {
      await this.wire.command({ type: 'runner.fail', turnId, failure: { reason: 'limit', resetsAt: limit.resetsAt, detail: limit.detail } })
      io.toast(`Multiplayer: limit reached. ${label} went back to the draft${limit.resetsAt ? `; your limit resets ${when(limit.resetsAt)}` : ''}.`)
      return this.drop(turnId)
    }

    const problem = await this.childProblem()
    if (problem) {
      await this.wire.command({ type: 'runner.fail', turnId, failure: problem })
      io.toast(`Multiplayer: ${label} went back to the draft. ${problem.reason === 'not-signed-in' ? SIGN_IN_HELP : problem.detail}`)
      return this.drop(turnId)
    }
    t = this.turn(turnId)
    if (!this.mine(t)) return this.drop(turnId)

    const authors = new Set(fmt.judgedParts(t).map((i) => t!.parts[i].memberId))
    if (!t.checked && authors.size > 1 && (t.mode === 'normal' || t.mode === 'view-first')) {
      const verdict = await this.judge(t)
      t = this.turn(turnId)
      if (!this.mine(t)) return this.drop(turnId)
      if (verdict) {
        const s = this.state!
        const who = [...new Set(verdict.conflicting.map((i) => t!.parts[i].memberId))]
        await this.wire.command({
          type: 'runner.check',
          turnId,
          conflict: { ...verdict, options: who.map((m) => ({ key: m, label: `${memberName(s, m)}’s`, memberId: m })) },
        })
        return this.drop(turnId)
      }
    }

    // The branch's pinned model goes to its session as --model; first check this Claude Code can use it.
    const pin = this.state?.branches[t.branchId]?.model
    if (pin?.name && !(await this.modelAvailable(pin.name))) {
      await this.wire.command({ type: 'runner.fail', turnId, failure: { reason: 'model-unavailable', detail: `${pin.name} isn’t available in ${memberName(this.state!, this.me)}’s Claude Code.` } })
      io.toast(`Multiplayer: ${label} asks for ${pin.name}, which this Claude Code can’t use; it went back to the draft.`)
      return this.drop(turnId)
    }
    if (!this.mine(this.turn(turnId))) return this.drop(turnId)
    this.queue.push({ kind: 'shared', turnId })
    void this.pump()
  }

  /**
   * Whether this machine can start a branch session: Claude Code's own program, signed in the
   * way a session it starts can use (`claude auth status` sees what that session would).
   */
  async childProblem(): Promise<TurnFailure | null> {
    if (this.childOk) return null
    const exe = await this.findProgram()
    if (!exe) return { reason: 'error', detail: NO_PROGRAM }
    const r = await soft(() => this.io.run([exe, 'auth', 'status'], { timeoutMs: 20_000 }))
    let status: { loggedIn?: unknown } | undefined
    try { status = JSON.parse(r?.stdout ?? '') as { loggedIn?: unknown } } catch { status = undefined }
    if (status?.loggedIn === false) return { reason: 'not-signed-in', detail: 'Claude Code isn’t signed in for shared turns.' }
    // Signed in, or the check couldn't say: the turn's own session reports anything else.
    if (status?.loggedIn === true) this.childOk = true
    return null
  }

  /**
   * The Claude Code program this session runs, by its absolute path: never a bare name, which
   * Windows would look for in the project folder first. CLAUDE_CODE_EXECPATH when Claude Code
   * set it (it does under -p); else the parent of a process this mod starts, which is Claude
   * Code itself; else `claude` on PATH, looked up from a folder the project can't put one in.
   * The system's own tools run by absolute path. Found once a session.
   */
  private async findProgram(): Promise<string | undefined> {
    if (this.program) return this.program
    const io = this.io
    const out = async (argv: string[], cwd: string) => (await soft(() => io.run(argv, { cwd, timeoutMs: 20_000 })))?.stdout ?? ''
    const pick = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => isClaudeProgram(l))
    let p = await soft(() => io.execPath())
    if (!isClaudeProgram(p)) {
      const root = (await soft(() => io.systemRoot()))?.replace(/\\+$/, '')
      if (root && /^[A-Za-z]:\\[^"%]*$/.test(root)) {
        p = pick(await out([`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, '-NoProfile', '-NonInteractive', '-Command', PARENT_PS], root))
          ?? pick(await out([`${root}\\System32\\where.exe`, 'claude'], root))
      } else {
        p = pick(await out(['/bin/sh', '-c', PARENT_SH], '/'))
      }
    }
    if (isClaudeProgram(p)) this.program = p
    return this.program
  }

  private async judge(t: Turn): Promise<fmt.Verdict> {
    if (!this.state) return null
    const r = await soft(() => this.io.complete({ model: 'haiku', prompt: fmt.judgePrompt(this.state!, t), maxTokens: 300, timeoutMs: 30_000 }))
    if (!r || !r.isAnswered) return null
    return fmt.parseVerdict(r.text, t)
  }

  private async modelAvailable(name: string): Promise<boolean> {
    const known = this.modelOk.get(name)
    if (known !== undefined) return known
    let ok = true
    try {
      const r = await this.io.complete({ model: name, prompt: 'Reply with OK.', maxTokens: 1, timeoutMs: 30_000 })
      if (!r.isAnswered && r.reason === 'api-error' && (r.error === 'model_not_found' || r.status === 404)) ok = false
    } catch {
      ok = false // the engine refused to send it: a blocked or unknown model
    }
    this.modelOk.set(name, ok)
    return ok
  }

  /** A rate-limit window at 100%: when it resets and which. */
  async limitNow(fresh = false): Promise<{ resetsAt?: number; detail: string } | null> {
    if (fresh || !this.rateLimits.length) {
      const u = await soft(() => this.io.usage())
      if (u && Array.isArray(u.rateLimits)) this.rateLimits = u.rateLimits
    }
    const hit = this.rateLimits.filter((l) => l.percentUsed >= 100)
    if (!hit.length) return null
    const resets = hit.map((l) => (l.resetsAt ? Date.parse(l.resetsAt) : NaN)).filter((n) => Number.isFinite(n))
    const kinds = hit.map((l) => l.kind.replace(/_/g, '-')).join(', ')
    return { resetsAt: resets.length ? Math.max(...resets) : undefined, detail: `Plan limit reached (${kinds}).` }
  }

  private pruneQueue(): void {
    this.queue = this.queue.filter((j) => {
      if (j.kind !== 'shared') return true
      if (this.mine(this.turn(j.turnId))) return true
      this.handling.delete(j.turnId)
      return false
    })
  }

  // ============================================================== running

  /** Submits the next queued job once the session is idle. */
  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.active && !this.combine && this.queue.length) {
        const job = this.queue[0]
        if (this.busy) {
          if (!job.noticed) {
            job.noticed = true
            const t = job.kind === 'shared' ? this.turn(job.turnId) : undefined
            const what = t ? this.label(t) : 'Combining the file changes'
            this.io.toast(`Multiplayer: ${t ? `${what[0].toUpperCase()}${what.slice(1)}` : what} is waiting for you to finish.`)
          }
          if (job.kind === 'shared') this.holdBusy(true)
          break
        }
        this.holdBusy(false)
        this.queue.shift()
        if (job.kind === 'combine') await this.submitCombine(job)
        else await this.runShared(job).catch((err: Error) => this.runFailed(job.turnId, err))
      }
      if (!this.queue.length) this.holdBusy(false)
    } finally {
      this.pumping = false
      this.refresh()
    }
  }

  /** A shared turn threw here: free the queue, and end the turn in its space rather than leave it running there. */
  private runFailed(turnId: string, err: Error): void {
    this.io.log(`multiplayer: a shared turn failed here: ${err.message}`, true)
    const a = this.active
    if (a?.turnId === turnId) {
      this.active = null
      a.kill?.()
      a.settle()
      const w = a.wire
      if (w && !a.stopped) void soft(() => this.finishCommand({ type: 'runner.fail', turnId, failure: { reason: 'error', detail: clip(err.message, 300) } }, w))
    }
    this.drop(turnId)
  }

  blankActive(turnId: string, branchId: string, wire: Wire | null = null, spaceId = ''): Active {
    let settle = () => {}
    const finished = new Promise<void>((r) => { settle = r })
    return {
      turnId, branchId, label: 'a shared turn', mode: 'normal', parts: 0, private: false, model: '',
      live: '', steps: 0, stepText: new Map(), toolSteps: new Map(), current: new Map(), lastDelta: 0, deltaTimer: null,
      stopped: null, wire, spaceId, exited: false, finished, settle,
      kill: null, startHead: null, work0: undefined, touched: new Set(), chain: Promise.resolve(), approvals: new Map(),
    }
  }

  // ===================================================== where the code is

  /** This folder, as the key its WorkEntry list is kept under. */
  private folderKey(): string {
    return folderKeyOf(this.cwd)
  }

  private async workEntries(): Promise<WorkEntry[]> {
    const all = await soft(() => this.io.storeGet(STORE_WORK))
    const list = all && typeof all === 'object' ? (all as Record<string, unknown>)[this.folderKey()] : undefined
    return Array.isArray(list) ? (list as WorkEntry[]) : []
  }

  private async saveWork(list: WorkEntry[]): Promise<void> {
    const all = ((await soft(() => this.io.storeGet(STORE_WORK))) ?? {}) as Record<string, WorkEntry[]>
    const key = this.folderKey()
    // This folder first, newest entries kept; at most 20 folders.
    const next: Record<string, WorkEntry[]> = list.length ? { [key]: list.slice(-100) } : {}
    for (const [k, v] of Object.entries(typeof all === 'object' ? all : {}).filter(([k]) => k !== key).slice(0, 19)) next[k] = v
    await soft(() => this.io.storeSet(STORE_WORK, next))
  }

  /** What the space hears of a turn's changes: a private file (a key, a .env) is counted, never named. */
  private workReport(e: WorkEntry): Omit<TurnWork, 'at'> {
    const named: string[] = []
    let more = 0
    const root = (e.root || this.cwd).replace(/\\/g, '/').replace(/\/+$/, '')
    for (const f of e.files) {
      // Named only where reading it would be: inside this folder (git's paths are the repository's,
      // which may be bigger), not a secret (a key, a .env), and a plain one-line name.
      if (named.length >= WORK_FILES_MAX || f.length > 300 || CONTROL.test(f) || privateSource('Read', { file_path: `${root}/${f}` }, this.cwd)) more++
      else named.push(f)
    }
    const commits = e.commits.slice(0, WORK_COMMITS_MAX).map((c) => ({ sha: c.sha.slice(0, 12), subject: c.subject.replace(CONTROL_ALL, ' ').slice(0, 300) }))
    const pushed = e.pushed && /^[A-Za-z0-9._/-]{1,200}$/.test(e.pushed) ? e.pushed : undefined
    return {
      ...(e.noRepo ? { noRepo: true } : {}),
      ...(named.length ? { uncommitted: named } : {}),
      ...(more ? { more } : {}),
      ...(commits.length ? { commits } : {}),
      ...(pushed && commits.length ? { pushed } : {}),
    }
  }

  /** At a shared turn's end: tell the space what it changed here, and keep it to check again. */
  private async recordWork(a: Active, w: Wire): Promise<void> {
    const start = a.work0
    if (start === undefined) return
    let e: WorkEntry
    if (start === null) {
      // Not a git repository: the files Claude's steps edited, inside this folder.
      const files = [...new Set([...a.touched].filter((p) => insideFolder(p, this.cwd)).map((p) => fmt.sharePath(p, this.cwd)))]
      if (!files.length) return
      e = { turnId: a.turnId, spaceId: a.spaceId, at: Date.now(), root: this.cwd, files, commits: [], noRepo: true, sent: '' }
    } else {
      const end = await soft(() => G.workEnd(this.io, start))
      if (!end) return
      e = { turnId: a.turnId, spaceId: a.spaceId, at: Date.now(), root: start.root, files: end.uncommitted, commits: end.commits, ...(end.pushed ? { pushed: end.pushed } : {}), sent: '' }
    }
    const report = this.workReport(e)
    if (!report.noRepo && !report.uncommitted && !report.more && !report.commits) return
    const r = await soft(() => w.command({ type: 'runner.work', turnId: a.turnId, work: report }))
    if (r?.ok) e.sent = JSON.stringify(report)
    if (workPending(e) || !e.sent) await this.saveWork([...(await this.workEntries()).filter((x) => x.turnId !== e.turnId), e])
  }

  private lastWorkCheck = 0
  private checkingWork = false

  /**
   * Checks this folder's pending changes again (committed since? pushed?) and tells the space
   * what changed. `force`: now; otherwise at most every three minutes.
   */
  async recheckWork(force: boolean): Promise<void> {
    const w = this.wire
    const spaceId = this.session?.spaceId
    if (!w || !spaceId || this.checkingWork || (!force && Date.now() - this.lastWorkCheck < 180_000)) return
    this.checkingWork = true
    this.lastWorkCheck = Date.now()
    try {
      const all = await this.workEntries()
      if (!all.length) return
      const keep: WorkEntry[] = []
      for (const e of all) {
        // Another space's: checked when this Claude Code is in that space again.
        if (e.spaceId !== spaceId) { keep.push(e); continue }
        // Its turn is gone from the space (or taken over): nothing to tell.
        const t = this.state?.turns[e.turnId]
        if (this.state && (!t || t.runnerId !== this.me)) continue
        if (!e.noRepo) {
          const r = await soft(() => G.workRecheck(this.io, e))
          if (r) { e.files = r.uncommitted; e.commits = r.commits; if (r.pushed) e.pushed = r.pushed; else delete e.pushed }
        }
        const report = this.workReport(e)
        const said = JSON.stringify(report)
        if (said !== e.sent) {
          const r = await soft(() => w.command({ type: 'runner.work', turnId: e.turnId, work: report }))
          if (r?.ok) e.sent = said
          else if (r && !r.ok) continue
        }
        if (workPending(e) || e.sent !== said) keep.push(e)
      }
      await this.saveWork(keep)
    } finally {
      this.checkingWork = false
    }
  }

  /** What this folder holds, for "Where the code is". */
  private async folderView(s: SpaceState, branchId: string, noRepo: boolean): Promise<FolderView> {
    const spaceId = this.session?.spaceId
    const here = (await this.workEntries()).filter((e) => e.spaceId === spaceId).map((e) => e.turnId)
    if (noRepo) return { here, has: [], noRepo: true }
    // The newest commit each earlier turn names, looked for in this checkout.
    const named = historyTurns(s, branchId).filter((t) => t.work?.commits?.length && !here.includes(t.id))
    const shas = [...new Set(named.map((t) => t.work!.commits![0].sha))].slice(-40)
    const since = Math.min(Date.now(), ...named.map((t) => t.startedAt ?? t.requestedAt))
    const has = shas.length ? (await soft(() => G.commitsHere(this.io, shas, since))) ?? [] : []
    const branch = shas.length ? await soft(() => G.currentBranch(this.io)) : undefined
    return { here, has, ...(branch && branch !== 'HEAD' ? { branch } : {}) }
  }

  // ======================================================= branch sessions

  /**
   * This folder's branch sessions. Claude Code keeps a session under the folder it ran in, so
   * the same space opened from another folder (or computer) has sessions of its own there; turns
   * run elsewhere reach them as notes, as anyone else's do.
   */
  private async branchSessions(): Promise<Record<string, BranchSession>> {
    const byFolder = await soft(() => this.io.storeGet(STORE_BRANCHES_BY_FOLDER))
    const mine = byFolder && typeof byFolder === 'object' ? (byFolder as Record<string, unknown>)[this.folderKey()] : undefined
    if (mine && typeof mine === 'object') return mine as Record<string, BranchSession>
    // Kept before sessions were per folder: only the ones whose files are in this folder.
    const old = await soft(() => this.io.storeGet(STORE_BRANCHES))
    if (!old || typeof old !== 'object') return {}
    const dir = await this.sessionsDir()
    const files = new Set(((await soft(() => this.io.list(dir))) ?? []).map((f) => f.name))
    const out: Record<string, BranchSession> = {}
    for (const [k, v] of Object.entries(old as Record<string, BranchSession>)) if (v?.id && files.has(`${v.id}.jsonl`)) out[k] = v
    return out
  }

  private async saveBranchSession(branchId: string, bs: BranchSession, spaceId = this.session?.spaceId): Promise<void> {
    if (!spaceId) return
    const all = await this.branchSessions()
    const key = `${spaceId}:${branchId}`
    // Newest first, so the oldest go when there are too many.
    const next: Record<string, BranchSession> = { [key]: bs }
    for (const [k, v] of Object.entries(all).filter(([k]) => k !== key).slice(0, 199)) next[k] = v
    const byFolder = ((await soft(() => this.io.storeGet(STORE_BRANCHES_BY_FOLDER))) ?? {}) as Record<string, Record<string, BranchSession>>
    const here = this.folderKey()
    const out: Record<string, Record<string, BranchSession>> = { [here]: next }
    for (const [k, v] of Object.entries(typeof byFolder === 'object' ? byFolder : {}).filter(([k]) => k !== here).slice(0, 19)) out[k] = v
    await soft(() => this.io.storeSet(STORE_BRANCHES_BY_FOLDER, out))
  }

  /**
   * Where a turn's session comes from, as Claude Code would have it: the branch's own
   * session resumed; else its parent's forked at the branch's fork point (the latest
   * turn up to there that the parent's session ran here, the rest given as notes); else new.
   */
  private sessionPlan(s: SpaceState, b: Branch, all: Record<string, BranchSession>, spaceId: string): { plan: SessionPlan; held: BranchSession } {
    const key = (id: string) => `${spaceId}:${id}`
    const own = all[key(b.id)]
    if (own && !own.rewind) return { plan: { kind: 'resume', id: own.id }, held: own }
    // The session's last turn isn't in the shared history: carry on from the turn before it.
    const back = own?.through ? own.at[own.through] : undefined
    if (own && back) return { plan: { kind: 'fork', from: own.id, at: back }, held: { id: '', through: own.through, at: own.at, state: own.state } }
    const parent = b.parentId ? s.branches[b.parentId] : undefined
    const ps = parent ? all[key(parent.id)] : undefined
    if (parent && ps) {
      const hist = historyTurns(s, parent.id)
      // An edit leaves the edited turn out: the branch starts just before it.
      const point = b.editOf ? hist[hist.findIndex((t) => t.id === b.editOf) - 1]?.id : b.forkTurnId
      const upTo = point ? hist.slice(0, hist.findIndex((t) => t.id === point) + 1) : []
      for (let i = upTo.length - 1; i >= 0; i--) {
        const uuid = ps.at[upTo[i].id]
        if (!uuid) continue
        const at: Record<string, string> = {}
        for (const t of upTo.slice(0, i + 1)) if (ps.at[t.id]) at[t.id] = ps.at[t.id]
        return { plan: { kind: 'fork', from: ps.id, at: uuid }, held: { id: '', through: upTo[i].id, at, state: ps.state } }
      }
    }
    const id = newSessionId()
    return { plan: { kind: 'new', id }, held: { id, through: null, at: {} } }
  }

  // ============================================================== running

  private async runShared(job: Extract<Job, { kind: 'shared' }>): Promise<void> {
    const io = this.io
    let t = this.turn(job.turnId)
    if (!this.mine(t) || !this.wire || !this.state || !this.session) return this.drop(job.turnId)
    // The space as it is now: the turn stays with it, whatever this Claude Code signs in to next.
    const w = this.wire
    const sess = this.session
    const room = this.room
    const s0 = this.state
    const branch = s0.branches[t.branchId]
    const exe = await this.findProgram()
    if (!exe) {
      await w.command({ type: 'runner.fail', turnId: t.id, failure: { reason: 'error', detail: NO_PROGRAM } })
      return this.drop(t.id)
    }
    const started = await w.command({ type: 'runner.start', turnId: t.id, model: branch?.model.name || undefined })
    const token = (started as CommandResponse & { turnToken?: string }).turnToken
    if (room !== this.room) {
      // It moved to another space (or out of this one) while the turn was starting.
      if (started.ok) await soft(() => w.command({ type: 'runner.fail', turnId: t!.id, failure: { reason: 'error', detail: this.leftWhy } }))
      return this.drop(t.id)
    }
    if (!started.ok || !token || !branch) {
      this.cooldown.set(t.id, Date.now() + 15_000)
      io.log(`multiplayer: could not start ${this.label(t)}: ${started.error ?? 'no turn token'}`, true)
      return this.drop(t.id)
    }
    t = this.turn(t.id) ?? t
    // Signed in to the same space again meanwhile, its state may be on its way back.
    const s = this.state ?? s0
    const a = this.blankActive(t.id, t.branchId, w, sess.spaceId)
    Object.assign(a, { label: this.label(t), mode: t.mode, parts: t.parts.length, private: !!t.private, model: branch.model.name })
    this.active = a
    this.lastBranchId = t.branchId
    await this.saveMemo()
    a.startHead = (await soft(() => G.head(io))) ?? null
    // What the folder holds before Claude starts, so only this turn's changes are reported.
    a.work0 = await soft(() => G.workStart(io))
    // Earlier turns' changes here, checked again (pushed since?), and what this folder has of others'.
    await this.recheckWork(true)
    const folder = await this.folderView(s, t.branchId, a.work0 === null)

    // A recap is a one-off private session. A side question (Claude Code's /btw, for a branch) runs
    // in a throwaway fork of the asker's session of the branch: the same instructions and tools, so it
    // reads the branch from the prompt cache. Neither is kept.
    const oneOff = isOneOff(t)
    const aside = t.mode === 'aside'
    let { plan, held } = t.mode === 'recap' ? { plan: { kind: 'new', id: newSessionId() } as SessionPlan, held: { id: '', through: null, at: {} } as BranchSession } : this.sessionPlan(s, branch, await this.branchSessions(), sess.spaceId)
    if (aside && plan.kind === 'resume') plan = { kind: 'fork', from: plan.id }
    const st = buildSessionTurn(s, t, { heldThrough: held.through, lastState: held.state, folder })
    const conv = s.conversations[branch.conversationId]
    const name = `Multiplayer · ${s.space.name} · ${isMain(s, branch.id) ? conv?.title ?? 'Main' : branch.name}`
    // A private lane or recap is the person's own: their own setup, whatever the space says. A side
    // question on a shared branch is a fork of the shared session, so it keeps that session's setup.
    const personal = t.private && !(aside && !branch.private)
    const projectSetup = !personal && !!s.space.policy.projectSetup
    // Every turn starts in a mode of its own, so nothing an earlier turn left (plan mode, edits
    // accepted for that turn) carries over: plan mode for a plan turn; otherwise the person's own
    // default (default, acceptEdits or auto; never bypass), or plain default where the project's
    // setup is used.
    const settings = (await soft(() => io.userSettings())) as { permissions?: { defaultMode?: unknown } } | undefined
    const ownMode = settings?.permissions?.defaultMode
    const baseMode = !projectSetup && (ownMode === 'acceptEdits' || ownMode === 'auto') ? ownMode : 'default' as const
    const permissionMode = t.plan ? 'plan' as const : baseMode
    const argv = [exe, ...childArgs({
      plan, permissionMode, model: branch.model.name || undefined, effort: branch.model.effort, system: st.system, name,
      mcpUrl: `${normalizeServer(sess.server)}/mcp/turn/${sess.spaceId}/${token}`,
      sites: personal ? [] : s.space.policy.sites, pluginDir: io.pluginRoot || undefined, persist: !oneOff, projectSetup,
      keep: projectSetup ? keptUserSettings(await soft(() => io.userSettings())) : undefined,
    })]
    const env: Record<string, string> = {
      MULTIPLAYER_CHILD: personal ? 'private' : 'shared',
      // A turn others read: its session checks what its person shares here before a private call.
      ...(t.private ? {} : { MULTIPLAYER_SHARED_URL: `${normalizeServer(sess.server)}/mcp/turn/${sess.spaceId}/${token}/shared` }),
      // Questions wait for a person; sessions this mod starts keep their transcripts.
      MCP_TOOL_TIMEOUT: '900000',
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      // The project's setup leaves out the person's claude.ai connectors too. Otherwise, the
      // skills they enabled on claude.ai, as their own Claude Code has them: a `-p` run only
      // waits for that list when asked to. (Their own setup's, never forced into the project's.)
      ...(projectSetup ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : { CLAUDE_CODE_SYNC_SKILLS: '1' }),
    }
    io.toast(`Multiplayer: running ${a.label} for you.`)
    this.refresh()

    const reader = new StreamReader()
    let sessionId = plan.kind === 'fork' ? '' : plan.id
    let lastUuid: string | undefined
    let result: Extract<RunEvent, { kind: 'result' }> | undefined
    let rate: Extract<RunEvent, { kind: 'rate' }> | undefined
    let errText = ''
    try {
      // Files people attached or Claude shared in this conversation, fetched into the folder to read.
      const files = await this.fetchFiles(s, t, w)
      const it = io.spawn({ argv, cwd: this.cwd, env, input: st.message + files })[Symbol.asyncIterator]()
      a.kill = () => { void soft(() => it.return?.()) }
      if (a.stopped) a.kill()
      for (;;) {
        const n = await it.next()
        if (n.done) break
        if (n.value.stream === 'stderr') { errText = (errText + n.value.text).slice(-4000); continue }
        for (const ev of reader.push(n.value.text)) {
          if (ev.kind === 'init') { if (ev.sessionId) sessionId = ev.sessionId; if (ev.model) a.model = ev.model }
          else if (ev.kind === 'text') { a.live = ev.text; this.scheduleDelta(a) }
          else if (ev.kind === 'tool') this.beginStep(a, ev.id, ev.name, ev.input, ev.parent)
          else if (ev.kind === 'tool-result') this.endStep(a, ev.id, ev.isError ? (isRefusal(ev.text) ? 'denied' : 'fail') : 'done')
          else if (ev.kind === 'message') { lastUuid = ev.uuid; if (ev.model) a.model = ev.model }
          else if (ev.kind === 'rate') { if (ev.status === 'rejected') rate = ev }
          else if (ev.kind === 'result') result = ev
        }
        if (a.stopped) break
      }
    } catch (err) {
      errText = `${errText}\n${(err as Error).message}`
    }
    a.kill = null
    a.exited = true

    // The session keeps a turn that ended with its answer. Any other ending (failed, taken over,
    // or stopped: a stopped process leaves "No response requested." where its partial answer
    // was) is set aside, and the next turn hears it as everyone else's sessions do, word for word.
    const kept = !a.stopped && !!result && !result.isError
    if (!oneOff && sessionId) {
      if (kept) await this.saveBranchSession(t.branchId, { id: sessionId, through: t.id, at: lastUuid ? { ...held.at, [t.id]: lastUuid } : held.at, state: st.state }, a.spaceId)
      else if (plan.kind === 'resume') await this.saveBranchSession(t.branchId, { ...held, rewind: true }, a.spaceId)
      // A new or forked session that didn't keep its turn is simply not used again.
    }
    await this.finishShared(a, reader.text, result, rate, errText, reader.thinking)
  }

  private async finishShared(a: Active, text: string, result: Extract<RunEvent, { kind: 'result' }> | undefined, rate: Extract<RunEvent, { kind: 'rate' }> | undefined, errText: string, thinking = ''): Promise<void> {
    const io = this.io
    if (this.active === a) this.active = null
    this.ending.add(a)
    try {
      a.deltaTimer?.cancel()
      a.approvals.clear()
      await this.saveMemo()
      await a.chain
      const w = a.wire ?? this.wire
      this.handling.delete(a.turnId)
      const model = a.model || undefined
      const answer = (text || result?.text || '').trim()
      if (!w || a.stopped === 'takeover' || a.stopped === 'gone' || a.stopped === 'left') return
      if (a.stopped === 'server') {
        await this.finishCommand({ type: 'runner.done', turnId: a.turnId, text: answer, model }, w)
      } else if (result && !result.isError) {
        const replies = a.mode === 'reveal' ? parseReplies(answer, a.parts) : undefined
        await this.finishCommand({ type: 'runner.done', turnId: a.turnId, text: answer, usage: usageOf(result.usage), model, replies, ...(thinking.trim() ? { thinking: thinking.slice(0, 100_000) } : {}) }, w)
      } else {
        const failure = await this.classifyFailure(result, rate, errText)
        await this.finishCommand({ type: 'runner.fail', turnId: a.turnId, failure }, w)
        if (failure.reason === 'limit') io.toast(`Multiplayer: limit reached while running ${a.label}${failure.resetsAt ? `; it resets ${when(failure.resetsAt)}` : ''}.`)
      }
      // Stopped, failed or done: whatever it changed in this folder is there, so say so. And
      // earlier turns' changes may have just been committed or pushed by this one.
      await this.recordWork(a, w)
      await this.recheckWork(true)
      await this.reportPush(a)
    } finally {
      this.ending.delete(a)
      a.settle()
      this.refresh()
      void this.pump()
    }
  }

  /** Why a branch session ended its turn without an answer. */
  private async classifyFailure(result: Extract<RunEvent, { kind: 'result' }> | undefined, rate: Extract<RunEvent, { kind: 'rate' }> | undefined, errText: string): Promise<TurnFailure> {
    const said = [result?.text ?? '', ...(result?.errors ?? []), errText].join('\n')
    const limit = await this.limitNow(true)
    if (rate || limit || /usage limit|rate limit|limit reached|quota/i.test(said)) {
      return { reason: 'limit', resetsAt: rate?.resetsAt ?? limit?.resetsAt, detail: limit?.detail ?? 'Plan limit reached.' }
    }
    if (/model.{0,40}(not found|not_found|does not exist|isn.t available|invalid)/i.test(said)) return { reason: 'model-unavailable', detail: clip(said.trim(), 300) }
    if (/not logged in|please run \/login|authentication_failed|invalid api key|oauth token (has )?expired/i.test(said)) {
      this.childOk = false
      this.io.toast(`Multiplayer: ${SIGN_IN_HELP}`)
      return { reason: 'not-signed-in', detail: 'Claude Code isn’t signed in for shared turns.' }
    }
    return { reason: 'error', detail: clip(said.trim() || 'Claude Code ended the turn without an answer.', 300) }
  }

  private async reportPush(a: Active): Promise<void> {
    const p = await soft(() => G.pushedSince(this.io, a.startHead, a.work0))
    const w = a.wire ?? this.wire
    if (!p || !w) return
    const n = p.commits.length
    await w.command({ type: 'runner.pushed', push: { branchId: a.branchId, branch: p.branch, commits: p.commits, summary: `${n} commit${n === 1 ? '' : 's'} pushed to ${p.branch}` } })
  }

  /** turn.start on this session's main loop: the person's own turn, or the combine we submitted. */
  onTurnStart(text: string, turnId: string): void {
    const c = this.combine
    if (c && !c.ccTurnId && matches(text, c.prompt)) {
      c.ccTurnId = turnId
      return
    }
    const sh = this.share
    if (sh && !sh.ccTurnId && matches(text, sh.prompt)) sh.ccTurnId = turnId
    this.busy = true
    this.refresh()
  }

  /** turn.complete on this session's main loop. */
  async onTurnComplete(e: TurnCompleteInput): Promise<void> {
    if (this.combine && this.combine.ccTurnId === e.turnId) await this.finishCombine()
    else this.busy = false
    // The person may have committed or pushed shared turns' changes in their own turn.
    void this.recheckWork(true)
    const sh = this.share
    if (sh && sh.ccTurnId === e.turnId) {
      sh.draft = e.isAborted ? undefined : e.answer.trim() || undefined
      this.io.log(sh.draft
        ? `To share that draft on ${this.where(sh.branchId)}: /multiplayer post. Or post your own words: /multiplayer post <text>.`
        : 'No draft came of it. Try /multiplayer share again, or /multiplayer post <text>.')
    }
    this.refresh()
    await this.pump()
  }

  private scheduleDelta(a: Active): void {
    if (a.deltaTimer || !(a.wire ?? this.wire)) return
    const send = () => {
      a.deltaTimer = null
      if (this.active !== a || a.stopped || !a.live) return
      a.lastDelta = Date.now()
      void (a.wire ?? this.wire)?.live({ kind: 'delta', turnId: a.turnId, text: a.live })
    }
    const wait = 250 - (Date.now() - a.lastDelta)
    if (wait <= 0) send()
    else a.deltaTimer = this.io.after(wait, send)
  }

  /** Sends commands for one turn in order: a step's `run` before its `done`. */
  private chainCmd(a: Active, cmd: Command): Promise<CommandResponse> {
    const p = a.chain.then(() => {
      const w = a.wire ?? this.wire
      return w ? w.command(cmd) : { ok: false, seq: -1 } as CommandResponse
    })
    a.chain = p.catch(() => undefined)
    return p
  }

  /** A tool call in the branch session: a `run` step now; its result's state later. */
  private beginStep(a: Active, id: string, tool: string, input: Record<string, unknown>, parent?: string): void {
    if (this.active !== a || a.stopped) return
    const under = parent ? a.toolSteps.get(parent) : undefined
    // Something private, in a turn others read: the line says what kind of source, nothing of the call.
    const src = this.turn(a.turnId)?.private ? null : privateSource(tool, input, this.cwd)
    const step: Step = { i: a.steps++, tool, text: src ? privateStepText(src) : fmt.describeTool(tool, input, this.cwd, this.home), state: 'run', ...(under !== undefined ? { under } : {}) }
    // The files Claude edits, for a folder git can't tell about.
    const path = EDIT_TOOLS.has(tool) ? (typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '') : ''
    if (path && a.touched.size < 200) a.touched.add(path)
    a.stepText.set(step.i, step)
    a.toolSteps.set(id, step.i)
    a.current.set(tool, step.i)
    void this.chainCmd(a, { type: 'runner.step', turnId: a.turnId, step })
    this.refresh()
  }

  private endStep(a: Active, id: string, state: Step['state']): void {
    const i = a.toolSteps.get(id)
    const step = i === undefined ? undefined : a.stepText.get(i)
    if (!step) return
    if (a.current.get(step.tool) === step.i) a.current.delete(step.tool)
    const done = { ...step, state }
    a.stepText.set(step.i, done)
    if (this.active !== a || a.stopped) return
    void this.chainCmd(a, { type: 'runner.step', turnId: a.turnId, step: done })
  }

  /** After every poll: has the server stopped, failed or handed away the turn we run? */
  private watchActive(): void {
    const a = this.active
    if (!a || a.stopped || !this.state) return
    const t = this.turn(a.turnId)
    let why: Active['stopped'] = null
    if (!t) why = 'gone'
    else if (t.runnerId !== this.me) why = 'takeover'
    else if (t.status === 'stopped') why = 'server'
    else if (!isActive(t)) why = 'gone'
    if (!why) {
      if (t && a.label === 'a shared turn') Object.assign(a, { label: this.label(t), mode: t.mode, parts: t.parts.length })
      return
    }
    a.stopped = why
    a.kill?.()
    const s = this.state
    if (why === 'server' && t?.stoppedBy && t.stoppedBy !== this.me) this.io.toast(`Multiplayer: ${memberName(s, t.stoppedBy)} stopped ${a.label}.`)
    else if (why === 'takeover' && t) this.io.toast(`Multiplayer: ${memberName(s, t.runnerId)} took over ${a.label}.`)
    else if (why === 'gone') this.io.toast(`Multiplayer: ${a.label} ended on the server; stopped it here.`)
  }

  // ============================================================ approvals

  /** The turn's session asked permission (through the server): show it here too, and mark its step. */
  private onApproval(m: Extract<RunnerInbound, { kind: 'approval.request' }>): void {
    const a = this.active
    if (!a || a.turnId !== m.turnId || a.approvals.has(m.requestId)) return
    const i = a.current.get(m.tool)
    a.approvals.set(m.requestId, { requestId: m.requestId, tool: m.tool, title: m.title, always: m.always, questions: m.questions, i })
    const step = i === undefined ? undefined : a.stepText.get(i)
    if (step) void this.chainCmd(a, { type: 'runner.step', turnId: a.turnId, step: { ...step, state: 'wait' } })
    this.io.toast(m.sharing
      ? `Multiplayer: ${a.label} wants ${m.sharing.label}, and everyone in the space reads the answer. Share it? In the web app, or here: /multiplayer allow (once), allow always (for this space), deny.`
      : `Multiplayer: approval needed (${m.title.toLowerCase()}) for ${a.label}. Answer in the web app, or here with /multiplayer allow or /multiplayer deny.`)
    // A turn waits on this person: a notification through their own channel, so they hear it in another window.
    const ask = m.sharing ? `Share ${m.sharing.label} in “${this.state?.space.name ?? 'the space'}”?` : m.questions ? 'Claude asks something in a shared turn.' : m.plan !== undefined ? 'Claude’s plan is ready to approve.' : `Approve: ${m.title}`
    void soft(() => this.io.notify?.(ask, 'Multiplayer'))
    this.refresh()
  }

  private onApprovalCleared(turnId: string, requestId: string): void {
    const a = this.active
    const p = a?.approvals.get(requestId)
    if (!a || a.turnId !== turnId || !p) return
    a.approvals.delete(requestId)
    const step = p.i === undefined ? undefined : a.stepText.get(p.i)
    if (step && step.state === 'run' && !a.stopped) void this.chainCmd(a, { type: 'runner.step', turnId: a.turnId, step })
    this.refresh()
  }

  /** `/multiplayer allow|deny`: answers the oldest open question of the running turn. */
  async answerLocally(decision: Decision): Promise<string> {
    const a = this.active
    const p = a ? [...a.approvals.values()][0] : undefined
    if (!a || !p || !this.wire) return 'No approval is waiting.'
    // Claude's question with options (AskUserQuestion): asked here, as Claude Code itself asks it.
    if (p.questions?.length) {
      if (decision === 'deny') {
        return (await this.wire.live({ kind: 'approval.answer', requestId: p.requestId, decision: 'deny' })) ? `Skipped Claude’s question for ${a.label}.` : 'Couldn’t answer it: it was already answered, or the turn ended.'
      }
      const answers: Record<string, string> = {}
      for (const q of p.questions) {
        const picked = await soft(() => this.io.ask(q.question, { options: q.options.map((o) => o.label), header: q.header || 'Claude asks' }))
        if (!picked?.trim()) return 'Not answered. Answer it in the web app, or run /multiplayer allow again.'
        answers[q.question] = picked.trim()
      }
      if (!(await this.wire.live({ kind: 'approval.answer', requestId: p.requestId, decision: 'allow-once', answers }))) return 'Couldn’t answer it: it was already answered, or the turn ended.'
      return `Answered Claude’s question for ${a.label}.`
    }
    // "Always" covers only what Claude Code's own "don't ask again" would; anything else is allowed once.
    const once = decision === 'allow-always' && !p.always
    if (once) decision = 'allow-once'
    if (!(await this.wire.live({ kind: 'approval.answer', requestId: p.requestId, decision }))) return 'Couldn’t answer it: it was already answered, or the turn ended.'
    if (decision === 'deny') return `Denied: ${p.title.toLowerCase()} for ${a.label}.`
    const how = decision === 'allow-always' ? ` (${p.always!.toLowerCase()})` : once ? ' this once: a step like this can’t be allowed for always' : ''
    return `Allowed: ${p.title.toLowerCase()} for ${a.label}${how}.`
  }

  // ================================================================ files

  async files(requestId: string, action: FilesAction): Promise<void> {
    const io = this.io
    let report: FilesReport
    try {
      if (action.type === 'status') report = await G.filesStatus(io)
      else if (action.type === 'pull') report = await G.filesPull(io)
      else if (action.type === 'resolve') {
        const r = await G.filesResolve(io, action.picks ?? {})
        report = r.report
        if (r.forClaude.length) this.queueCombine(requestId, r.forClaude)
      } else {
        const hunks = await G.conflictHunks(io)
        if (!hunks.length) report = await G.filesStatus(io)
        else {
          this.queueCombine(requestId, hunks)
          report = { state: 'resolving', hunks }
        }
      }
    } catch (err) {
      report = { state: 'error', error: (err as Error).message || 'Could not run git here.' }
    }
    await this.wire?.live({ kind: 'files.report', requestId, report })
  }

  private queueCombine(requestId: string, hunks: NonNullable<FilesReport['hunks']>): void {
    if (this.queue.some((j) => j.kind === 'combine') || this.combine) return
    this.queue.push({ kind: 'combine', requestId, prompt: G.combinePrompt(hunks) })
    void this.pump()
  }

  private async submitCombine(job: Extract<Job, { kind: 'combine' }>): Promise<void> {
    const io = this.io
    this.combine = { requestId: job.requestId, prompt: job.prompt, ccTurnId: null, wire: this.wire }
    io.toast('Multiplayer: asking Claude to combine the conflicting file changes.')
    io.after(0, () => void io.submit(job.prompt, false).then((r) => {
      if (r.drop !== undefined && this.combine?.requestId === job.requestId) this.combine = null
    }, () => { if (this.combine?.requestId === job.requestId) this.combine = null }))
  }

  private async finishCombine(): Promise<void> {
    const c = this.combine
    this.combine = null
    if (!c) return
    const r = await soft(() => G.finishResolve(this.io))
    await (c.wire ?? this.wire)?.live({ kind: 'files.report', requestId: c.requestId, report: r?.report ?? { state: 'error', error: 'Could not check the result.' } })
  }

  // ============================================================ commands

  /** `/multiplayer <args>`: the output text, and whether to open the pane (the hook opens it, as the person asked). */
  async command(args: string): Promise<{ text: string; openPane?: boolean }> {
    const [sub = '', ...rest] = fmt.splitArgs(args)
    const io = this.io
    try {
      switch (sub.toLowerCase()) {
        case '': case 'pane': case 'show':
          if (this.session) await this.refreshPeople(true)
          else await soft(() => this.serverInfo(normalizeServer(this.opts.server)))
          return { text: this.session ? this.statusText() : this.helpText(), openPane: true }
        case 'start': case 'new': return { text: await this.cmdStart(rest) }
        case 'join': return { text: await this.cmdJoin(rest) }
        case 'connect': case 'pair': return { text: await this.cmdConnect(rest) }
        case 'status': {
          if (this.wire) await soft(() => this.resync())
          this.refresh()
          return { text: this.statusText() }
        }
        case 'open': case 'link': {
          if (!this.session) return { text: 'Not signed in to a space. ' + this.helpText() }
          io.log(`Multiplayer web link (keep it to yourself; it signs in as you): ${webLink(this.session)}`)
          return { text: `The web link for “${this.session.spaceName ?? 'your space'}” is shown above (it isn’t sent to Claude) and in the pane.`, openPane: true }
        }
        case 'sharing': {
          if (!this.session || !this.state) return { text: 'Not signed in to a space. ' + this.helpText() }
          const names = Object.values(this.state.sharing?.[this.me] ?? {}).map((x) => x.name)
          return { text: names.length
            ? `You share in “${this.state.space.name}”: ${names.join(', ')}. Stop with /multiplayer unshare <name>, or /multiplayer unshare all.`
            : 'You share nothing of your own in this space. When a shared turn wants something private (your Gmail, a file outside the project), you’re asked first.' }
        }
        case 'unshare': {
          if (!this.session || !this.state || !this.wire) return { text: 'Not signed in to a space. ' + this.helpText() }
          const want = rest.join(' ').trim().toLowerCase()
          const mine = this.state.sharing?.[this.me] ?? {}
          if (!want) return { text: 'Which one? /multiplayer unshare <name>, or all. /multiplayer sharing lists them.' }
          const hit = want === 'all' ? ['*', ''] as const : Object.entries(mine).map(([id, x]) => [id, x.name] as const).find(([id, n]) => n.toLowerCase() === want || id.toLowerCase() === want)
          if (!hit) return { text: `You don’t share “${rest.join(' ')}” here. /multiplayer sharing lists what you do.` }
          if (want === 'all' && !Object.keys(mine).length) return { text: 'You share nothing of your own in this space.' }
          const r = await this.wire.command({ type: 'sharing.set', source: hit[0], name: hit[1], on: false })
          if (!r.ok) return { text: `Couldn’t stop sharing: ${r.error ?? 'try again'}.` }
          return { text: want === 'all' ? 'Stopped sharing everything of yours here. Shared turns ask again first.' : `Stopped sharing ${hit[1]} here. Shared turns ask again first.` }
        }
        case 'pause': {
          this.paused = true
          await soft(() => io.storeSet(STORE_PAUSED, true))
          await soft(() => this.hello())
          this.refresh()
          return { text: this.active ? `Paused. ${this.active.label} finishes first; no new turns are picked up.` : 'Paused: no turns are picked up until /multiplayer resume.' }
        }
        case 'resume': {
          this.paused = false
          await soft(() => io.storeSet(STORE_PAUSED, false))
          if (!this.session) return { text: 'Not signed in to a space. ' + this.helpText() }
          if (this.phase === 'online') {
            await soft(() => this.hello())
            this.pickUp()
            this.refresh()
            return { text: 'Resumed: picking up your turns here.' }
          }
          if ((await this.takeOver()) === 'after') return { text: 'Your other Claude Code is in the middle of a turn of yours. It finishes there, then your turns run here.' }
          return { text: 'Resumed: picking up your turns here.' }
        }
        case 'allow': case 'approve': return { text: await this.answerLocally(rest[0] === 'always' ? 'allow-always' : 'allow-once') }
        case 'deny': return { text: await this.answerLocally('deny') }
        case 'stop': {
          const a = this.active
          if (!a || !this.wire) return { text: 'No shared turn is running here.' }
          const r = await this.wire.command({ type: 'turn.stop', turnId: a.turnId })
          return { text: r.ok ? `Stopping ${a.label}; what Claude wrote so far stays.` : `Couldn’t stop it: ${r.error ?? 'refused'}.` }
        }
        case 'take-home': case 'takehome': return { text: await this.cmdTakeHome() }
        case 'share': return { text: this.cmdShare(rest.join(' ')) }
        case 'post': return { text: await this.cmdPost(rest.join(' ')) }
        case 'login': case 'sign-in': case 'signin': return { text: await this.cmdLogin() }
        case 'import': case 'bring': return { text: await this.cmdImport(rest) }
        case 'logout': case 'sign-out': case 'signout': {
          const server = normalizeServer(this.opts.server)
          const had = this.account
          const name = this.session?.spaceName
          if (this.session) { await this.forgetSession(); this.reset(SIGNED_OUT_MID_TURN) }
          if (had) await this.forgetAccount(server, true)
          if (!had && !name) return { text: 'Not signed in.' }
          return { text: [had ? `Signed this Claude Code out of Multiplayer${had.email ? ` (${had.email})` : ''}.` : '', name ? `Forgot its sign-in to “${name}”; you’re still a member.` : ''].filter(Boolean).join(' ') }
        }
        case 'leave': {
          if (!this.session) return { text: 'Not signed in to a space.' }
          const name = this.session.spaceName ?? 'the space'
          await this.forgetSession()
          this.reset(SIGNED_OUT_MID_TURN)
          return { text: `Forgot this Claude Code’s sign-in to “${name}”. You’re still a member; leave the space from the web app if you mean to.` }
        }
        case 'help':
          await soft(() => this.serverInfo(normalizeServer(this.opts.server)))
          return { text: this.helpText() }
        default: return { text: `Unknown subcommand “${sub}”. ${this.helpText()}` }
      }
    } catch (err) {
      return { text: `Multiplayer: ${(err as Error).message}` }
    }
  }

  /**
   * Forgets the space this runner is in. `leaving` says why, when this Claude Code is going to
   * another space or out of this one: a turn it is running there stops now, its space hears so
   * at once (and that this Claude Code no longer runs turns there), and nothing in the next space
   * waits behind it. Left out (signing in to the same space again), a running turn carries on.
   */
  private reset(leaving?: string): void {
    const old = this.wire
    const was = this.session
    const a = this.active
    this.gen++
    if (leaving !== undefined) {
      this.room++
      this.leftWhy = leaving
      // Still running: stop it. One whose session already ended finishes as it would have, in its own space.
      if (a && !a.stopped && !a.exited) {
        a.stopped = 'left'
        a.kill?.()
        a.deltaTimer?.cancel()
        a.approvals.clear()
      }
      if (a) this.active = null
      if (old && was) {
        const done = this.farewell(old, [...(a ? [a] : []), ...this.ending], leaving)
        const bye = { spaceId: was.spaceId, memberId: was.memberId, done }
        this.leaving = bye
        void done.finally(() => { if (this.leaving === bye) this.leaving = null })
      }
    }
    this.session = null
    this.wire = null
    this.state = null
    this.me = ''
    this.queue = []
    this.heldBusy = false
    this.handling.clear()
    this.phase = 'off'
    this.refresh()
  }

  /** Tells a space this Claude Code is leaving: the turn it stopped there, then goodbye. */
  private async farewell(w: Wire, turns: Active[], detail: string): Promise<void> {
    for (const a of turns) {
      if (a.stopped === 'left') await soft(() => this.chainCmd(a, { type: 'runner.fail', turnId: a.turnId, failure: { reason: 'error', detail } }))
    }
    // A turn still sending how it ended goes first: after the goodbye, the space counts it lost.
    await Promise.race([Promise.all(turns.map((a) => a.finished)), this.io.sleep(15_000)])
    await soft(() => w.bye())
  }

  private helpText(): string {
    // The web app's help page, once the server has said where the web app is.
    const web = this.servers.get(normalizeServer(this.opts.server))?.webUrl
    return [
      'Usage:',
      '  /multiplayer start <space name> [--as <your name>]   start a space; others join with its code',
      '  /multiplayer join <code> [your name]                 join with a code like MC-7Q2X-K4MP',
      '  /multiplayer connect <pairing code>                  sign in as yourself after joining in the browser',
      '  /multiplayer login | logout                          sign this Claude Code in to your account (invite-only servers)',
      '  /multiplayer import [session id]                     bring this Claude Code conversation (or another here) into a space',
      '  /multiplayer sharing | unshare <name|all>             what of yours this space may read (your Gmail, files outside the project)',
      '  /multiplayer status | open | pause | resume | allow | deny | stop | share <what> | post [text] | take-home | leave',
      `Server: ${normalizeServer(this.opts.server)} (change it in /config, Multiplayer › Server URL)${this.account ? ` · signed in${this.account.email ? ` as ${this.account.email}` : ''}` : ''}.`,
      ...(web ? [`Help, setup and updates: ${web.replace(/\/+$/, '')}/help`] : []),
    ].join('\n')
  }

  // ------------------------------------------------------------ accounts

  /** What the server says about itself, asked once per server. */
  private async serverInfo(server: string): Promise<Health> {
    const hit = this.servers.get(server)
    if (hit) return hit
    const h = await health(this.io.fetch, server)
    this.servers.set(server, h)
    return h
  }

  private async accountFor(server: string): Promise<StoredAccount | undefined> {
    const list = (await soft(() => this.io.storeGet(STORE_ACCOUNTS))) as StoredAccount[] | undefined
    return Array.isArray(list) ? list.find((a) => a && a.server === server && typeof a.token === 'string') : undefined
  }

  private async saveAccount(a: StoredAccount): Promise<void> {
    const list = ((await soft(() => this.io.storeGet(STORE_ACCOUNTS))) as StoredAccount[] | undefined) ?? []
    await this.io.storeSet(STORE_ACCOUNTS, [...(Array.isArray(list) ? list : []).filter((x) => x?.server !== a.server), a])
    if (a.server === normalizeServer(this.opts.server)) this.account = a
  }

  /** `revoke`: also tell the server, so the sign-in stops working there too. */
  private async forgetAccount(server: string, revoke = false): Promise<void> {
    const a = await this.accountFor(server)
    if (a && revoke) await logoutAccount(this.io.fetch, server, a.token)
    const list = ((await soft(() => this.io.storeGet(STORE_ACCOUNTS))) as StoredAccount[] | undefined) ?? []
    await soft(() => this.io.storeSet(STORE_ACCOUNTS, (Array.isArray(list) ? list : []).filter((x) => x?.server !== server)))
    if (server === normalizeServer(this.opts.server)) this.account = null
  }

  private async cmdLogin(): Promise<string> {
    const server = normalizeServer(this.opts.server)
    const h = await this.serverInfo(server)
    if (h.signIn !== 'supabase') return `${server} has no sign-in: start or join a space directly with /multiplayer start or /multiplayer join.`
    if (this.account) return `Already signed in${this.account.email ? ` as ${this.account.email}` : ''}. /multiplayer logout signs out.`
    return this.beginLogin(server)
  }

  /**
   * Signing in, like `gh auth login`: the server gives a link and a code; the person opens the
   * link, signed in to the web app, and approves the code. The link goes to the transcript,
   * never to Claude, and nobody types a password here.
   */
  private async beginLogin(server: string): Promise<string> {
    const l = this.login
    if (l && l.server === server && l.expiresAt > Date.now()) {
      this.io.log(`Multiplayer sign-in: open ${l.url} and approve code ${l.userCode}`)
      return `Still waiting for you to approve code ${l.userCode} in the web app (the link is shown above).`
    }
    const d = await startDevice(this.io.fetch, server)
    const gen = ++this.loginGen
    this.login = { ...d, server }
    this.io.log(`Multiplayer sign-in: open ${d.url} and approve code ${d.userCode}`)
    this.io.after(Math.max(2, d.interval || 3) * 1000, () => void this.pollLogin(gen))
    return `Open the link shown above and approve code ${d.userCode} (it works for 10 minutes). This Claude Code signs in by itself once you do.`
  }

  private async pollLogin(gen: number): Promise<void> {
    const l = this.login
    if (!l || gen !== this.loginGen) return
    let r: DevicePoll | undefined
    try { r = await pollDevice(this.io.fetch, l.server, l.deviceCode) } catch { r = undefined }
    if (gen !== this.loginGen) return
    if (r?.status === 'done') {
      this.login = null
      await this.saveAccount({ server: l.server, token: r.token, email: r.email })
      const then = this.afterLogin
      this.afterLogin = null
      this.io.toast(`Multiplayer: signed in${r.email ? ` as ${r.email}` : ''}.${then ? '' : ' Start or join a space with /multiplayer start or /multiplayer join.'}`)
      if (then) {
        const text = await then().catch((err: Error) => `Multiplayer: ${err.message}`)
        // A transcript line is one line: a line break there shows as a stray character.
        this.io.log(text.replace(/\s*\n\s*/g, ' '))
      }
      this.refresh()
      return
    }
    if (r?.status === 'expired' || l.expiresAt < Date.now()) {
      this.login = null
      this.afterLogin = null
      this.io.toast('Multiplayer: the sign-in link expired. Run /multiplayer login again.')
      return
    }
    this.io.after(Math.max(2, l.interval || 3) * 1000, () => void this.pollLogin(gen))
  }

  /**
   * Runs `fn` with this Claude Code's account sign-in when the server needs one. Without it,
   * sign-in starts, and `again` runs once the person approves it.
   */
  private async withAccount(server: string, again: () => Promise<string>, fn: (token: string | undefined) => Promise<string>): Promise<string> {
    const h = await this.serverInfo(server)
    if (h.signIn !== 'supabase') return fn(undefined)
    const ask = async (lead: string) => {
      this.afterLogin = again
      return `${lead} ${await this.beginLogin(server)}`
    }
    const a = await this.accountFor(server)
    if (!a) return ask('This Multiplayer is invite only, so sign in first.')
    try {
      return await fn(a.token)
    } catch (err) {
      // Signed out on the server (logged out elsewhere, or removed): sign in again.
      if (err instanceof HttpError && err.code === 'sign-in') {
        await this.forgetAccount(server)
        return ask('This Claude Code’s sign-in ended.')
      }
      throw err
    }
  }

  private async askName(): Promise<string> {
    const io = this.io
    if (this.opts.name.trim()) return this.opts.name.trim()
    const stored = await soft(() => io.storeGet(STORE_NAME))
    if (typeof stored === 'string' && stored.trim()) return stored.trim()
    const user = (await soft(() => io.userName())) || ''
    const pretty = user ? user[0].toUpperCase() + user.slice(1) : ''
    try {
      const picked = await io.ask('What name should the others in the space see?', { options: pretty ? [pretty, 'Guest'] : ['Guest', 'Host'], header: 'Your name' })
      return picked.trim().slice(0, 40) || pretty || 'Guest'
    } catch {
      return pretty || 'Guest'
    }
  }

  private async signedIn(server: string, s: { spaceId: string; memberId: string; token: string; code: string; name: string }): Promise<StoredSession> {
    const io = this.io
    // The web app may live apart from the server (GitHub Pages): links go there.
    const web = (await soft(() => this.serverInfo(server)))?.webUrl
    const stored: StoredSession = { ...s, server, ...(web && web !== server ? { web } : {}) }
    const was = this.session
    const same = !!was && was.spaceId === s.spaceId && was.memberId === s.memberId && normalizeServer(was.server) === server
    this.reset(same ? undefined : MOVED_MID_TURN)
    this.session = stored
    await this.saveSession(stored)
    this.paused = false
    await soft(() => io.storeSet(STORE_PAUSED, false))
    this.wire = new Wire(io.fetch, stored, this.runnerSession)
    const prev = this.leaving
    if (prev && prev.spaceId === s.spaceId && prev.memberId === s.memberId) await Promise.race([prev.done, io.sleep(20_000)])
    if ((await this.takeOver()) === 'after') io.log('Multiplayer: your other Claude Code is in the middle of a turn of yours. It finishes there, then your turns run here.')
    io.log(`Multiplayer web link (keep it to yourself; it signs in as you): ${webLink(stored)}`)
    return this.session ?? stored
  }

  private async cmdStart(rest: string[]): Promise<string> {
    const at = rest.findIndex((x) => x === '--as')
    const asName = at >= 0 ? rest.slice(at + 1).join(' ').trim() : ''
    const spaceName = (at >= 0 ? rest.slice(0, at) : rest).join(' ').trim()
    if (!spaceName) return 'Name the space: /multiplayer start <space name>'
    const server = normalizeServer(this.opts.server)
    return this.withAccount(server, () => this.cmdStart(rest), async (account) => {
      const hostName = asName || (await this.askName())
      const model = await soft(() => this.io.model())
      const s = await createSpace(this.io.fetch, server, { name: spaceName, hostName, via: 'claude-code', model: model || undefined }, account)
      const st = await this.signedIn(server, s)
      return [
        `Started “${st.spaceName ?? spaceName}” as ${s.name}. Join code: ${s.code}`,
        `Others join from Claude Code with /multiplayer join ${s.code}, or in the web app at ${st.web ?? server}.`,
        'Your own web link is shown above; it isn’t sent to Claude. Your turns run here while this session is open.',
      ].join('\n')
    })
  }

  private async cmdJoin(rest: string[]): Promise<string> {
    const code = rest[0]
    if (!code) return 'Give the join code: /multiplayer join MC-7Q2X-K4MP [your name]'
    const server = normalizeServer(this.opts.server)
    return this.withAccount(server, () => this.cmdJoin(rest), async (account) => {
      const name = rest.slice(1).join(' ').trim() || (await this.askName())
      const s = await joinSpace(this.io.fetch, server, { code, name, via: 'claude-code' }, account)
      const st = await this.signedIn(server, s)
      return `Joined “${st.spaceName ?? s.code}” as ${s.name}. Your turns run here while this session is open; your web link is shown above.`
    })
  }

  private async cmdConnect(rest: string[]): Promise<string> {
    const pair = rest.join('')
    if (!pair) return 'Give the pairing code from the web app: /multiplayer connect ABCD-EFGH'
    const server = normalizeServer(this.opts.server)
    const s = await redeemPair(this.io.fetch, server, pair)
    const st = await this.signedIn(server, s)
    return `Signed in to “${st.spaceName ?? s.code}” as ${s.name}. Your turns now run in this Claude Code.`
  }

  // ------------------------------------------------------------- import

  /** This folder's sessions, where Claude Code keeps them. */
  private async sessionsDir(): Promise<string> {
    const config = (await soft(() => this.io.configDir())) || `${this.home || '~'}/.claude`
    return transcriptPath(config, this.cwd, 'x').replace(/\/x\.jsonl$/, '')
  }

  /** A session of this folder, read as turns; or why it can't be. */
  private async readSession(id: string): Promise<ParsedSession | { error: string }> {
    const dir = await this.sessionsDir()
    const entry = (await soft(() => this.io.list(dir)))?.find((x) => x.name === `${id}.jsonl`)
    if (!entry) return { error: `There's no Claude Code session ${id} in this folder. Run /multiplayer import in the folder (or the session) it belongs to.` }
    if (entry.size > SESSION_MAX_BYTES) return { error: `That session is ${(entry.size / 1048576).toFixed(1)} MB; Multiplayer can bring in sessions up to 4 MB for now.` }
    try {
      return parseSession(await this.io.read(`${dir}/${id}.jsonl`))
    } catch (err) {
      return { error: `Couldn't read that session: ${(err as Error).message}` }
    }
  }

  /** The newest few sessions of this folder that have something to bring in, for picking one. */
  private async recentSessions(skip?: string): Promise<{ id: string; label: string }[]> {
    const dir = await this.sessionsDir()
    const files = ((await soft(() => this.io.list(dir))) ?? [])
      .filter((x) => x.kind === 'file' && /^[0-9a-f-]{36}\.jsonl$/i.test(x.name) && x.size <= SESSION_MAX_BYTES && x.name !== `${skip}.jsonl`)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 8)
    const out: { id: string; label: string }[] = []
    for (const f of files) {
      if (out.length >= 4) break
      const id = f.name.slice(0, -6)
      const s = await this.readSession(id)
      if ('error' in s || !s.turns.length) continue
      const when = new Date(f.mtimeMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      out.push({ id, label: `${clip(s.title, 50)} · ${s.turns.length} turn${s.turns.length === 1 ? '' : 's'} · ${when}` })
    }
    return out
  }

  // ------------------------------------------------- my conversations, in the web app

  /** Sessions read before, by file and when it was written: listing again reads only what changed. */
  private localCache = new Map<string, { key: string; parsed: ParsedSession | null }>()
  /** A bring-in under way from the web app (one at a time, so a second tap doesn't bring it twice). */
  private bringing: string | null = null

  /** Every session file of this Claude Code, from every folder, newest first. */
  private async sessionFiles(): Promise<{ path: string; id: string; size: number; at: number }[]> {
    const config = ((await soft(() => this.io.configDir())) || `${this.home || '~'}/.claude`).replace(/[\\/]+$/, '')
    const root = `${config}/projects`
    const out: { path: string; id: string; size: number; at: number }[] = []
    for (const d of ((await soft(() => this.io.list(root))) ?? []).filter((x) => x.kind === 'dir')) {
      for (const f of (await soft(() => this.io.list(`${root}/${d.name}`))) ?? []) {
        if (f.kind === 'file' && SESSION_FILE.test(f.name)) out.push({ path: `${root}/${d.name}/${f.name}`, id: f.name.slice(0, -6), size: f.size, at: f.mtimeMs })
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  private async parsedFile(f: { path: string; size: number; at: number }): Promise<ParsedSession | null> {
    const key = `${f.size}:${f.at}`
    const kept = this.localCache.get(f.path)
    if (kept?.key === key) return kept.parsed
    let parsed: ParsedSession | null = null
    try { parsed = parseSession(await this.io.read(f.path)) } catch { parsed = null }
    if (this.localCache.size > 300) this.localCache.clear()
    this.localCache.set(f.path, { key, parsed })
    return parsed
  }

  /** A folder as its person reads it: their home folder as ~. */
  private shortFolder(p: string): string {
    const home = this.home ? folderKeyOf(this.home) : ''
    const k = folderKeyOf(p)
    return home && (k === home || k.startsWith(`${home}/`)) ? `~${p.replace(/\\/g, '/').slice(home.length)}` : p
  }

  /**
   * This person's recent Claude Code conversations on this computer, from every folder (the
   * terminal, the desktop app's Code tab and the IDE all keep them here), for their web app
   * alone. Sessions Multiplayer ran for shared turns aren't theirs to bring in, so they're left out.
   */
  async localSessions(): Promise<{ sessions: LocalSession[]; tooLong: number }> {
    const current = await soft(() => this.io.sessionId())
    const sessions: LocalSession[] = []
    let tooLong = 0
    // Brought into this space before, and still here: the conversation it became.
    const kept = ((await soft(() => this.io.storeGet(STORE_BROUGHT))) ?? []) as Brought[]
    const st = this.state
    const inSpace = (id: string) => {
      const b = (Array.isArray(kept) ? kept : []).filter((x) => x.sessionId === id && x.spaceId === this.session?.spaceId).reverse().find((x) => st?.conversations[x.conversationId])
      return b ? st!.conversations[b.conversationId].title : undefined
    }
    for (const f of (await this.sessionFiles()).slice(0, LOCAL_SCAN)) {
      if (sessions.length >= LOCAL_MAX) break
      if (f.size > SESSION_MAX_BYTES) { tooLong++; continue }
      const s = await this.parsedFile(f)
      if (!s || s.multiplayer || !s.turns.length) continue
      const folder = s.cwd ?? ''
      sessions.push({
        id: f.id, title: clip(s.title, 120), folder: folder ? this.shortFolder(folder) : '',
        here: !!folder && folderKeyOf(folder) === this.folderKey(), ...(f.id === current ? { current: true } : {}), turns: s.turns.length, at: Math.round(f.at),
        ...(inSpace(f.id) ? { inSpace: inSpace(f.id) } : {}),
      })
    }
    return { sessions, tooLong }
  }

  /** The web app asks: list this person's conversations, or bring one in as a new conversation here. */
  async local(requestId: string, action: LocalAction): Promise<void> {
    const w = this.wire
    if (!w) return
    const send = (report: Omit<LocalReport, 'at'>) => w.live({ kind: 'local.report', requestId, report: { ...report, at: Date.now() } })
    if (action.type === 'list') {
      try { await send(await this.localSessions()) } catch (err) { await send({ error: `Couldn’t read your Claude Code conversations: ${(err as Error).message}` }) }
      return
    }
    const id = action.sessionId
    const fail = (text: string) => send({ brought: { sessionId: id, ok: false, text } })
    if (!/^[0-9a-f-]{36}$/i.test(id)) return void (await fail('That isn’t a Claude Code session.'))
    if (this.bringing) return void (await fail('Another conversation is coming in. Try again when it’s in.'))
    this.bringing = id
    try {
      const f = (await this.sessionFiles()).find((x) => x.id === id)
      if (!f) return void (await fail('That conversation isn’t on this computer any more.'))
      if (f.size > SESSION_MAX_BYTES) return void (await fail(`That conversation is ${(f.size / 1048576).toFixed(1)} MB; Multiplayer can bring in conversations up to 4 MB for now.`))
      const parsed = await this.parsedFile(f)
      if (!parsed || parsed.multiplayer) return void (await fail('That isn’t one of your own conversations.'))
      if (!parsed.turns.length) return void (await fail('That conversation has no answered turns to bring in.'))
      await send({ bringing: id })
      const here = !!parsed.cwd && folderKeyOf(parsed.cwd) === this.folderKey()
      const r = await this.importInto(null, parsed, id, { fork: here, folder: parsed.cwd ? this.shortFolder(parsed.cwd) : undefined })
      await send({ brought: { sessionId: id, ok: r.ok, text: r.text, ...(r.conversationId ? { conversationId: r.conversationId } : {}), ...(r.turns ? { turns: r.turns } : {}) } })
    } finally {
      this.bringing = null
    }
  }

  /**
   * /multiplayer import [session id] [--new | --here]: brings a Claude Code conversation into a
   * space, exactly as it is: everyone sees every turn, and this person's Claude Code carries on
   * from a copy of the session itself, forked at its last answer (the original isn't touched).
   */
  private async cmdImport(rest: string[]): Promise<string> {
    const io = this.io
    const server = normalizeServer(this.opts.server)
    let id = rest.find((x) => /^[0-9a-f-]{36}$/i.test(x))
    const flag = rest.includes('--new') ? 'new' : rest.includes('--here') ? 'here' : undefined
    if (!id) {
      const current = await soft(() => io.sessionId())
      const own = current ? await this.readSession(current) : undefined
      if (own && !('error' in own) && own.turns.length) id = current
      else {
        const recent = await this.recentSessions(current)
        if (!recent.length) return 'This session has nothing to bring in yet, and there are no other Claude Code sessions in this folder. Run /multiplayer import inside the conversation you want to bring in.'
        try {
          const picked = await io.ask('Which Claude Code conversation should come in?', { options: recent.map((r) => r.label), header: 'Import' })
          id = recent.find((r) => r.label === picked)?.id
        } catch { return 'Nothing was brought in.' }
        if (!id) return 'Nothing was brought in.'
      }
    }
    if (!id) return 'Nothing was brought in.'
    const sessionId: string = id
    const parsed = await this.readSession(sessionId)
    if ('error' in parsed) return parsed.error
    if (!parsed.turns.length) return 'That session has no answered turns to bring in.'

    // Where it goes: a new space, or a new conversation in the space this Claude Code is in.
    const here = this.session && this.wire && this.state && !this.state.space.endedAt ? this.session : null
    let where: 'new' | 'here' = flag === 'here' && here ? 'here' : 'new'
    if (!flag && here) {
      const spaceName = here.spaceName ?? this.state?.space.name ?? 'your space'
      const inHere = `A new conversation in “${clip(spaceName, 40)}”`
      try {
        const picked = await io.ask(`Where should “${clip(parsed.title, 60)}” go? Everyone there will see the whole conversation.`, { options: [inHere, 'A new space'], header: 'Import' })
        if (picked !== inHere && picked !== 'A new space') return 'Nothing was brought in.'
        where = picked === inHere ? 'here' : 'new'
      } catch { return 'Nothing was brought in.' }
    }

    if (where === 'here') return (await this.importInto(null, parsed, sessionId)).text
    return this.withAccount(server, () => this.cmdImport([sessionId, '--new']), async (account) => {
      const hostName = await this.askName()
      const model = parsed.model && isModelName(parsed.model) ? parsed.model : await soft(() => io.model())
      const s = await createSpace(io.fetch, server, { name: clip(parsed.title, 60), hostName, via: 'claude-code', model: model || undefined }, account)
      await this.signedIn(server, s)
      const st = this.state
      const main = st ? mainOf(st, st.conversationOrder[0]) : undefined
      if (!main) return 'The space started, but its conversation isn’t here yet. Run /multiplayer import again in a moment.'
      return (await this.importInto(main.id, parsed, sessionId)).text
    })
  }

  /**
   * Sends the turns (into `branchId`, or a new conversation), then points the branch's session here
   * at the original's fork. `fork: false`: the session ran in another folder, which Claude Code
   * can't resume from here, so turns here carry on from the conversation as notes.
   */
  private async importInto(branchId: string | null, parsed: ParsedSession, sessionId: string, opts: { fork?: boolean; folder?: string } = {}): Promise<{ ok: boolean; text: string; conversationId?: string; turns?: number }> {
    const w = this.wire
    const no = (text: string) => ({ ok: false, text })
    if (!w || !this.state) return no('Not connected to a space yet.')
    const fork = opts.fork !== false
    let conversationId = branchId ? this.state.branches[branchId]?.conversationId : undefined
    const space = this.state.space.name
    const title = clip(parsed.title, 120)
    const model = parsed.model && isModelName(parsed.model) ? parsed.model : undefined
    if (!branchId) {
      const r = await w.command({ type: 'conversation.create', title, carry: false, filesFromMain: false, ...(model ? { model } : {}) })
      const made = r.ok ? r.events?.find((e) => e.type === 'conversation.created') : undefined
      if (!made || made.type !== 'conversation.created') return no(`Couldn’t start a conversation for it: ${r.error ?? 'no answer'}.`)
      branchId = made.conversation.mainBranchId
      conversationId = made.conversation.id
    }
    const { chunks, shortened } = chunkTurns(parsed.turns)
    const at: Record<string, string> = {}
    let through: string | null = null
    let brought = 0
    for (const [n, chunk] of chunks.entries()) {
      const r = await w.command({ type: 'branch.import', branchId, source: { from: 'claude-code', title }, turns: chunk.map(({ uuid: _u, ...t }) => t), ...(n === 0 && model ? { model } : {}) })
      if (!r.ok) {
        return brought
          ? { ok: false, text: `Brought in ${brought} of ${parsed.turns.length} turns, then the server refused the rest: ${r.error ?? 'no answer'}.`, conversationId, turns: brought }
          : no(`Couldn’t bring it in: ${r.error ?? 'no answer'}.`)
      }
      const ids = (r.events ?? []).filter((e) => e.type === 'turn.imported').map((e) => (e.type === 'turn.imported' ? e.turn.id : ''))
      chunk.forEach((t, i) => { if (ids[i] && t.uuid) { at[ids[i]] = t.uuid; through = ids[i] } })
      brought += chunk.length
    }
    // This branch's session here is the original, set aside at its last answer: the next turn
    // forks it there (--resume … --fork-session --resume-session-at), so it carries on with all of it.
    if (through && fork) await this.saveBranchSession(branchId, { id: sessionId, through, at, rewind: true })
    this.lastBranchId = branchId
    this.refresh()
    const text = [
      `Brought “${clip(parsed.title, 60)}” into “${space}”: ${brought} turn${brought === 1 ? '' : 's'}${shortened ? ` (${shortened} very long message${shortened === 1 ? '' : 's'} shortened for the others)` : ''}.`,
      fork
        ? 'Everyone there sees the whole conversation. Your turns on it carry on here from a copy of this session; the session itself is left as it was.'
        : `Everyone there sees the whole conversation. It ran in another folder${opts.folder ? ` (${opts.folder})` : ''}, so your turns on it carry on in this folder from the conversation itself, as notes. Claude here reads this folder's files, not that one's.`,
    ].join('\n')
    const spaceId = this.session?.spaceId
    if (spaceId && conversationId) {
      const kept = ((await soft(() => this.io.storeGet(STORE_BROUGHT))) ?? []) as Brought[]
      const next = [...(Array.isArray(kept) ? kept : []), { sessionId, spaceId, conversationId, at: Date.now() }].slice(-200)
      await soft(() => this.io.storeSet(STORE_BROUGHT, next))
    }
    return { ok: true, text, conversationId, turns: brought }
  }

  /** Where a note from this session goes: the shared branch this runner last ran, else the main line. */
  private shareTarget(): Branch | undefined {
    const s = this.state
    if (!s) return undefined
    const last = this.lastBranchId ? s.branches[this.lastBranchId] : undefined
    if (last && !last.private) return last
    const conv = s.conversationOrder[0]
    return conv ? mainOf(s, conv) : undefined
  }

  private where(branchId: string): string {
    const s = this.state
    const b = s?.branches[branchId]
    if (!s || !b) return 'the branch'
    const title = s.conversations[b.conversationId]?.title ?? s.space.name
    return isMain(s, b.id) ? `“${title}”` : `“${title}”, branch “${b.name}”`
  }

  /**
   * /multiplayer share <what>: context in from this session. Its own Claude drafts a note here,
   * where the person reads it; nothing leaves until they /multiplayer post.
   */
  private cmdShare(what: string): string {
    const s = this.state
    if (!s || !this.wire) return 'Not connected to a space yet.'
    if (!what.trim()) return 'Say what to share, for example: /multiplayer share what we found about the export bug'
    const b = this.shareTarget()
    if (!b) return 'There is no shared branch to share to yet.'
    // This goes into the person's own session as their prompt, so it holds only fixed words and
    // what they typed: never names the other members chose (space, conversation, branch).
    const prompt = [
      `Draft a short note for the others in my shared Multiplayer conversation, sharing ${what.trim()} from this session.`,
      `They can't see this session, so make it stand on its own. Leave out anything personal or private. Write only the note, in plain sentences, ready to post as from me.`,
    ].join(' ')
    this.share = { prompt, branchId: b.id, ccTurnId: null }
    this.io.after(0, () => void this.io.submit(prompt, true).catch(() => { if (this.share?.prompt === prompt) this.share = null }))
    return `Asking Claude to draft it here, for ${this.where(b.id)}. Read the draft; nothing is shared until you /multiplayer post.`
  }

  /** /multiplayer post [text]: shares the draft (or the person's own words) as a note on the branch. */
  private async cmdPost(text: string): Promise<string> {
    if (!this.state || !this.wire) return 'Not connected to a space yet.'
    const body = text.trim() || this.share?.draft
    if (!body) return this.share ? 'The draft isn’t ready yet.' : 'Nothing to post. Start with /multiplayer share <what>, or /multiplayer post <your text>.'
    const branchId = this.share?.branchId ?? this.shareTarget()?.id
    if (!branchId) return 'There is no shared branch to share to yet.'
    const r = await this.wire.command({ type: 'share.post', toBranchId: branchId, text: body })
    if (!r.ok) return `Couldn’t share it: ${r.error ?? 'refused'}.`
    this.share = null
    return `Shared on ${this.where(branchId)}. Everyone sees it there, and the next shared turn reads it.`
  }

  private async cmdTakeHome(): Promise<string> {
    if (!this.state) return 'Not connected to a space yet.'
    const s = this.state
    const conv = s.conversationOrder[0]
    const branchId = this.lastBranchId ?? (conv ? mainOf(s, conv)?.id : undefined)
    const branch = branchId ? s.branches[branchId] : undefined
    if (!branch) return 'There is no conversation to take home yet.'
    const own = this.session ? (await this.branchSessions())[`${this.session.spaceId}:${branch.id}`] : undefined
    if (own) {
      // A fork keeps the shared session as it is: nothing done in it reaches the space. A turn
      // set aside at the session's end (stopped or failed) stays out of the copy too.
      const at = own.rewind && own.through ? own.at[own.through] : undefined
      this.io.log(`To carry on alone, run this in ${this.cwd}: claude --resume ${own.id} --fork-session${at ? ` --resume-session-at ${at}` : ''}`)
      return `“${branch.name}” is a Claude Code session on this machine. The command shown above opens a private copy of it; nothing you do there is shared.`
    }
    const { text, turns } = fmt.branchTranscript(s, branch.id)
    if (!turns) return 'Nothing has been answered on that branch yet.'
    const title = s.conversations[branch.conversationId]?.title ?? s.space.name
    const where = s.conversations[branch.conversationId]?.mainBranchId === branch.id ? '' : `, branch “${branch.name}”`
    const r = await this.io.append(`[Multiplayer: the shared conversation “${title}”${where}, brought into this session so the person can carry on alone. Nothing from here on is shared.]\n\n${text}`)
    if (r.deny) return `Couldn’t bring it in: ${r.deny}`
    return `Brought ${turns} turn${turns === 1 ? '' : 's'} of “${title}”${where} into this session. Carry on here; nothing you do now is shared.`
  }

  statusText(): string {
    const s = this.state
    if (!this.session) return 'Not signed in to a space. ' + this.helpText()
    const lines = [`Multiplayer · ${this.session.spaceName ?? s?.space.name ?? 'space'} · ${this.statusDetail()}`]
    lines.push(`Join code ${this.session.code} · you are ${s ? memberName(s, this.me) : this.session.name} · server ${this.session.server}`)
    const v = this.view()
    if (v.people.length) lines.push('People: ' + v.people.map((p) => `${p.name}${p.isMe ? ' (you)' : ''}${p.runner ? ' ●' : ''}`).join(', '))
    if (v.turns.length) lines.push('Turns: ' + v.turns.map((t) => `${t.who}: ${t.text} (${t.status})`).join('; '))
    return lines.join('\n')
  }

  // ================================================================== UI

  private statusDetail(): string {
    const a = this.active
    const waiting = !!a && a.approvals.size > 0
    if (this.phase === 'signed-out') return 'signed out'
    if (this.phase === 'superseded') return 'another Claude Code is running your turns'
    if (a && waiting) return `waiting for your approval (${a.label})`
    if (a && !a.stopped) return `running ${a.label}`
    if (this.combine) return 'combining file changes'
    const next = this.queue[0]
    if (next) {
      const t = next.kind === 'shared' ? this.turn(next.turnId) : undefined
      const what = t ? this.label(t) : 'combining files'
      return this.busy ? `${what} is waiting for you to finish` : `starting ${what}`
    }
    if (this.paused) return 'paused'
    if (this.phase === 'connecting' || this.phase === 'reconnecting') return 'connecting…'
    if (this.phase === 'off') return 'not connected'
    const me = this.state?.members[this.me]
    if (me?.limit && (!me.limit.until || me.limit.until > Date.now())) return 'limit reached'
    return 'connected'
  }

  /** The status needs the person (it's in the same order): an approval, their turn held up, turns not running here. */
  private needsYou(): boolean {
    const a = this.active
    if (this.phase === 'signed-out' || this.phase === 'superseded') return true
    if (a && a.approvals.size > 0) return true
    if (a && !a.stopped) return false
    if (this.combine) return false
    if (this.queue[0]) return this.busy
    if (this.paused || this.phase !== 'online') return false
    const me = this.state?.members[this.me]
    return !!(me?.limit && (!me.limit.until || me.limit.until > Date.now()))
  }

  view(): MultiplayerView {
    const s = this.state
    const ses = this.session
    if (!ses) return EMPTY_VIEW
    const a = this.active
    const pending = a ? [...a.approvals.values()][0] : undefined
    const people = s ? Object.values(s.members).filter((m) => !m.leftAt).map((m) => ({
      name: m.name,
      role: m.role,
      runner: m.id === this.me ? this.phase === 'online' : this.runners.some((r) => r.memberId === m.id && r.connected),
      here: this.presence.some((p) => p.memberId === m.id && p.status !== 'away'),
      isMe: m.id === this.me,
    })) : []
    const turns = s ? Object.values(s.turns)
      .filter((t) => ['requested', 'held', 'conflict', 'running', 'approval', 'paused'].includes(t.status))
      .sort((x, y) => x.requestedAt - y.requestedAt)
      .slice(0, 8)
      .map((t) => ({ id: t.id, who: memberName(s, t.runnerId), text: clip(t.parts.map((p) => p.text).join(' / '), 80), status: t.status })) : []
    return {
      isSignedIn: true,
      space: s?.space.name ?? ses.spaceName ?? '',
      code: ses.code,
      link: webLink(ses),
      me: s ? memberName(s, this.me) : ses.name,
      status: this.statusDetail(),
      needsYou: this.needsYou(),
      people,
      turns,
      approval: pending ? { tool: pending.tool, title: pending.title } : null,
    }
  }

  /** Redraws the status line and the pane's values when they changed. */
  refresh(): void {
    if (!this.io) return
    const ses = this.session
    // Claude Code draws a plugin's status line as a warning, after the plugin's name. So it's kept
    // for what needs the person; the steady state is a dim label in the prompt footer (register.tsx).
    const status = ses && this.needsYou() ? `${this.state?.space.name ?? ses.spaceName ?? 'space'} · ${this.statusDetail()}` : undefined
    if (status !== this.lastStatus) {
      this.lastStatus = status
      void soft(() => this.io.status(status))
    }
    const view = this.view()
    const json = JSON.stringify(view)
    if (json !== this.lastView) {
      this.lastView = json
      void soft(() => this.io.setView(view))
    }
  }

  onMeasure(limits: SessionRateLimit[]): void {
    this.rateLimits = limits
  }

}
