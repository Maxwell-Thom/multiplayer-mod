// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
// Shared data model for Multiplayer.
// Everything here is plain JSON so the server, the web app, the Claude Code mod
// and the simulator can all hold the same state.

export type Id = string;
export type MemberId = string;
export type Role = 'host' | 'prompter' | 'viewer';
export type Via = 'claude-code' | 'claude-ai' | 'web';
export type Color = 'blue' | 'orange' | 'green' | 'violet' | 'pink' | 'teal';
export const COLORS: Color[] = ['blue', 'orange', 'green', 'violet', 'pink', 'teal'];

export interface Policy {
  /** Sites shared turns may reach without asking the sender. */
  sites: string[];
  /** Sending in someone else's branch needs the owner's OK. */
  ownerOk: boolean;
  /** Only the host can merge into main. */
  hostMerges: boolean;
  /** Seconds a paused turn holds its lease before anyone can take over. */
  leaseSeconds: number;
  /**
   * Shared turns use the project's setup only: the repo's MCP servers, settings and CLAUDE.md,
   * the same for every sender, without anyone's personal plugins, servers, connectors or
   * instructions. Off: each sender's Claude Code as they have it. Older spaces lack it (off).
   */
  projectSetup?: boolean;
}

export const DEFAULT_POLICY: Policy = {
  sites: ['github.com', 'docs.anthropic.com'],
  ownerOk: true,
  hostMerges: true,
  leaseSeconds: 120,
  projectSetup: false,
};

export interface Space {
  id: Id;
  name: string;
  /** Join code, e.g. MC-7Q2X. */
  code: string;
  hostId: MemberId;
  policy: Policy;
  createdAt: number;
  endedAt?: number;
  endedBy?: MemberId;
}

/**
 * A person's own choices about their Claude Code: how turns there start (`own`: as their own
 * settings say), whose turns may use their usage credits (Fable, fast mode; unset is `mine`),
 * and what one of someone else's turns may spend there, in dollars (0 or unset: no cap).
 */
export interface MemberPrefs {
  mode?: 'own' | 'default' | 'acceptEdits' | 'auto';
  credits?: 'off' | 'mine' | 'everyone';
  budget?: number;
}

export interface Member {
  id: MemberId;
  name: string;
  color: Color;
  role: Role;
  via: Via;
  joinedAt: number;
  leftAt?: number;
  /** Notification preference. */
  notify: 'needed' | 'all' | 'off';
  /** Their own choices about their Claude Code (the budget only they see). */
  prefs?: MemberPrefs;
  /** Set when the member's plan declined a turn: until when, if the runner knew. */
  limit?: { at: number; until?: number } | null;
}

export interface Conversation {
  id: Id;
  title: string;
  createdBy: MemberId;
  createdAt: number;
  mainBranchId: Id;
  /** Decision ids carried in from earlier conversations. */
  carried: string[];
  filesFromMain: boolean;
  /** Whose turns may run in whose Claude Code here without asking: runner → senders they allowed. */
  allowed?: Record<MemberId, MemberId[]>;
}

/** How hard Claude thinks: Claude Code's five levels, or `auto` for the model's own default. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Claude Code's built-in output styles (`default` sets it plainly, over a runner's own). */
export type OutputStyle = 'default' | 'Concise' | 'Explanatory' | 'Proactive' | 'Learning';

export interface ModelPin {
  name: string;
  effort: Effort;
  /** Fast mode (Opus 5.5, Opus 5 and Opus 4.8): it bills its runner's usage credits, so only with their yes. */
  fast?: boolean;
  /** How answers are written. Unset: as its Claude Code has it. Learning only on a private lane. */
  style?: OutputStyle;
  /** A model Claude asks for advice, or 'off'. Unset: as its Claude Code has it. */
  advisor?: string;
  /** Thinking turned off, where the model allows it. */
  thinking?: false;
  /** The model to run on when this one is overloaded. */
  fallback?: string;
  setBy: MemberId;
  at: number;
}

