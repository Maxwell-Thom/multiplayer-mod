// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type {
  Ask, Branch, ChatMessage, Conversation, Decision, FilesPush, Handoff, Member, MemberId, MemberPrefs, Merge,
  MergeChoice, ModelPin, Note, Part, Policy, Presence, Question, RunnerInfo, Space, Step, TimelineItem,
  Schedule, SharedFile, Steer, Transfer, Turn, TurnFailure, TurnMode, TurnWork, Usage, Id,
} from './types.ts';
import type { AskQuestion } from './helpers.ts';

/** Persisted events. The log of these, folded by `reduce`, is a space. */
export type EventBody =
  | { type: 'space.created'; space: Space; host: Member }
  | { type: 'member.joined'; member: Member }
  | { type: 'member.updated'; memberId: MemberId; patch: Partial<Pick<Member, 'name' | 'role' | 'notify' | 'limit'>> }
  // A person's own choices: how turns start there and whose may use their usage credits (everyone sees these)…
  | { type: 'member.prefs'; memberId: MemberId; prefs: Omit<MemberPrefs, 'budget'> }
  // …and what others' turns may spend there (only they do).
  | { type: 'member.budget'; memberId: MemberId; budget: number }
  | { type: 'file.added'; file: SharedFile }
  | { type: 'schedule.created'; schedule: Schedule }
  | { type: 'schedule.updated'; scheduleId: Id; patch: Partial<Pick<Schedule, 'next' | 'left' | 'status' | 'lastTurn' | 'stoppedBy'>> }
  /** Seen only by that member. */
  | { type: 'sharing.changed'; memberId: MemberId; source: string; name: string; on: boolean }
  | { type: 'member.left'; memberId: MemberId }
  | { type: 'space.policy'; policy: Policy }
  | { type: 'space.host'; hostId: MemberId }
  | { type: 'space.ended' }
  | { type: 'conversation.created'; conversation: Conversation; main: Branch }
  | { type: 'conversation.renamed'; conversationId: Id; title: string }
  | { type: 'branch.created'; branch: Branch }
  /** Whose Claude Code a branch runs in now, and why it changed. */
  | { type: 'branch.runner'; branchId: Id; runnerId: MemberId | null; from: MemberId | null; why: 'first' | 'moved' | 'takeover' | 'left' }
  | { type: 'run.allowed'; conversationId: Id; runnerId: MemberId; memberId: MemberId; on: boolean }
  | { type: 'branch.repo'; branchId: Id; repo: string }
  | { type: 'ask.closed'; askId: Id }
  | { type: 'transfer.started'; transfer: Transfer }
  | { type: 'transfer.updated'; transferId: Id; status: Transfer['status']; manifest?: Transfer['manifest']; summary?: string }
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
  | { type: 'turn.approval'; turnId: Id; waiting: boolean; sharing?: boolean }
  | { type: 'turn.paused'; turnId: Id }
  | { type: 'turn.resumed'; turnId: Id }
  | { type: 'turn.takeover'; turnId: Id; runnerId: MemberId }
  | { type: 'turn.text'; turnId: Id; text: string }
  | { type: 'turn.steered'; turnId: Id; steer: Steer }
  | { type: 'turn.steers-taken'; turnId: Id; through: number }
  | { type: 'turn.unsteered'; turnId: Id; ns: number[] }
  | { type: 'turn.steers-out'; turnId: Id; through: number }
  | { type: 'turn.done'; turnId: Id; text: string; usage?: Usage; model?: string; effort?: string; fast?: boolean; notices?: string[]; suggestion?: string; replies?: string[]; thinking?: string }
  | { type: 'turn.failed'; turnId: Id; failure: TurnFailure }
  | { type: 'turn.stopped'; turnId: Id; by: MemberId }
  | { type: 'turn.work'; turnId: Id; work: TurnWork }
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
  /** `branchId` and `at`: they looked at that branch then (a read receipt). */
  | { type: 'seen'; memberId: MemberId; seq: number; branchId?: Id; at?: number };

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
  | { kind: 'approval.request'; turnId: Id; requestId: string; tool: string; title: string; detail: string; site?: string; always?: string; questions?: AskQuestion[]; plan?: string; shared?: boolean; sharing?: { source: string; name: string; label: string } }
  /** `by`: who answered a shared one; `ok`: they approved or answered it. */
  | { kind: 'approval.cleared'; turnId: Id; requestId: string; by?: MemberId; ok?: boolean }
  /** Web app → its own runner, relayed through the server. */
  | { kind: 'approval.answer'; turnId: Id; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny' }
  /** File work happens on each person's own machine: requests and reports go only between a person's web app and their runner. */
  | { kind: 'files.request'; requestId: string; action: FilesAction }
  | { kind: 'files.report'; requestId?: string; report: FilesReport }
  /** My own Claude Code's conversations on my computer: asked for and answered only between my web app and my runner. */
  | { kind: 'local.request'; requestId: string; action: LocalAction }
  | { kind: 'local.report'; requestId?: string; report: LocalReport }
  | { kind: 'focus'; conversationId: Id; branchId: Id }
  /** How much of a move's work has reached the Claude Code it's going to (counted by the relay): for both ends and the branch's readers. */
  | { kind: 'transfer.progress'; transferId: Id; sent: number; size: number }
  | { kind: 'toast'; title: string; text?: string };

export type FilesAction =
  | { type: 'status' }
  | { type: 'pull' }
  | { type: 'resolve'; picks: Record<string, 'mine' | 'theirs' | 'claude'> }
  | { type: 'combine' };

/** What my web app asks my runner about my Claude Code conversations: the recent ones, or to bring one in here. */
export type LocalAction =
  | { type: 'list' }
  | { type: 'bring'; sessionId: string };

/** One of my Claude Code conversations on my computer, as my runner lists it. Only I ever see these. */
export interface LocalSession {
  /** Claude Code's session id. */
  id: string;
  /** Claude Code's own title for it, else its first prompt. */
  title: string;
  /** The folder it ran in, on my computer. */
  folder: string;
  /** It ran in the folder my runner is in, so my turns carry on from the session itself. */
  here: boolean;
  /** The Claude Code session I'm in right now. */
  current?: boolean;
  turns: number;
  /** Already brought into this space: the conversation it became. */
  inSpace?: string;
  /** When it was last written to. */
  at: number;
}

export interface LocalReport {
  /** Newest first. */
  sessions?: LocalSession[];
  /** Sessions too long to bring in yet (over 4 MB). */
  tooLong?: number;
  /** A bring-in under way, or how it went. */
  bringing?: string;
  brought?: { sessionId: string; ok: boolean; text: string; conversationId?: Id; turns?: number };
  error?: string;
  at: number;
}

export interface FilesReport {
  state: 'clean' | 'incoming' | 'pulled' | 'conflict' | 'resolving' | 'resolved' | 'error' | 'no-repo';
  gitBranch?: string;
  incoming?: { from?: string; commits: { sha: string; subject: string; author?: string }[]; at?: number };
  checks?: { ok: boolean; text: string }[];
  diff?: { name: string; tag: string; lines: [string, string][] }[];
  hunks?: { id: string; file: string; line: string; mine: string; theirs: string; combined?: string }[];
  error?: string;
}
