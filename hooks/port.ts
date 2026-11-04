// What the runner needs from the engine, as plain functions.
//
// A hooks module spells every call on `$` as `$.noun.event(...)` inside a hook
// (the engine reads them off the source; `$` itself is never passed around),
// so register.tsx builds this object inline in its session.start hook, each
// member one such call, and the rest of the mod works through it.
import type {
  AskOptions, CommandSpec, HttpInit, HttpResponse, ModelCompleteRequest, ModelCompleteResult, ProcessRunInit,
  ProcessRunResult, ProcessSpawnChunk, ProcessSpawnResult, PromptSubmitResult, SessionUsage, Timer,
} from 'claude-code'

import type { MultiplayerMemo, MultiplayerView } from '../types'

export type Fetch = (url: string, init: HttpInit) => Promise<HttpResponse>

/** A child process's output, piece by piece; ending the loop (`return()`) kills it. */
export type ChildStream = AsyncIterable<ProcessSpawnChunk> & { result: Promise<ProcessSpawnResult> }
export type SpawnRequest = { argv: string[]; cwd?: string; env?: Record<string, string>; input?: string }

export type Port = {
  fetch: Fetch
  // display
  status: (text: string | undefined) => void
  toast: (text: string) => void
  /** A dim transcript line the model never reads (`debug`: the debug log only). */
  log: (text: string, debug?: boolean) => void
  ask: (question: string, options: AskOptions) => Promise<string>
  // kept values
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  getMemo: () => Promise<MultiplayerMemo | undefined>
  setMemo: (memo: MultiplayerMemo) => Promise<unknown>
  setView: (view: MultiplayerView) => Promise<unknown>
  // time
  sleep: (ms: number) => Promise<void>
  after: (ms: number, fn: () => void) => Timer
  // the session
  model: () => Promise<string>
  version: () => Promise<string | undefined>
  cwd: () => Promise<string>
  sessionId: () => Promise<string>
  usage: () => Promise<SessionUsage>
  sandbox: () => Promise<boolean>
  home: () => Promise<string | undefined>
  userName: () => Promise<string | undefined>
  /**
   * CLAUDE_CODE_EXECPATH, the Claude Code program this session runs (its branch sessions run
   * the same one). Claude Code sets it for the processes it starts, so here it's usually unset.
   */
  execPath: () => Promise<string | undefined>
  /** Windows' own folder (SystemRoot), for its command shell by absolute path. */
  systemRoot: () => Promise<string | undefined>
  /** The person's user-level settings alone (~/.claude/settings.json), as loaded. */
  userSettings: () => Promise<unknown>
  /** This mod's own folder. */
  pluginRoot: string
  append: (text: string) => Promise<{ deny?: string }>
  submit: (text: string, asUser: boolean) => Promise<PromptSubmitResult>
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  // the machine (CLI only)
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** Starts a child (a branch's Claude Code session) and streams what it writes. */
  spawn: (request: SpawnRequest) => ChildStream
  read: (path: string) => Promise<string>
  /** A file's bytes, as base64 (for sharing a file Claude made). */
  readBytes?: (path: string) => Promise<string>
  /** A folder's entries, `{ name, kind, size, mtimeMs }` each. */
  list: (path: string) => Promise<{ name: string; kind: string; size: number; mtimeMs: number }[]>
  /** CLAUDE_CONFIG_DIR, where this Claude Code keeps its sessions (unset: ~/.claude). */
  configDir: () => Promise<string | undefined>
  write: (path: string, text: string) => Promise<void>
  /** The tools this interactive session has, with their descriptions. */
  listTools?: () => Promise<{ name: string; description: string }[]>
  /**
   * Calls one of them here, for a shared turn: the answer as the model would read it.
   * `approved`: its person allowed exactly this call in Multiplayer, so where this session would
   * ask, it doesn't (a deny still holds).
   */
  callTool?: (tool: string, input: Record<string, unknown>, approved: boolean) => Promise<{ text: string; isError?: boolean }>
}

/** The part of the port the git helpers use. */
export type Shell = Pick<Port, 'run' | 'read' | 'write'>