export interface Branch {
  id: Id;
  conversationId: Id;
  name: string;
  /** null for a conversation's main line. */
  ownerId: MemberId | null;
  parentId: Id | null;
  /** The parent's turn this branch continues after (inclusive). Null: from the parent's start. */
  forkTurnId: Id | null;
  /** When a branch was made by editing a shared turn: that turn's id (the branch excludes it). */
  editOf?: Id;
  private: boolean;
  state: 'active' | 'parked' | 'merged';
  model: ModelPin;
  createdAt: number;
  /**
   * Whose Claude Code this branch's turns run in (their folder, their plan), whoever sends them.
   * Null or absent: not yet decided; the next send decides it (Maxwell, 2026-11-04).
   */
  runnerId?: MemberId | null;
  /** The project its work is in: a fingerprint of the folder's git origin (never the URL), from its runner. */
  repo?: string;
}

export interface Part {
  id: Id;
  branchId: Id;
  memberId: MemberId;
  text: string;
  at: number;
  /** In "Claude's view first" mode: held back until Claude has answered. */
  position?: boolean;
  /** A turn from another branch this part cites: it reaches Claude word for word with this turn. */
  cites?: Id;
  /** Someone else changed this part in an edit (kept when it goes back to the draft). */
  editedBy?: MemberId;
  /** Files attached to it (SharedFile ids), uploaded first. */
  files?: Id[];
}

/** A file someone attached to a prompt, or Claude shared from a turn. Its bytes are on the server. */
export interface SharedFile {
  id: Id;
  name: string;
  /** Media type, as the browser or the runner said (`image/png`, `application/pdf`...). */
  type: string;
  size: number;
  by: MemberId;
  at: number;
  branchId: Id;
  /** The turn Claude shared it from. */
  turnId?: Id;
  from: 'upload' | 'claude';
}

/**
 * Background work Claude set up in a shared turn ("check again in ten minutes", a /loop): each time
 * it's due, the server sends its prompt as a turn on the branch, on its person's Claude Code and
 * plan, so what it finds is in the conversation everyone (and every later session) reads.
 */
export interface Schedule {
  id: Id;
  branchId: Id;
  /** Whose Claude Code and plan it runs on: the runner of the turn that made it. */
  by: MemberId;
  prompt: string;
  /** Repeats this often; absent, it runs once. */
  everyMs?: number;
  /** When it's next due. */
  next: number;
  /** Runs left, when it was given a number. */
  left?: number;
  status: 'on' | 'off';
  at: number;
  /** The turn that set it up. */
  fromTurn?: Id;
  /** Its last run. */
  lastTurn?: Id;
  stoppedBy?: MemberId | 'server';
}

/** Schedules' bounds: every one at least a minute apart, none further off than 30 days, a few per person. */
export const SCHEDULE_MIN_MS = 60_000;
export const SCHEDULE_MAX_MS = 30 * 24 * 3600_000;
export const SCHEDULES_PER_MEMBER = 10;

/** The most a file may be, and how many one part may carry. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const PART_FILES_MAX = 10;

export type TurnMode =
  | 'normal'
  | 'view-first'   // positions held back
  | 'reveal'       // positions shown after a view-first answer
  | 'weigh'        // conflicting parts, Claude asked to weigh both
  | 'merge-note'   // writes the merge note into main
  | 'recap'        // "since you left" recap, private to the asker
  | 'aside'        // a side question on a branch, private to the asker (Claude Code's /btw)
  | 'compact'      // /compact on the branch's session, for everyone
  | 'context'      // /context on the asker's session of the branch, private to them
  | 'combine';     // combine two conflicting file changes

export type TurnStatus =
  | 'requested'    // waiting for the sender's runner to pick it up
  | 'conflict'     // parts disagree; people settle it
  | 'held'         // sent in someone else's branch: waiting for the owner's OK
  | 'running'
  | 'approval'     // runner waiting for its owner to approve a step
  | 'paused'       // runner went quiet mid-turn; lease countdown
  | 'done'
  | 'failed'
  | 'stopped'
  | 'declined';    // not run at all (plan limit, model unavailable)

export interface Step {
  i: number;
  tool: string;
  text: string;
  detail?: string;
  state: 'run' | 'done' | 'fail' | 'wait' | 'denied';
  /** A step a subagent took: the `i` of the Agent step that started it. */
  under?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TurnFailure {
  reason: 'error' | 'limit' | 'refusal' | 'model-unavailable' | 'credits' | 'runner-offline' | 'not-connected' | 'not-signed-in';
  detail?: string;
  resetsAt?: number;
}

