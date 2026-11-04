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
  /** An approval this runner is waiting on, if any. */
  approval: { tool: string; title: string } | null
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
    multiplayer: { view: MultiplayerView; memo: MultiplayerMemo }
  }
}
