// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { FilesPush, Id, MemberId, MergeChoice, Policy, Role, Step, Turn, TurnFailure, Usage, Member } from './types.ts';

/** What people (through the web app or claude.ai) and runners ask the server to do. */
export type Command =
  // members and the space
  | { type: 'member.rename'; name: string }
  | { type: 'member.notify'; notify: Member['notify'] }
  | { type: 'member.role'; memberId: MemberId; role: Role }
  | { type: 'member.leave'; handTo?: MemberId; end?: boolean }
  | { type: 'member.remove'; memberId: MemberId }
  | { type: 'member.limit-clear' }
  | { type: 'space.policy'; policy: Partial<Policy> }
  | { type: 'space.end' }
  // conversations and branches
  | { type: 'conversation.create'; title?: string; carry: boolean; filesFromMain: boolean; model?: string }
  | { type: 'conversation.rename'; conversationId: Id; title: string }
  /** An edit (editOf) sends editParts, each person's part kept as theirs; editText is the older one-text form. */
  | { type: 'branch.fork'; fromBranchId: Id; atTurnId?: Id; private?: boolean; name?: string; editOf?: Id; editText?: string; editParts?: { memberId: Id; text: string }[] }
  | { type: 'branch.state'; branchId: Id; state: 'parked' | 'active' }
  | { type: 'branch.rename'; branchId: Id; name: string }
  | { type: 'branch.model'; branchId: Id; name: string; effort: 'low' | 'medium' | 'high' }
  // writing and sending
  /** `cites`: a finished turn from another branch, brought into this one with the part. */
  | { type: 'part.add'; branchId: Id; text: string; position?: boolean; id?: Id; cites?: Id }
  | { type: 'part.remove'; partId: Id }
  | { type: 'turn.send'; branchId: Id; mode?: 'normal' | 'view-first'; handoffId?: Id }
  | { type: 'turn.resolve'; turnId: Id; pick: string }
  | { type: 'turn.stop'; turnId: Id }
  | { type: 'turn.takeover'; turnId: Id }
  | { type: 'turn.retry'; turnId: Id }
  | { type: 'turn.reveal'; turnId: Id }
  | { type: 'handoff.offer'; branchId: Id; to: MemberId }
  | { type: 'handoff.cancel'; handoffId: Id }
  | { type: 'ask.answer'; askId: Id; allow: boolean }
  // decisions, questions, chat
  | { type: 'decision.propose'; branchId: Id; text: string; replaces?: string }
  | { type: 'decision.approve'; decisionId: string }
  | { type: 'decision.dissent'; decisionId: string; text: string }
  | { type: 'question.add'; branchId: Id; text: string }
  | { type: 'question.resolve'; questionId: string }
  | { type: 'chat.send'; text: string }
  // merging, sharing, catching up
  | { type: 'merge.request'; fromBranchId: Id }
  | { type: 'merge.complete'; mergeId: Id; choice: MergeChoice; picks: Record<string, boolean> }
  | { type: 'merge.cancel'; mergeId: Id }
  /** A side question on a branch, just for you: it doesn't join the branch (Claude Code's /btw). */
  | { type: 'aside.ask'; branchId: Id; text: string }
  /** Brings your answered side question back to its branch, as a note. */
  | { type: 'aside.share'; turnId: Id }
  /** From your private lane to its main (fromBranchId), or from your own Claude Code to a branch (toBranchId). */
  | { type: 'share.post'; fromBranchId?: Id; toBranchId?: Id; text: string; question?: string }
  | { type: 'recap.request'; conversationId: Id; text: string }
  | { type: 'seen'; seq: number }
  // runner only: the member's own Claude Code (or claude.ai) reporting on turns it runs
  | { type: 'runner.check'; turnId: Id; conflict: NonNullable<Turn['conflict']> }
  | { type: 'runner.start'; turnId: Id; model?: string }
  | { type: 'runner.step'; turnId: Id; step: Step }
  | { type: 'runner.approval'; turnId: Id; waiting: boolean }
  | { type: 'runner.text'; turnId: Id; text: string }
  | { type: 'runner.done'; turnId: Id; text: string; usage?: Usage; model?: string; replies?: string[] }
  | { type: 'runner.fail'; turnId: Id; failure: TurnFailure }
  | { type: 'runner.decision'; turnId: Id; text: string; replaces?: string }
  | { type: 'runner.question'; turnId: Id; text: string }
  | { type: 'runner.pushed'; push: Omit<FilesPush, 'id' | 'memberId' | 'at'> }
  // server only
  | { type: 'server.pause'; turnId: Id }
  | { type: 'server.resume'; turnId: Id }
  | { type: 'server.note'; turnId: Id; text: string };

export type CommandType = Command['type'];

export interface CommandContext {
  actor: MemberId | 'server';
  source: 'web' | 'runner' | 'mcp' | 'server';
  now: number;
  id: (prefix: string) => string;
}
