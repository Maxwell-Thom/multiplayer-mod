// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Command } from './commands.ts';
import type { FilesAction, FilesReport, LiveMessage, LocalAction, LocalReport, SpaceEvent } from './events.ts';
import type { Color, Id, MemberId, Presence, Role, RunnerInfo, SpaceState, Transfer, Via } from './types.ts';
import type { AskQuestion } from './helpers.ts';

/**
 * The wire between the server and its two kinds of clients:
 *
 *  - the web app, over one WebSocket per open space
 *  - runners (the Claude Code mod, the simulator), over plain HTTP with long-polling,
 *    because a mod can make HTTP requests but can't hold a socket open
 *
 * claude.ai members reach the same space through the MCP endpoint instead.
 */

// ------------------------------------------------------------------ REST

export interface CreateSpaceRequest { name: string; hostName: string; via: Via; model?: string }
export interface JoinRequest { code: string; name: string; via: Via; role?: Role }
export interface Session { spaceId: Id; memberId: MemberId; token: string; code: string; name: string; spaceName?: string }

/** What anyone with the code may see before joining. */
export interface JoinPreview { name: string; host?: string; members: { name: string; color: Color }[]; conversations: number; decisions: number; ended: boolean }

export interface PairResponse { pairCode: string; expiresAt: number }
export interface RedeemPairRequest { pairCode: string }

export interface Snapshot {
  state: SpaceState;
  me: MemberId;
  presence: Presence[];
  runners: RunnerInfo[];
  serverTime: number;
  /** When this member last saw the space (the time of their last seen event), for "since you left". */
  seenAt?: number;
}

export interface CommandResponse { ok: boolean; error?: string; code?: string; seq: number; events?: SpaceEvent[] }

/** A runner's long-poll. Answers as soon as there is anything, or after `wait` seconds. */
export interface PollResponse {
  seq: number;
  events: SpaceEvent[];
  /** Messages addressed to this runner: approval answers, file requests. */
  live: RunnerInbound[];
  /** The runner fell too far behind: fetch a fresh snapshot. */
  resync?: boolean;
  /** A newer runner process said hello for this member: this one should stop polling. */
  superseded?: boolean;
  /** The server has no record of this runner (it restarted): say hello again. */
  hello?: boolean;
}

export interface RunnerHello {
  info: Omit<RunnerInfo, 'memberId' | 'connected' | 'at'>;
  /** Turns this runner is still running right now (after a reconnect). */
  running?: Id[];
  /** Tools of the person's interactive Claude Code its turns can use through it (BRIDGED_TOOLS it has). Kept by the server, shown to nobody. */
  tools?: BridgeTool[];
}

/**
 * Tools a turn's background session (`claude -p`) doesn't get, which the person's own
 * interactive Claude Code has: the mod there makes the call for the turn. Artifacts are off
 * in `-p` with no switch to turn them on.
 */
export const BRIDGED_TOOLS = ['Artifact', 'ArtifactData', 'ArtifactComments'] as const;

/** A bridged tool as the person's Claude Code describes it. */
export interface BridgeTool {
  name: string;
  description: string;
}

/** What a runner sends besides commands. */
export type RunnerOutbound =
  | { kind: 'delta'; turnId: Id; text: string }
  /** An answer typed at the runner (/multiplayer allow) to a permission question its turn's session asked. */
  | { kind: 'approval.answer'; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny'; answers?: Record<string, string> }
  | { kind: 'files.report'; requestId?: string; report: FilesReport }
  /** My Claude Code conversations, for my web app only. */
  | { kind: 'local.report'; requestId?: string; report: LocalReport }
  /** What a bridged tool answered, for the turn's session that asked. */
  | { kind: 'tool.result'; requestId: string; text: string; isError?: boolean };

/** What the server or the member's web app asks of their runner. */
export type RunnerInbound =
  /** A turn's session asked permission (its MCP permission prompt): the person can answer here too. */
  /**
   * `shared`: Claude's question or its plan, which anyone here who may prompt can answer (it's about
   * the conversation, not the runner's computer). Everything else is the runner's alone.
   */
  | { kind: 'approval.request'; turnId: Id; requestId: string; tool: string; title: string; detail: string; site?: string; always?: string; questions?: AskQuestion[]; plan?: string; shared?: boolean; sharing?: { source: string; name: string; label: string } }
  /** `by`: who answered a shared one; `ok`: they approved or answered it (else declined or skipped). */
  | { kind: 'approval.cleared'; turnId: Id; requestId: string; by?: MemberId; ok?: boolean }
  | { kind: 'files.request'; requestId: string; action: FilesAction }
  /** My web app asks about my Claude Code conversations (list them, or bring one in). */
  | { kind: 'local.request'; requestId: string; action: LocalAction }
  /**
   * A turn's session calls a bridged tool: make the call in this Claude Code and answer with
   * tool.result. `approved`: its owner allowed exactly this call in Multiplayer, so their Claude
   * Code needn't ask again (their deny rules still hold); absent, it asks as it would anyway.
   */
  | { kind: 'tool.request'; turnId: Id; requestId: string; tool: string; input: Record<string, unknown>; approved?: boolean }
  /** A move: pack this branch's work, say it's ready (runner.transfer with its manifest), then send it in parts through the relay to `to`'s Claude Code. With `copy`: only those files, for `to`'s browser. */
  | { kind: 'transfer.send'; transferId: Id; branchId: Id; to: MemberId; copy?: Transfer['copy'] }
  /** A move's work is on its way from `from`'s Claude Code: take its parts from the relay and check them against `manifest` before applying anything. */
  | { kind: 'transfer.receive'; transferId: Id; branchId: Id; from: MemberId; manifest: NonNullable<Transfer['manifest']> }
  /** Stop or start picking up turns (from the person's own web app). */
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'wake' };

// ------------------------------------------------------------- WebSocket

export type ClientMessage =
  | { kind: 'command'; reqId: string; cmd: Command }
  | { kind: 'presence'; status: Presence['status']; branchId?: Id; conversationId?: Id }
  /** `answers`: for Claude's question (AskUserQuestion), each question's text to the option(s) picked, or the person's own words. */
  | { kind: 'approval.answer'; turnId: Id; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny'; answers?: Record<string, string> }
  | { kind: 'files.request'; requestId: string; action: FilesAction }
  | { kind: 'local.request'; requestId: string; action: LocalAction }
  | { kind: 'runner.pause' }
  | { kind: 'runner.resume' }
  | { kind: 'ping' };

export type ServerMessage =
  | ({ kind: 'hello' } & Snapshot)
  | { kind: 'result'; reqId: string; ok: boolean; error?: string; code?: string; seq: number }
  | { kind: 'pong'; serverTime: number }
  | { kind: 'resync' }
  | LiveMessage;

export const API_VERSION = 1;