/** Something someone added while Claude worked on a turn (as Claude Code's queued messages). */
export interface Steer {
  n: number;
  by: MemberId;
  text: string;
  at: number;
}

export interface Turn {
  id: Id;
  branchId: Id;
  conversationId: Id;
  /** Each person's part. `editedBy`: someone else changed it, in an edit of an earlier turn. */
  parts: { memberId: MemberId; text: string; position?: boolean; editedBy?: MemberId; cites?: Id; files?: Id[] }[];
  /** Files Claude shared from this turn (SharedFile ids). */
  files?: Id[];
  /** Sent by a schedule (its id), not by a person just now. */
  scheduled?: Id;
  senderId: MemberId;
  /** The member whose Claude Code runs it (sender, or whoever took over). */
  runnerId: MemberId;
  mode: TurnMode;
  /** Run in Claude Code's plan mode: Claude plans first (reading only), then builds once its sender approves. */
  plan?: boolean;
  /** What Claude thought before it answered (shown folded; no session reads it back). */
  thinking?: string;
  status: TurnStatus;
  /** Waiting on its runner to decide whether to share something private (not what). */
  askingToShare?: boolean;
  requestedAt: number;
  startedAt?: number;
  endedAt?: number;
  pausedAt?: number;
  steps: Step[];
  text: string;
  usage?: Usage;
  model?: string;
  /** The effort level that ran (it can differ from the pin: a model's levels, a runner's cap). */
  effort?: string;
  /** The effort its branch was pinned to as it started ('auto' for the model's own), to say the level against. */
  effortAsked?: Effort;
  /** Whether it ran in fast mode: false when the pin asked for it and it ran at standard speed. */
  fast?: boolean;
  /** What Claude Code said about the session as it ran (fast mode turned off, and the like). */
  notices?: string[];
  /** What people added while Claude worked, in order. */
  steers?: Steer[];
  /** Sent as research: Claude Code's /deep-research, many searches. */
  research?: boolean;
  /** Claude Code's guess at the next prompt, after the turn (its prompt suggestions). */
  suggestion?: string;
  /** The last steer its session read (as a tool call finished); the rest go with the next prompt. */
  steersTaken?: number;
  failure?: TurnFailure;
  conflict?: { summary: string; conflicting: number[]; options: { key: string; label: string; memberId?: MemberId }[] };
  /** Set once people settled a conflict, so the runner doesn't check again. */
  checked?: boolean;
  handedFrom?: MemberId;
  takenFrom?: MemberId;
  retryOf?: Id;
  stoppedBy?: MemberId;
  /** For a reveal turn: the view-first turn it answers. */
  revealOf?: Id;
  /** For a reveal turn: one reply line per position, by index of `parts`. */
  replies?: string[];
  mergeId?: Id;
  /** Private turns (recaps, private lanes) are only visible to their runner. */
  private?: boolean;
  /** Brought in from a conversation someone had elsewhere: done there, not run here. */
  imported?: ImportSource;
  /** What it changed in its runner's folder, and whether that's been pushed (its runner keeps it current). */
  work?: TurnWork;
}

/**
 * The file changes a turn made, as its runner last saw them in its own folder. Only changes the
 * turn made: whatever else that folder holds stays its person's. Others can't see that folder,
 * so this is how their Claude knows what it has and what it doesn't (docs/CONTEXT.md).
 */
export interface TurnWork {
  /** Its folder isn't a git repository, so nobody else can pull its changes. */
  noRepo?: boolean;
  /** Files it changed that are still uncommitted, relative to the repository (the first few). */
  uncommitted?: string[];
  /** More uncommitted files than listed, or ones not named because they're private. */
  more?: number;
  /** Commits holding its changes: made in the turn, or later commits of its files. Newest first. */
  commits?: { sha: string; subject: string }[];
  /** Once those commits are on the remote: the branch they're on. */
  pushed?: string;
  /** The work moved to this member's Claude Code (a finished transfer): it's no longer only on the runner's computer. */
  movedTo?: MemberId;
  /** When its runner last checked. */
  at: number;
}

