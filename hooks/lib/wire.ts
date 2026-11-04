// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Command } from './commands.ts';
import type { FilesAction, FilesReport, LiveMessage, SpaceEvent } from './events.ts';
import type { Color, Id, MemberId, Presence, Role, RunnerInfo, SpaceState, Via } from './types.ts';
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
}

export interface RunnerHello {
  info: Omit<RunnerInfo, 'memberId' | 'connected' | 'at'>;
  /** Turns this runner is still running right now (after a reconnect). */
  running?: Id[];
}

/** What a runner sends besides commands. */
export type RunnerOutbound =
  | { kind: 'delta'; turnId: Id; text: string }
  /** An answer typed at the runner (/multiplayer allow) to a permission question its turn's session asked. */
  | { kind: 'approval.answer'; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny'; answers?: Record<string, string> }
  | { kind: 'files.report'; requestId?: string; report: FilesReport };

/** What the server or the member's web app asks of their runner. */
export type RunnerInbound =
  /** A turn's session asked permission (its MCP permission prompt): the person can answer here too. */
  | { kind: 'approval.request'; turnId: Id; requestId: string; tool: string; title: string; detail: string; site?: string; always?: string; questions?: AskQuestion[] }
  | { kind: 'approval.cleared'; turnId: Id; requestId: string }
  | { kind: 'files.request'; requestId: string; action: FilesAction }
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
