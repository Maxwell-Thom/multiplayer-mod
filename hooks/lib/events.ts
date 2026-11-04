// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type {
  Ask, Branch, ChatMessage, Conversation, Decision, FilesPush, Handoff, Member, MemberId, Merge,
  MergeChoice, ModelPin, Note, Part, Policy, Presence, Question, RunnerInfo, Space, Step, TimelineItem,
  Turn, TurnFailure, TurnMode, Usage, Id,
} from './types.ts';
import type { AskQuestion } from './helpers.ts';

/** Persisted events. The log of these, folded by `reduce`, is a space. */
export type EventBody =
  | { type: 'space.created'; space: Space; host: Member }
  | { type: 'member.joined'; member: Member }
  | { type: 'member.updated'; memberId: MemberId; patch: Partial<Pick<Member, 'name' | 'role' | 'notify' | 'limit'>> }
  | { type: 'member.left'; memberId: MemberId }
  | { type: 'space.policy'; policy: Policy }
  | { type: 'space.host'; hostId: MemberId }
  | { type: 'space.ended' }
  | { type: 'conversation.created'; conversation: Conversation; main: Branch }
  | { type: 'conversation.renamed'; conversationId: Id; title: string }
  | { type: 'branch.created'; branch: Branch }
  | { type: 'branch.updated'; branchId: Id; patch: Partial<Pick<Branch, 'name' | 'state'>> }
  | { type: 'branch.model'; branchId: Id; model: ModelPin }
  | { type: 'part.added'; part: Part }
  | { type: 'part.removed'; partId: Id; branchId: Id }
  | { type: 'turn.requested'; turn: Turn; consumed: Id[] }
  /** A turn done elsewhere, brought in (branch.import). */
  | { type: 'turn.imported'; turn: Turn }
  | { type: 'turn.released'; turnId: Id }
  | { type: 'turn.conflict'; turnId: Id; conflict: NonNullable<Turn['conflict']> }
  | { type: 'turn.resolved'; turnId: Id; pick: string; parts: Turn['parts']; mode: TurnMode }
  | { type: 'turn.cancelled'; turnId: Id; by: MemberId; restore: Part[] }
  | { type: 'turn.started'; turnId: Id; runnerId: MemberId; model?: string }
  | { type: 'turn.step'; turnId: Id; step: Step }
  | { type: 'turn.approval'; turnId: Id; waiting: boolean }
  | { type: 'turn.paused'; turnId: Id }
  | { type: 'turn.resumed'; turnId: Id }
  | { type: 'turn.takeover'; turnId: Id; runnerId: MemberId }
  | { type: 'turn.text'; turnId: Id; text: string }
  | { type: 'turn.done'; turnId: Id; text: string; usage?: Usage; model?: string; replies?: string[]; thinking?: string }
  | { type: 'turn.failed'; turnId: Id; failure: TurnFailure }
  | { type: 'turn.stopped'; turnId: Id; by: MemberId }
  | { type: 'handoff.offered'; handoff: Handoff }
  | { type: 'handoff.updated'; handoffId: Id; status: Handoff['status'] }
  | { type: 'ask.created'; ask: Ask }
  | { type: 'ask.answered'; askId: Id; allow: boolean }
  | { type: 'decision.proposed'; decision: Decision; branchId: Id }
  | { type: 'decision.approved'; decisionId: string; memberId: MemberId }
  | { type: 'decision.dissent'; decisionId: string; memberId: MemberId; text: string }
  | { type: 'decision.updated'; decisionId: string; status?: Decision['status']; note?: string; branchId?: Id | null }
  | { type: 'question.added'; question: Question; branchId: Id }
  | { type: 'question.updated'; questionId: string; resolved?: boolean; branchId?: Id | null }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'merge.requested'; merge: Merge }
  | { type: 'merge.done'; mergeId: Id; choice: MergeChoice; picks: Record<string, boolean>; noteTurnId?: Id }
  | { type: 'merge.cancelled'; mergeId: Id }
  | { type: 'note.shared'; note: Note }
  | { type: 'files.pushed'; push: FilesPush }
  | { type: 'timeline.event'; branchId: Id; item: Extract<TimelineItem, { kind: 'event' }> }
  | { type: 'seen'; memberId: MemberId; seq: number };

export type SpaceEvent = EventBody & { seq: number; at: number; actor: MemberId | 'server' };
export type EventType = EventBody['type'];

/** Live messages over the socket. Never stored. */
export type LiveMessage =
  | { kind: 'event'; event: SpaceEvent }
  | { kind: 'presence'; presence: Presence }
  | { kind: 'presence.gone'; memberId: MemberId }
  | { kind: 'runner'; runner: RunnerInfo }
  | { kind: 'delta'; turnId: Id; text: string }
  /** Sent to the member whose runner asks (the full request, for approving in the web app); a shared one also to everyone who may answer it. */
  /** `shared`: Claude's question or plan, which anyone here who may prompt can answer. */
  | { kind: 'approval.request'; turnId: Id; requestId: string; tool: string; title: string; detail: string; site?: string; always?: string; questions?: AskQuestion[]; plan?: string; shared?: boolean }
  /** `by`: who answered a shared one; `ok`: they approved or answered it. */
  | { kind: 'approval.cleared'; turnId: Id; requestId: string; by?: MemberId; ok?: boolean }
  /** Web app → its own runner, relayed through the server. */
  | { kind: 'approval.answer'; turnId: Id; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny' }
  /** File work happens on each person's own machine: requests and reports go only between a person's web app and their runner. */
  | { kind: 'files.request'; requestId: string; action: FilesAction }
  | { kind: 'files.report'; requestId?: string; report: FilesReport }
  | { kind: 'focus'; conversationId: Id; branchId: Id }
  | { kind: 'toast'; title: string; text?: string };

export type FilesAction =
  | { type: 'status' }
  | { type: 'pull' }
  | { type: 'resolve'; picks: Record<string, 'mine' | 'theirs' | 'claude'> }
  | { type: 'combine' };

export interface FilesReport {
  state: 'clean' | 'incoming' | 'pulled' | 'conflict' | 'resolving' | 'resolved' | 'error' | 'no-repo';
  gitBranch?: string;
  incoming?: { from?: string; commits: { sha: string; subject: string; author?: string }[]; at?: number };
  checks?: { ok: boolean; text: string }[];
  diff?: { name: string; tag: string; lines: [string, string][] }[];
  hunks?: { id: string; file: string; line: string; mine: string; theirs: string; combined?: string }[];
  error?: string;
}