/** The most a move carries machine to machine; more than that should be pushed. */
export const TRANSFER_MAX_BYTES = 200 * 1024 * 1024;
/** One relay chunk. */
export const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;

/** Most files a turn's work names; the rest count in `more`. */
export const WORK_FILES_MAX = 20;
/** Most commits a turn's work lists. */
export const WORK_COMMITS_MAX = 30;

/** Where a conversation brought into a space came from. */
export interface ImportSource {
  /** A Claude Code session (its owner's Claude Code carries on from a copy of it), or a claude.ai chat. */
  from: 'claude-code' | 'claude-ai';
  /** Its title there. */
  title?: string;
}

/** One exchange of a conversation being brought in, as it happened there. */
export interface ImportTurn {
  prompt: string;
  text: string;
  steps?: { tool: string; text: string; failed?: boolean }[];
  model?: string;
  /** When it was asked there (ms). */
  at?: number;
}

export type DecisionStatus = 'proposed' | 'approved' | 'replaced' | 'withdrawn';

export interface Decision {
  id: string;           // D1, D2…
  text: string;
  status: DecisionStatus;
  proposedBy: MemberId | 'claude';
  turnId?: Id;
  /** Where it was made. Null once it holds on its conversation's main line (made there, or merged). */
  branchId: Id | null;
  /** The conversation it was made in. It holds there, and in later conversations that carried it. Absent on older logs: it holds everywhere. */
  conversationId?: Id;
  /** The decision this one would replace, if merged that way. */
  replaces?: string;
  approvedBy: MemberId[];
  at: number;
  dissent: { memberId: MemberId; text: string; at: number }[];
  notes: string[];
}

export interface Question {
  id: string;           // Q1, Q2…
  text: string;
  by: MemberId | 'claude';
  at: number;
  branchId: Id | null;
  /** The conversation it was asked in. Absent on older logs: it shows everywhere. */
  conversationId?: Id;
  resolvedAt?: number;
}

export interface ChatMessage {
  id: Id;
  memberId: MemberId;
  text: string;
  at: number;
}

export type MergeChoice = 'keep' | 'replace' | 'open';

export interface MergeItem {
  key: string;
  kind: 'decision' | 'question' | 'files' | 'dissent';
  title: string;
  sub?: string;
  locked?: boolean;
  defaultOn: boolean;
}

export interface Merge {
  id: Id;
  fromBranchId: Id;
  toBranchId: Id;
  requestedBy: MemberId;
  at: number;
  status: 'requested' | 'done' | 'cancelled';
  /** What the branch would bring back, proposed by the branch's runner or by people. */
  items: MergeItem[];
  conflict?: { decisionId: string; summary: string };
  doneBy?: MemberId;
  doneAt?: number;
  choice?: MergeChoice;
  picks?: Record<string, boolean>;
  noteTurnId?: Id;
}

/**
 * Something waiting for one person's yes: a turn in their branch ('send-in-branch'), a turn in
 * their Claude Code ('run-here', Claude Code's own permission prompt), or moving a branch's work
 * between Claude Codes ('move', to `moveTo`'s).
 */
export interface Ask {
  id: Id;
  kind: 'send-in-branch' | 'run-here' | 'move';
  from: MemberId;
  to: MemberId;
  branchId: Id;
  /** The turn waiting for the answer (none for a move). */
  turnId: Id;
  /** A move: whose Claude Code the branch would run in. */
  moveTo?: MemberId;
  /** 'closed': its turn ended some other way before anyone answered. */
  status: 'open' | 'allowed' | 'declined' | 'closed';
  at: number;
}

/** A move's work, sent straight from one Claude Code to another through the server's relay. */
export interface Transfer {
  id: Id;
  branchId: Id;
  from: MemberId;
  to: MemberId;
  /** packing: the sender is building it; sending: chunks are flowing; then done or failed. */
  status: 'packing' | 'sending' | 'done' | 'failed';
  at: number;
  /** What the receiver checks before applying anything. */
  manifest?: { size: number; sha256: string; chunks: number };
  summary?: string;
  /**
   * Not a move: a copy of one turn's files made outside git, straight from the computer that made
   * them to the browser of whoever asked. Only those two see it, and the conversation goes on.
   */
  copy?: { turnId: Id; paths: string[] };
}

