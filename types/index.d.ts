// The values this mod keeps in `$.state` (the host holds them for the session,
// across hot reloads of the module): what the pane draws, and what a reload
// needs to keep running the turn it was running.

export type MultiplayerPerson = {
  name: string
  role: string
  /** Their Claude Code or claude.ai runner is connected (as of the last sync). */
  runner: boolean
  /** Their web app is open (as of the last sync). */
  here: boolean
  isMe: boolean
}

export type MultiplayerTurnRow = {
  id: string
  who: string
  text: string
  status: string
}

export type MultiplayerView = {
  isSignedIn: boolean
  space: string
  code: string
  /** The web link, token included. Drawn in the pane only, never sent to the model. */
  link: string
  me: string
  /** The status line's last part: "running Sam's turn", "paused", ... */
  status: string
  /** The status needs the person (an approval, their turn held up): it's a warning line under the prompt, else a dim footer label. */
  needsYou: boolean
  people: MultiplayerPerson[]
  turns: MultiplayerTurnRow[]
  /** An approval this runner is waiting on, if any (`always`: what "don't ask again" would cover). */
  approval: { requestId?: string; tool: string; title: string; always?: string } | null
  /**
   * People asking this Claude Code something, oldest first: to run their turn here, or to move a
   * conversation. `space`: the conversation's title. (Absent in a view kept from before.)
   */
  asks?: { id?: string; from: string; kind: 'run-here' | 'move' | 'project'; space: string }[]
  /** What Claude is doing now in the space, newest first: for the band above the prompt. */
  now?: { turnId: string; line: string }[]
  /** Who's writing (others), with their words when they show them. */
  writers?: { who: string; draft?: string }[]
  /** The conversation typing here goes to, while following one. */
  follow?: string
}

/** One step of a shared turn, as its mirror row draws it (like Claude Code's own tool rows). */
export type MultiplayerFeedStep = { tool: string; text: string; state: 'run' | 'done' | 'fail' | 'wait' | 'denied'; under: boolean }

/** What one shared turn's row in this Claude Code's transcript draws (the Multiplayer mirror; display only). */
export type MultiplayerFeed = {
  id: string
  /** The conversation, and the branch when it isn't main. */
  where: string
  /** Who wrote what ("You" for this person). */
  parts: { who: string; text: string }[]
  /** "your Claude Code" or "Kim's Claude Code". */
  runner: string
  status: 'waiting' | 'held' | 'running' | 'approval' | 'paused' | 'done' | 'stopped' | 'failed'
  /** One line on where it stands: what it waits for, or how it ended. */
  line: string
  /** Its latest steps, and how many came before them. */
  steps: MultiplayerFeedStep[]
  more: number
  /** The answer so far. */
  text: string
  /** What people added while Claude worked: queued until read. */
  queued: { who: string; text: string; state: 'queued' | 'read' }[]
  /** An approval this Claude Code waits on for it (only this runner's own). */
  approval: { requestId: string; title: string; always?: string } | null
}

/** What survives a hot reload of the module while a shared turn runs. */
export type MultiplayerMemo = {
  /** The runner session id sent with hello and every poll. */
  runnerSession: string
  /** The shared turn this session is running, and the Claude Code turn running it. */
  active: { turnId: string; branchId: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    multiplayer: { view: MultiplayerView; memo: MultiplayerMemo; feed: StateFamily<MultiplayerFeed>; note: StateFamily<string> }
  }
}
