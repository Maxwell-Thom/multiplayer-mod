# Multiplayer for Claude Code

This mod makes your Claude Code the **runner** for your turns in a shared Multiplayer conversation. A turn runs on the Claude of the person who sends it, so when you send a turn (or take one over), it runs on this machine, on your own plan. The server only relays text.

Each branch of a shared conversation is a **real Claude Code session** on your machine, separate from the one you have open. Your turns on a branch go into that branch's session, word for word, the way a Claude Code session keeps its own turns. Other people's turns reach it as notes. A new branch is a native fork of its parent's session, made at the turn it branched from. Claude Code's own compaction handles length. `/resume` lists these sessions under "Multiplayer · <space> · <branch>".

While a session with the mod is open it:

- signs in to your space and long-polls the server for turns assigned to you;
- runs each turn in its branch's own Claude Code session (`claude -p --resume …`), in the background, with your settings, CLAUDE.md, skills and MCP servers, as any session of yours has them;
- gives that session what it can't have: the people, decisions and open questions when they change, and the turns that ran on other people's machines since its last turn, word for word;
- streams Claude's text and tool steps to everyone, and sends the answer when the turn ends;
- forwards permission questions to your web app, so you can approve from there or here;
- gives Claude two tools, `propose_decision` and `add_question`, that record into the space;
- answers file requests from your web app (incoming commits, pull, resolve conflicts) with git on this machine.

## Requirements

- Claude Code **2.1.308 or later** (the mod is a function-hooks module).
- An invitation to the hosted Multiplayer (the default), or a Multiplayer server of your own (`npm start` at the root of the Multiplayer repository runs one on `http://localhost:8787`).
- Claude Code signed in with `/login` (or an `apiKeyHelper` in settings). Shared turns run in sessions the mod starts, and a token in `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` doesn't reach those. The mod checks with `claude auth status` when it connects, and says so if they can't sign in.
- `git` on your PATH, for the file features. Everything else works without it.

## Install

At the prompt of any Claude Code session:

```
/plugin marketplace add Maxwell-Thom/multiplayer-mod
/plugin install multiplayer@multiplayer
```

Or from a shell: `claude plugin marketplace add Maxwell-Thom/multiplayer-mod`, then `claude plugin install multiplayer@multiplayer`.