export interface Handoff {
  id: Id;
  branchId: Id;
  from: MemberId;
  to: MemberId;
  parts: { memberId: MemberId; text: string }[];
  turnId?: Id;
  status: 'offered' | 'taken' | 'cancelled';
  at: number;
}

export interface Lease {
  branchId: Id;
  holderId: MemberId;
  turnId: Id;
  heartbeatAt: number;
}

export interface Note {
  id: Id;
  branchId: Id;
  memberId: MemberId;
  /** The private lane it was shared from; absent for a note from the person's own Claude Code (/multiplayer share). */
  fromBranchId?: Id;
  /** The side question it brings back (`aside.share`): `question` is what was asked, `text` the answer. */
  turnId?: Id;
  text: string;
  question?: string;
  at: number;
}

export interface FilesPush {
  id: Id;
  memberId: MemberId;
  /** The conversation branch whose turn made the commits, when known. */
  branchId?: Id;
  branch: string;
  commits: { sha: string; subject: string }[];
  summary: string;
  at: number;
}

/** One row of a branch's timeline, in order. */
export type TimelineItem =
  | { kind: 'turn'; id: Id }
  | { kind: 'note'; id: Id }
  | { kind: 'event'; id: Id; icon: string; actor: MemberId | 'server'; text: string; at: number; link?: { kind: 'branch' | 'decision' | 'merge' | 'map' | 'work'; id?: string; label: string } };

export interface SpaceState {
  seq: number;
  space: Space;
  members: Record<MemberId, Member>;
  conversations: Record<Id, Conversation>;
  conversationOrder: Id[];
  branches: Record<Id, Branch>;
  parts: Record<Id, Part[]>;          // by branch: the shared prompt being written
  turns: Record<Id, Turn>;
  timeline: Record<Id, TimelineItem[]>; // by branch
  decisions: Decision[];
  questions: Question[];
  chat: ChatMessage[];
  merges: Record<Id, Merge>;
  asks: Record<Id, Ask>;
  handoffs: Record<Id, Handoff>;
  leases: Record<Id, Lease>;         // by branch
  notes: Record<Id, Note>;
  pushes: FilesPush[];
  /** Last event seq each member has seen, for "since you left". */
  seen: Record<MemberId, number>;
  /**
   * What each person shares with this space from their own world (docs/PRIVACY.md), by source id
   * (`connector:Gmail`, `outside`...). Each person sees only their own.
   */
  sharing?: Record<MemberId, Record<string, { name: string; at: number }>>;
  /** Files attached or shared in this space, by id. */
  files?: Record<Id, SharedFile>;
  /** Background work set up in shared turns, by id. */
  schedules?: Record<Id, Schedule>;
  /** A branch's work on its way from one Claude Code to another (machine to machine; the server keeps none of it). */
  transfers?: Record<Id, Transfer>;
}

/** Live, never stored: who is doing what right now. */
export interface Presence {
  memberId: MemberId;
  status: 'here' | 'writing' | 'approving' | 'away';
  branchId?: Id;
  conversationId?: Id;
  at: number;
}

/** What a member's runner (their Claude Code with the mod, or claude.ai) reports. */
export interface RunnerInfo {
  memberId: MemberId;
  kind: 'claude-code' | 'claude-ai' | 'sim';
  connected: boolean;
  version?: string;
  model?: string;
  models?: string[];
  /** The commands and skills its sessions have, for "/" (its person only). */
  commands?: string[];
  account?: string;
  cwd?: string;
  git?: { repo?: string; branch?: string; dirty?: boolean };
  /** The project's fingerprint (16 hex of sha256 over the space id and its first commit): for the server's move check, never shown to anyone. */
  repo?: string;
  sandbox?: boolean;
  /** Not picking up turns until resumed. */
  paused?: boolean;
  /**
   * A shared turn waits here for the person's own prompt in this Claude Code to finish. Only its
   * owner is told: what someone does in their own Claude Code is theirs.
   */
  busy?: boolean;
  /** The branch this runner's Claude Code session currently holds context for. */
  focus?: { conversationId: Id; branchId: Id };
  at: number;
}