It connects to the hosted Multiplayer (https://maxwell-thom.github.io/multiplayer/) by default. That one is invite only: `/multiplayer login` signs this Claude Code in, with a link you approve in the web app. For a server of your own, set **/config › Multiplayer › Server URL**.

`Maxwell-Thom/multiplayer-mod` is a published copy. The mod is developed in `packages/mod` of the Multiplayer repository, and a workflow there copies it over on every change; `/plugin marketplace update multiplayer` picks up the new version.

### From a clone (to work on the mod)

The steps are the same on macOS, Linux and Windows; only the path differs. Add the folder as a marketplace, then install from it. Claude Code reads the plugin from the folder itself, so after a `git pull` a `/reload-plugins` picks up the new version.

macOS / Linux:

```sh
claude plugin marketplace add ~/src/multiplayer/packages/mod
claude plugin install multiplayer@multiplayer --config server=http://localhost:8787
```

Windows (PowerShell or cmd):

```powershell
claude plugin marketplace add C:\src\multiplayer\packages\mod
claude plugin install multiplayer@multiplayer --config server=http://localhost:8787
```

Or, at the prompt of a running Claude Code session:

```
/plugin marketplace add ~/src/multiplayer/packages/mod
/plugin install multiplayer@multiplayer
```

### Or run it without installing

For one session:

```sh
claude --plugin-dir ~/src/multiplayer/packages/mod
```

For every session, list the folder in `CLAUDE_CODE_PLUGIN_DIRS`, either in your shell or in the `env` block of `~/.claude/settings.json`. Separate several folders with `:` on macOS and Linux, and with `;` on Windows:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\src\\multiplayer\\packages\\mod" } }
```

## Point it at a server

The mod has two settings. Change them in `/config` (under Multiplayer), or from a shell:

```sh
echo '{"server":"https://multiplayer.example.com"}' | claude plugin configure multiplayer@multiplayer --values-stdin
```

| Setting | What it is |
| --- | --- |
| `server` | The server URL. Default: the hosted Multiplayer, `https://server-production-491c.up.railway.app`. Used when you start, join, connect or log in; a space you are signed in to remembers its own server. |
| `name` | The name others see when you start or join from here. If it's empty, you are asked. |

For a `--plugin-dir` run, the same values live in `settings.json` under `pluginConfigs`:

```json
{ "pluginConfigs": { "multiplayer": { "options": { "server": "https://multiplayer.example.com" } } } }
```

## Commands

| Command | What it does |
| --- | --- |
| `/multiplayer` | Opens the Multiplayer pane (the space, who's connected, turns in flight, your web link) and prints the status. |
| `/multiplayer start <space name> [--as <your name>]` | Starts a space with you as host, and prints its join code. |
| `/multiplayer join <code> [your name]` | Joins a space with a code like `MC-7Q2X-K4MP`. |
| `/multiplayer connect <pairing code>` | Signs this Claude Code in as you, if you joined in the browser. Make the code in the web app. |
| `/multiplayer login` | On an invite-only (hosted) server: signs this Claude Code in to your account. It shows a link and a code; open the link, signed in to the web app, and approve. No password is typed here. `start` and `join` begin this by themselves when needed, and carry on once you approve. The sign-in lasts 90 days. |
| `/multiplayer import [session id]` | Brings this Claude Code conversation (or, with no turns here, one you pick from this folder's recent sessions) into a space, exactly as it went: every prompt, answer and tool step. It asks whether it goes in a new conversation of the space you're in or a new space. Your turns on it carry on in a fork of that very session (`--resume … --fork-session --resume-session-at` its last answer), so this Claude Code remembers everything it read and did; the session itself is untouched. Others' Claude reads the whole conversation. Sessions up to 4 MB for now. `--here` or `--new` skip the question. |
| `/multiplayer logout` | Signs this Claude Code out of your account (the server forgets its sign-in) and forgets its sign-in to the space. |
| `/multiplayer status` | Shows the space, the people, and the turns in flight. |
| `/multiplayer open` | Shows your web link. It contains your sign-in, so it goes in a dim line the model never reads, not into the conversation. |
| `/multiplayer pause` / `resume` | Stops or restarts picking up turns. A turn already running finishes first. |
| `/multiplayer allow [always]` / `deny` | Answers the permission question a shared turn is waiting on (or answer it in the web app). "Always" covers what Claude Code's own "don't ask again" would: the exact command, the site, the MCP tool, or file edits for the rest of the turn. |
| `/multiplayer stop` | Stops the shared turn running here, for everyone. What Claude wrote so far stays. |
| `/multiplayer share <what>` | Brings something from this session into the shared conversation. This session's Claude drafts a note about it here, where you read it; nothing leaves yet. |
| `/multiplayer post [text]` | Shares that draft (or your own words) as a note on the branch you last ran a turn on, else the main line. Everyone sees it, and the next shared turn reads it. |
| `/multiplayer take-home` | Prints the command that opens a private copy of the current branch's session (`claude --resume <id> --fork-session`), so you can carry on alone. Nothing done in the copy is shared. If this machine has no session for the branch, the branch's conversation is brought into this session as a note instead. |
| `/multiplayer leave` | Forgets this Claude Code's sign-in to the space. You stay a member of the space; leave it from the web app. |

The status line shows `Multiplayer · <space> · <what's happening>`, for example `running Sam's turn` or `Sam's turn is waiting for you to finish`.

## What happens during a shared turn

- **One thing at a time.** A shared turn starts only when this session is idle, so it never edits files under you. If you're in the middle of your own turn, it waits, and a toast tells you so.
- **Conflicts first.** If several people wrote the turn, a small model (Haiku) first checks whether their parts contradict each other. If they do, the turn goes back to the group to settle, and nothing runs.
- **Your plan, your limits.** If your plan's rate limit is used up, the turn is declined before it runs, and the parts go back to the draft so someone else can send them. A limit reached mid-turn ends the turn with reason `limit` and the reset time.
- **Model pins.** A branch's pinned model and effort go to its session as `--model` and `--effort`, checked first with a one-token request. If the model can't be used, the turn is declined as `model-unavailable`.
- **Whose setup.** A shared turn's session has your plugins, skills, MCP servers, connectors and CLAUDE.md, unless the space's host turns on "Shared turns use the project's setup only". Then it gets only the project's (`--setting-sources project,local`, claude.ai connectors off), the same as everyone else's. Your own protections stay either way: your deny and ask rules, hooks and `apiKeyHelper` are passed with `--settings`. Your private lanes and recaps always have your whole setup.
- **Sign-in.** If the sessions shared turns run in can't sign in, the turn goes back to the draft (`not-signed-in`) and you're told to run `/login`.
- **Stops.** Someone stopping the turn from the web app, or `/multiplayer stop` here, ends its session's process; the partial answer is kept for everyone.
- **Turns that didn't finish.** A turn that failed, was stopped or was taken over is set aside in the branch's session: the next turn forks back to the last turn that ended with its answer, and hears the set-aside one as everyone else's sessions do. So the session always matches what everyone sees.
- **Approvals.** The branch's session asks permission as Claude Code does, through the space (`--permission-prompt-tool`): the question goes to your web app, which only you see, and to this session's pane. Answer it in either place. "Always" writes Claude Code's own rule into the project's `.claude/settings.local.json`, scoped as Claude Code's "don't ask again" is. Pages on the sites the space's policy lists are fetched without asking.
- **Privacy.** Your working directory, account and git details go only to you, in the runner info. Steps others see show paths relative to your project, never your home folder. In a shared branch session your auto-memory section is left out of the system prompt, and Claude is told to keep your personal notes out. A private lane's session keeps it.
- **Pushes.** If Claude commits and pushes during a shared turn, the space is told which commits were pushed. The mod itself never pushes, never force-anythings, and never discards local changes. A pull with uncommitted changes is refused.

If you close Claude Code (or `/exit`) while it runs a shared turn, the turn ends for everyone at once and anyone can send it again on their plan; a turn waiting for you goes back to the draft. A `/clear` doesn't stop the mod. If the network drops as a turn ends, the mod keeps sending the answer until the server has it.

If you open a second Claude Code signed in as the same person, the newer one takes over your turns. The older one says so in its status line; `/multiplayer resume` takes them back, and it takes them back by itself once the newer one has gone (within about a minute of it closing). Since the mod is installed for your user, that includes any Claude Code you open elsewhere, even a one-off `claude -p`.

## Develop

From `packages/mod`:

```sh
npm run sync-protocol   # copy the protocol's pure files into hooks/lib (run after changing packages/protocol)
npm run check-protocol  # fail if hooks/lib is out of date
npm run validate        # claude plugin validate .
npm test                # claude plugin test . (tests/*.test.ts, against an in-memory server)
npm run typecheck       # tsc over hooks/, types/ and tests/
```

`typecheck` needs Claude Code's plugin API declarations. The engine writes them into `.claude-plugin/types/` (git-ignored) the first time you run `claude --plugin-dir packages/mod` interactively. Otherwise, pass a declarations file: `node scripts/typecheck.mjs --types /path/to/claude-code.d.ts`, or set `CLAUDE_CODE_TYPES`.

Layout:

- `hooks/register.tsx` is the hooks module. It wires the engine's events to the runner and draws the pane. Every call on `$` is written there, in the `io` port built in `session.start`.
- `hooks/runner.ts` holds the runner: the poll loop, turns, branch sessions, approvals, files, commands and status.
- `hooks/child.ts` starts a branch's session (its `claude -p` arguments) and reads its stream-json output.
- `hooks/client.ts` is the HTTP wire, the same calls as `packages/sim`'s `RunnerClient`.
- `hooks/git.ts` handles status, pull, per-hunk resolve and push detection.
- `hooks/format.ts` has the labels, step text, model names, the conflict judge and the take-home transcript.
- `hooks/lib/` holds copies of `packages/protocol/src` (`decide.ts` and `run.ts` are only for the tests' fake server).
- `types/index.d.ts` declares the `$.state` values the pane reads.
- `tests/` has the kit tests and a fake server that runs the protocol's own rules.
