// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Ask, Branch, Decision, Effort, Id, ModelPin, ImportTurn, MemberId, Note, Question, SpaceState, Turn, TurnWork } from './types.ts';

export const ACTIVE_STATUSES: Turn['status'][] = ['requested', 'held', 'conflict', 'running', 'approval', 'paused'];

export function isActive(t: Turn | undefined): boolean {
  return !!t && ACTIVE_STATUSES.includes(t.status);
}

/** The turn currently in flight on a branch, if any. One at a time per branch. */
export function activeTurn(s: SpaceState, branchId: Id): Turn | undefined {
  const items = s.timeline[branchId] || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    // A recap or a side question is private to its asker and never holds up the branch.
    if (it.kind === 'turn' && isActive(s.turns[it.id]) && !isOneOff(s.turns[it.id])) return s.turns[it.id];
  }
  return undefined;
}

/** A recap or a side question: private to its asker, run once, never part of the branch's history or holding it. */
/** Whether a turn sent by `senderId` may run in `runnerId`'s Claude Code in this conversation without asking. */
export function mayRunFor(s: SpaceState, conversationId: Id, runnerId: MemberId, senderId: MemberId): boolean {
  return runnerId === senderId || !!s.conversations[conversationId]?.allowed?.[runnerId]?.includes(senderId);
}

/** The asks still waiting on a turn. */
export function openAsks(s: SpaceState, turnId: Id): Ask[] {
  return Object.values(s.asks).filter((a) => a.turnId === turnId && a.status === 'open');
}

/**
 * What a runner's turns on a branch left only on its computer: uncommitted files and commits not
 * pushed, from each turn's work report (minus work that has since moved to another Claude Code).
 */
export function leftBehind(s: SpaceState, branchId: Id, runnerId: MemberId): { files: number; commits: number } {
  // A file several turns changed is one file; files past a turn's list are counted as they come.
  const named = new Set<string>();
  const shas = new Set<string>();
  let more = 0;
  for (const t of Object.values(s.turns)) {
    const w = t.work;
    if (t.branchId !== branchId || !w || workWhere(t) !== runnerId) continue;
    for (const f of w.uncommitted ?? []) named.add(f);
    more += w.more ?? 0;
    if (!w.pushed) for (const c of w.commits ?? []) shas.add(c.sha);
  }
  return { files: named.size + more, commits: shas.size };
}

/** Whose computer a turn's changes are on: where a move last took them, else where it ran. */
export function workWhere(t: Turn): MemberId {
  return t.work?.movedTo ?? t.runnerId;
}

/** "2 files and 1 commit", "3 files", "1 commit", or '' for nothing. */
export function countText(files: number, commits: number): string {
  const f = files ? `${files} file${files === 1 ? '' : 's'}` : '';
  const c = commits ? `${commits} commit${commits === 1 ? '' : 's'}` : '';
  return [f, c].filter(Boolean).join(' and ');
}

/** Whose Claude Code a branch runs in, or null when nobody's yet. */
export function branchRunner(s: SpaceState, branchId: Id): MemberId | null {
  return s.branches[branchId]?.runnerId ?? null;
}

export function isOneOff(t: Turn): boolean {
  return t.mode === 'recap' || t.mode === 'aside' || t.mode === 'context';
}

/** How a branch session reads a note someone shared. */
export function noteLine(s: SpaceState, n: Note): string {
  const who = memberName(s, n.memberId);
  if (n.turnId) return `${who} brought back a side question. They asked: ${n.question ?? ''}\nThe answer: ${n.text}`;
  return `${who}${n.fromBranchId ? ' (from their private lane)' : ' (from their own Claude Code)'}: ${n.text}${n.question ? `\nThey ask: ${n.question}` : ''}`;
}

export function turnsOf(s: SpaceState, branchId: Id): Turn[] {
  return (s.timeline[branchId] || []).filter((i) => i.kind === 'turn').map((i) => s.turns[i.id]).filter(Boolean);
}

export function latestTurnId(s: SpaceState, branchId: Id): Id | null {
  const ts = turnsOf(s, branchId);
  return ts.length ? ts[ts.length - 1].id : null;
}

export function mainOf(s: SpaceState, conversationId: Id): Branch | undefined {
  const c = s.conversations[conversationId];
  return c ? s.branches[c.mainBranchId] : undefined;
}

export function isMain(s: SpaceState, branchId: Id): boolean {
  const b = s.branches[branchId];
  if (!b) return false;
  return s.conversations[b.conversationId]?.mainBranchId === branchId;
}

export function canSee(s: SpaceState, memberId: MemberId | 'server', branchId: Id): boolean {
  const b = s.branches[branchId];
  if (!b) return false;
  if (!b.private) return true;
  return memberId === 'server' || b.ownerId === memberId;
}

/**
 * The turns a branch's context holds, oldest first: the parent's up to where
 * the branch forked (minus a turn the branch was made by editing), then its own.
 */
export function historyTurns(s: SpaceState, branchId: Id, depth = 0): Turn[] {
  const b = s.branches[branchId];
  if (!b || depth > 20) return [];
  let inherited: Turn[] = [];
  if (b.parentId) {
    const parent = historyTurns(s, b.parentId, depth + 1);
    if (b.forkTurnId) {
      const at = parent.findIndex((t) => t.id === b.forkTurnId);
      inherited = at === -1 ? parent : parent.slice(0, at + 1);
    } else {
      inherited = [];
    }
    if (b.editOf) inherited = inherited.filter((t) => t.id !== b.editOf);
    if (b.editOf && b.forkTurnId === b.editOf) {
      // forked at the edited turn: keep everything before it
      const at = parent.findIndex((t) => t.id === b.editOf);
      inherited = at === -1 ? inherited : parent.slice(0, at);
    }
  }
  return [...inherited, ...turnsOf(s, branchId)];
}

/** Decisions that hold for the whole space: approved, not replaced. */
export function spaceDecisions(s: SpaceState): Decision[] {
  return s.decisions.filter((d) => d.branchId === null && d.status === 'approved');
}

/** Decisions a branch sees: the space's, plus its own (and its ancestors'). */
/** The branch and the branches it came from. */
function lineage(s: SpaceState, branchId: Id): Set<Id> {
  const chain = new Set<Id>();
  let b: Branch | undefined = s.branches[branchId];
  let guard = 0;
  while (b && guard++ < 20) { chain.add(b.id); b = b.parentId ? s.branches[b.parentId] : undefined; }
  return chain;
}

/**
 * Whether something made on a main line holds in a conversation: it was made there, or
 * that conversation carried it in when it started. Logs from before conversations were
 * recorded on decisions and questions have none, and those hold everywhere.
 */
export function inConversation(s: SpaceState, x: { id: string; conversationId?: Id }, conversationId: Id | undefined): boolean {
  if (!x.conversationId || !conversationId) return true;
  return x.conversationId === conversationId || !!s.conversations[conversationId]?.carried.includes(x.id);
}

/** Decisions that hold on a branch: its conversation's (and those carried in), and its own line's. */
export function branchDecisions(s: SpaceState, branchId: Id): Decision[] {
  const chain = lineage(s, branchId);
  const conv = s.branches[branchId]?.conversationId;
  return s.decisions.filter((d) => d.status !== 'withdrawn' && (d.branchId === null ? inConversation(s, d, conv) : chain.has(d.branchId)));
}

/** Open questions on a branch: its conversation's, and those asked on its own line. */
export function branchQuestions(s: SpaceState, branchId: Id): Question[] {
  const chain = lineage(s, branchId);
  const conv = s.branches[branchId]?.conversationId;
  return s.questions.filter((q) => !q.resolvedAt && (q.branchId === null ? inConversation(s, q, conv) : chain.has(q.branchId)));
}

export function nextDecisionId(s: SpaceState): string {
  let n = 0;
  for (const d of s.decisions) n = Math.max(n, parseInt(d.id.slice(1), 10) || 0);
  return 'D' + (n + 1);
}

export function nextQuestionId(s: SpaceState): string {
  let n = 0;
  for (const q of s.questions) n = Math.max(n, parseInt(q.id.slice(1), 10) || 0);
  return 'Q' + (n + 1);
}

export function memberName(s: SpaceState, id: MemberId | 'claude' | 'server'): string {
  if (id === 'claude') return 'Claude';
  if (id === 'server') return 'Multiplayer';
  return s.members[id]?.name ?? 'Someone';
}

export function activeMembers(s: SpaceState): MemberId[] {
  return Object.values(s.members).filter((m) => !m.leftAt).map((m) => m.id);
}

/**
 * "Opus", "Sonnet 4.5", "Fable 5.1", "Opus · 1M", "Opus plan", "Best available", from an alias
 * or a full model id. No name is "Default": the model the Claude Code it runs in would pick.
 */
export function modelLabel(name: string | undefined): string {
  if (!name || /^default$/i.test(name)) return 'Default';
  const oneM = /\[1m\]$/i.test(name) ? ' · 1M' : '';
  const n = name.toLowerCase().replace(/\[1m\]$/, '');
  if (n === 'best') return 'Best available';
  if (n === 'opusplan') return `Opus plan${oneM}`;
  const fam = n.includes('fable') ? 'Fable' : n.includes('opus') ? 'Opus' : n.includes('sonnet') ? 'Sonnet' : n.includes('haiku') ? 'Haiku' : null;
  if (!fam) return name;
  const v = n.match(/(?:fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/);
  if (v) return `${fam} ${v[1]}${v[2] ? `.${v[2]}` : ''}${oneM}`;
  // The older ids put the version first: claude-3-5-sonnet.
  const old = n.match(/(\d+)[-.](\d+)/);
  return `${old ? `${fam} ${old[1]}.${old[2]}` : fam}${oneM}`;
}

/**
 * Why `actor` can't add to turn `t` while Claude works: it takes the standing that sending there
 * without asking does (its runner, or someone it lets send there, past a branch owner's yes), never
 * just having sent it (a yes to one prompt is a yes to that prompt), and only once it may run.
 */
export function steerRefusal(s: SpaceState, t: Turn | undefined, actor: MemberId): string | null {
  if (!t) return 'No such turn.';
  if (t.status === 'held' || t.status === 'conflict') return 'That turn is still waiting for a yes. Add it to the next prompt.';
  if (!isActive(t)) return 'That turn has finished. Add it to the next prompt.';
  if (actor === t.runnerId) return null;
  const b = s.branches[t.branchId];
  if (!b || b.private || t.private) return 'Only its person can add to a private turn.';
  if (!mayRunFor(s, t.conversationId, t.runnerId, actor)) return `Only people ${memberName(s, t.runnerId)} lets send here can add to a running turn.`;
  // (The same as sending there: a branch owner's yes is asked for each turn, even in their own Claude Code.)
  if (b.ownerId && b.ownerId !== actor && s.space.policy.ownerOk && !s.members[b.ownerId]?.leftAt) return `${memberName(s, b.ownerId)} says yes first on this branch, so add it to the next prompt.`;
  return null;
}

const REFUSED: Record<string, string> = {
  clear: '/clear would empty this conversation’s session for everyone, so it isn’t available here.',
  config: '/config would change settings on the computer this runs on, so it isn’t available here. Pick the model and its settings for everyone from the model menu instead.',
  login: '/login signs Claude Code in on its own computer, so it isn’t available here.',
  logout: '/logout signs Claude Code out on its own computer, so it isn’t available here.',
  rewind: '/rewind would change this conversation’s session for everyone. Edit an earlier turn to branch from it instead.',
  resume: '/resume would swap this conversation’s session for another, so it isn’t available here.',
  plugin: '/plugin installs things on the computer this runs on, so it isn’t available here.',
  permissions: '/permissions changes rules on the computer this runs on, so it isn’t available here.',
  hooks: '/hooks changes what runs on the computer this runs on, so it isn’t available here.',
  mcp: '/mcp changes servers on the computer this runs on, so it isn’t available here.',
};

/** Why a part can't be one of Claude Code's own commands here (one that would change everyone's session, or someone's computer). */
export function slashRefusal(text: string): string | null {
  const m = text.trim().match(/^\/([a-z-]+)(?:\s|$)/i);
  return m ? REFUSED[m[1].toLowerCase()] ?? null : null;
}

/** Where Claude Code's Auto mode runs: Opus and Sonnet 4.6 and newer, Haiku 5.5, Fable (and a model it can't tell). */
export function autoModeOk(model: string): boolean {
  const v = modelVersion(model);
  if (!v) return true;
  if (v.family === 'fable') return true;
  if (v.family === 'haiku') return v.major > 5 || (v.major === 5 && v.minor >= 5);
  return v.major > 4 || (v.major === 4 && v.minor >= 6);
}

/** Fast mode's models: Opus 5.5, Opus 5 and Opus 4.8 (and their 1M versions); not Opus plan, which builds on Sonnet. */
export function fastOk(model: string): boolean {
  if (/^opusplan/i.test(model)) return false;
  const v = modelVersion(model);
  return !!v && v.family === 'opus' && ((v.major === 5 && (v.minor === 5 || v.minor === 0)) || (v.major === 4 && v.minor === 8));
}

/** The output styles a branch can set for everyone (Learning only on a private lane). */
export const STYLES = ['default', 'Concise', 'Explanatory', 'Proactive', 'Learning'] as const;

/** Whether thinking can be turned off: only on Opus 4.6, Sonnet 4.6 and Opus 4.8 (the others always think). */
export function thinkingToggles(model: string): boolean {
  return /^claude-(opus-4-6|sonnet-4-6|opus-4-8)(\[1m\])?$/i.test(model.trim());
}

/** A pin in words, as its line says it: "Opus · Default (Medium) · fast · Concise · Fable advising". */
export function pinText(pin: Pick<ModelPin, 'name' | 'effort'> & Partial<Pick<ModelPin, 'fast' | 'style' | 'advisor' | 'thinking' | 'fallback'>>): string {
  return [
    modelLabel(pin.name), effortLabel(pin.effort, pin.name), pin.fast ? 'fast' : '',
    pin.style ? (pin.style === 'default' ? 'Default style' : pin.style) : '',
    pin.advisor ? (pin.advisor === 'off' ? 'no advisor' : `${modelLabel(pin.advisor)} advising`) : '',
    pin.thinking === false ? 'thinking off' : '', pin.fallback ? `falls back to ${modelLabel(pin.fallback)}` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Whether a turn may bill usage credits: fast mode, or any model but the ones known not to (Opus,
 * Sonnet, Haiku and Opus plan), so Fable, Best available and anything unknown need a yes. Default
 * is its runner's own choice: their Claude Code checks what that is before it runs.
 */
export function usesCredits(pin: { name: string; fast?: boolean }): boolean {
  if (pin.fast) return true;
  const n = pin.name.trim().toLowerCase().replace(/\[1m\]$/, '');
  if (!n || n === 'default') return false;
  return !(n === 'opusplan' || (/opus|sonnet|haiku/.test(n) && !n.includes('fable')));
}

/**
 * Why a turn on `model` can't run in `runnerId`'s Claude Code for `senderId`: Fable bills usage
 * credits without asking there, so it runs only with its runner's yes (their turns only, unless
 * they allow everyone's; never, if they turned it off). Null when it may run. Fast mode isn't
 * refused: without that yes it runs at standard speed.
 */
export function creditsRefusalFor(s: SpaceState, model: string, runnerId: MemberId, senderId: MemberId): string | null {
  if (!usesCredits({ name: model })) return null;
  const allows = s.members[runnerId]?.prefs?.credits ?? 'mine';
  const what = /fable/i.test(model) ? 'Fable' : modelLabel(model);
  // Each says why, and what to do about it.
  if (runnerId === senderId) return allows === 'off' ? `${what} may bill your usage credits, and you’ve turned that off in Where it runs. Turn it on there, or pick another model.` : null;
  if (allows === 'everyone') return null;
  const name = memberName(s, runnerId);
  return allows === 'off' ? `${what} may bill ${name}’s usage credits, and ${name} has turned that off. Pick another model.` : `${what} may bill ${name}’s usage credits. ${name} allows that for their own turns only: ask them to allow everyone’s turns in Where it runs, or pick another model.`;
}

/** The same, for `senderId`'s next turn on a branch, where it would run now (for a warning before sending). */
export function creditsRefusal(s: SpaceState, branchId: Id, senderId: MemberId): string | null {
  const b = s.branches[branchId];
  return b ? creditsRefusalFor(s, b.model.name, b.runnerId ?? senderId, senderId) : null;
}

/** Claude Code's effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORTS)[number];

/**
 * A model's family and version from an alias or a full id: `opus`, `sonnet` and `haiku` are
 * 5.5, `fable` and `best` Fable 5.1, `opusplan` Opus 5.5. Null when the model isn't known
 * (Claude Code's own default, or a name with no version).
 */
function modelVersion(name: string): { family: string; major: number; minor: number } | null {
  const n = name.toLowerCase().replace(/\[1m\]$/, '');
  if (n === 'opus' || n === 'sonnet' || n === 'haiku') return { family: n, major: 5, minor: 5 };
  if (n === 'opusplan') return { family: 'opus', major: 5, minor: 5 };
  if (n === 'fable' || n === 'best') return { family: 'fable', major: 5, minor: 1 };
  const m = n.match(/(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/);
  return m ? { family: m[1], major: Number(m[2]), minor: Number(m[3] ?? 0) } : null;
}

/** The effort levels a model has (Claude Code runs any other as the highest it has at or below). */
export function effortsFor(model: string): EffortLevel[] {
  const v = modelVersion(model);
  if (!v) return model && !/^default$/i.test(model) ? [] : [...EFFORTS];
  if (v.major >= 5 || (v.major === 4 && v.minor >= 7)) return [...EFFORTS];
  if (v.major === 4 && v.minor === 6) return ['low', 'medium', 'high', 'max'];
  return [];
}

/** The level a model runs at when nobody picks one: medium on the 5.5 models, xhigh on Opus 4.7, else high. */
export function defaultEffort(model: string): EffortLevel | null {
  const v = modelVersion(model);
  if (!v || !effortsFor(model).length) return null;
  if (v.family !== 'fable' && (v.major > 5 || (v.major === 5 && v.minor >= 5))) return 'medium';
  if (v.family === 'opus' && v.major === 4 && v.minor === 7) return 'xhigh';
  return 'high';
}

const EFFORT_NAMES: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** "Extra high", or "Default (Medium)" for the model's own level. */
export function effortLabel(e: Effort, model?: string): string {
  if (e !== 'auto') return EFFORT_NAMES[e] ?? e;
  const d = model ? defaultEffort(model) : null;
  return d ? `Default (${EFFORT_NAMES[d]})` : 'Default';
}

const isLevel = (v: unknown): v is EffortLevel => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

/**
 * The level a turn runs at, as Claude Code settles it: its effort variable (`env`) over the pick,
 * the model's default for `auto`, a runner's `maxEffortLevel` (`max`) as a cap, and the highest
 * level the model has at or below. Null when the model has no levels, or its default isn't known.
 */
export function resolveEffort(model: string, e: Effort, caps: { max?: string; env?: string } = {}): EffortLevel | null {
  const env = caps.env?.trim().toLowerCase();
  const pick: Effort = isLevel(env) ? env : env === 'auto' || env === 'unset' ? 'auto' : e;
  let level = pick === 'auto' ? defaultEffort(model) : isLevel(pick) ? pick : null;
  const levels = effortsFor(model);
  if (!level || !levels.length) return null;
  if (isLevel(caps.max) && EFFORTS.indexOf(caps.max) < EFFORTS.indexOf(level)) level = caps.max;
  const at = EFFORTS.indexOf(level);
  return [...levels].reverse().find((l) => EFFORTS.indexOf(l) <= at) ?? levels[0];
}

/** Where a turn's file changes stand, from its work record. */
export type WorkStatus = 'none' | 'no-repo' | 'uncommitted' | 'unpushed' | 'pushed';

export function workStatus(w: TurnWork | undefined): WorkStatus {
  if (!w) return 'none';
  if (w.noRepo) return 'no-repo';
  if (w.uncommitted?.length || w.more) return 'uncommitted';
  if (w.commits?.length) return w.pushed ? 'pushed' : 'unpushed';
  return 'none';
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The files a turn's work names: "src/a.ts, src/b.ts and 3 more". */
export function workFiles(w: TurnWork, max = 3): string {
  const named = w.uncommitted ?? [];
  const extra = Math.max(0, named.length - max) + (w.more ?? 0);
  return [named.slice(0, max).map((f) => clip(f, 120)).join(', '), extra ? `${extra} more` : ''].filter(Boolean).join(' and ');
}

/** One short line on where a turn's changes are, for people ("your computer" for its runner). */
export function workLine(s: SpaceState, t: Turn, viewer?: MemberId): string {
  const w = t.work;
  const st = workStatus(w);
  if (!w || st === 'none') return '';
  const whose = viewer === t.runnerId ? 'your computer' : `${memberName(s, t.runnerId)}’s computer`;
  const n = (w.uncommitted?.length ?? 0) + (w.more ?? 0);
  const c = w.commits?.length ?? 0;
  if (st === 'no-repo') return `Changed ${n ? count(n, 'file') : 'files'} on ${whose}, outside git: others can’t pull them`;
  if (st === 'uncommitted') return `${count(n, 'file')} changed on ${whose}, not committed${c ? ` · ${count(c, 'commit')} ${w.pushed ? `pushed to ${w.pushed}` : 'not pushed'}` : ''}`;
  if (st === 'unpushed') return `${count(c, 'commit')} on ${whose}, not pushed`;
  return `${count(c, 'commit')} pushed to ${w.pushed}`;
}

export function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

export function hhmm(at: number): string {
  const d = new Date(at);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

/**
 * What a person is asked to approve when a shared turn wants a tool: a title everyone
 * may see ("Run a command"), and the detail only the person whose machine it is sees.
 */
/** A site as a space lists it: a hostname, `*.` in front for its subdomains (what Claude Code's `WebFetch(domain:…)` takes). */
export function isSite(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 253 && /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(v);
}

/** A model as Claude Code's `--model` takes it: an alias (`haiku`, `opus[1m]`) or a full id. Empty is "the default". */
export function isModelName(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/.test(v);
}

/**
 * The site a URL fetches from, read the way fetch reads it (WHATWG URL). Undefined for
 * anything that could make the shown site differ from the one fetched: credentials in it,
 * a scheme other than http(s), a host that isn't a plain hostname.
 */
export function siteOf(url: string): string | undefined {
  if (typeof URL !== 'function') return undefined;
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return isSite(host) ? host : undefined;
}

/**
 * What "always" covers when a shared turn's session asks permission, scoped as Claude Code's
 * own "don't ask again" is: Bash the exact command, WebFetch the site, an MCP tool by name,
 * file edits for the rest of the turn. Null when it can only be allowed this once.
 */
export type AlwaysScope =
  | { kind: 'command'; command: string }
  | { kind: 'site'; site: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'edits' };

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export function alwaysScope(tool: string, input: Record<string, unknown>): AlwaysScope | null {
  if (tool === 'Bash') {
    const c = typeof input.command === 'string' ? input.command : '';
    if (!c.trim() || c.length > 1000 || /[\r\n\0]/.test(c)) return null;
    // A command that writes a file (`>`) is asked for as an edit, and an exact rule doesn't cover
    // it; Claude Code's own prompt offers access to the folder instead.
    if (writesFile(c)) return { kind: 'edits' };
    // A `*` (or a trailing `:*`) would make the rule match other commands too.
    return c.includes('*') ? null : { kind: 'command', command: c };
  }
  if (tool === 'WebFetch') {
    const site = approvalCard(tool, input).site;
    return site && isSite(site) ? { kind: 'site', site } : null;
  }
  if (EDIT_TOOLS.has(tool)) return { kind: 'edits' };
  if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(tool) && !tool.startsWith('mcp__multiplayer__')) return { kind: 'tool', tool };
  return null;
}

/** Whether a shell command sends output to a file (`>`, `>>`; not `2>&1`), quoted text aside. */
function writesFile(command: string): boolean {
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');
  return /(^|[^<>-])>>?(?!&)/.test(bare);
}

/** The "always" button's words for a scope. */
export function alwaysLabel(s: AlwaysScope): string {
  return s.kind === 'command' ? 'Always allow this command'
    : s.kind === 'site' ? 'Always allow this site'
    : s.kind === 'tool' ? 'Always allow this tool'
    : 'Allow edits for this turn';
}

/** One question Claude asks with options to pick from (Claude Code's AskUserQuestion). */
export interface AskQuestion {
  question: string;
  /** A short label for it, e.g. "Auth method". */
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * AskUserQuestion's input, read safely: 1 to 4 questions, each with up to 6 options. Null when
 * it isn't that shape, so the request falls back to a plain approval.
 */
export function askQuestions(input: Record<string, unknown>): AskQuestion[] | null {
  const qs = input.questions;
  if (!Array.isArray(qs) || !qs.length || qs.length > 4) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== 'object') return null;
    const o = q as Record<string, unknown>;
    if (typeof o.question !== 'string' || !o.question.trim() || o.question.length > 1000) return null;
    if (!Array.isArray(o.options) || !o.options.length || o.options.length > 6) return null;
    const options: AskQuestion['options'] = [];
    for (const op of o.options as unknown[]) {
      const p = op as Record<string, unknown> | null;
      if (!p || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 200) return null;
      options.push({ label: p.label, description: typeof p.description === 'string' ? clip(p.description, 500) : '' });
    }
    out.push({ question: o.question, header: typeof o.header === 'string' ? clip(o.header, 40) : '', options, multiSelect: o.multiSelect === true });
  }
  return out;
}

export function approvalCard(tool: string, input: Record<string, unknown>): { title: string; detail: string; site?: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (tool) {
    case 'Bash': return { title: 'Run a command', detail: str(input.command) };
    case 'AskUserQuestion': {
      const qs = askQuestions(input);
      return qs ? { title: 'Answer Claude’s question', detail: qs.map((q) => q.question).join('\n') } : { title: 'Answer Claude’s question', detail: '' };
    }
    case 'ExitPlanMode': return { title: 'Approve Claude’s plan', detail: '' };
    // Work for later, on the runner's plan: say what and when, plainly.
    case 'mcp__multiplayer__schedule': {
      const every = typeof input.every_minutes === 'number' ? input.every_minutes : undefined;
      const inM = typeof input.in_minutes === 'number' ? input.in_minutes : undefined;
      const when = every !== undefined ? `every ${every} min${typeof input.times === 'number' ? `, ${input.times} times` : ''}` : inM !== undefined ? `in ${inM} min` : 'later';
      return { title: `Run a prompt ${when}, on your plan`, detail: str(input.prompt) };
    }
    // A file Claude made, handed to everyone in the space (they can download it).
    case 'mcp__multiplayer__share_file': {
      const p = str(input.path);
      const n = str(input.name) || p.split(/[\\/]/).pop() || 'a file';
      return { title: `Share ${clip(n, 80)} with everyone here`, detail: p };
    }
    // Claude Code's artifact tools, made in the person's own Claude Code (BRIDGED_TOOLS).
    case 'mcp__multiplayer__Artifact': case 'mcp__multiplayer__ArtifactData': case 'mcp__multiplayer__ArtifactComments': {
      // The action and every field that picks what it touches, as they are: never a title Claude chose in their place.
      const action = str(input.action) || (tool === 'mcp__multiplayer__Artifact' ? 'publish' : '');
      const title = tool !== 'mcp__multiplayer__Artifact' ? `Use an artifact’s ${tool.endsWith('Data') ? 'data' : 'comments'} in your claude.ai account (${clip(action || 'call', 30)})`
        : action === 'delete' ? 'Delete an artifact in your claude.ai account'
        : action === 'publish' ? (input.url ? 'Change an artifact in your claude.ai account' : 'Publish an artifact in your claude.ai account')
        : `Use your claude.ai artifacts (${clip(action, 30)})`;
      // The fields that pick what it touches first, then every other field, so nothing in the call is hidden.
      const fields: string[] = [];
      if (action) fields.push(`action: ${clip(action, 60)}`);
      const first = ['file_path', 'url', 'type_url', 'from_url', 'path', 'collection', 'doc_id', 'file_paths', 'asset_ids', 'paths', 'files', 'capabilities', 'force'];
      const shown = (k: string, v: unknown) => fields.push(`${k}: ${typeof v === 'string' ? clip(v, 300) : clip(JSON.stringify(v) ?? '', 300)}${k === 'force' && v === true ? ' (discards a newer version)' : ''}`);
      for (const k of first) if (input[k] !== undefined && input[k] !== '') shown(k, input[k]);
      for (const k of Object.keys(input).sort()) if (k !== 'action' && !first.includes(k) && input[k] !== undefined) shown(k, input[k]);
      return { title, detail: fields.join('\n') };
    }
    case 'WebFetch': {
      const url = str(input.url);
      return { title: 'Fetch a page', detail: url, site: siteOf(url) };
    }
    case 'Write': return { title: 'Write a file', detail: str(input.file_path) };
    case 'Read': return { title: 'Read a file', detail: str(input.file_path) };
    case 'NotebookEdit': return { title: 'Edit a notebook', detail: str(input.notebook_path) };
    case 'Grep': return { title: 'Search files', detail: [str(input.pattern), str(input.path) || str(input.glob)].filter(Boolean).join(' in ') };
    case 'Glob': return { title: 'List files', detail: [str(input.pattern), str(input.path)].filter(Boolean).join(' in ') };
    case 'Edit': case 'MultiEdit': return { title: 'Edit a file', detail: str(input.file_path) };
    case 'NotebookEdit': return { title: 'Edit a notebook', detail: str(input.notebook_path) };
    default: {
      let detail = '';
      try { detail = clip(JSON.stringify(input), 600); } catch { detail = ''; }
      const m = tool.match(/^mcp__(.+?)__(.+)$/);
      return { title: m ? `Use ${m[2]} (${m[1]})` : `Use ${tool}`, detail };
    }
  }
}

/**
 * A conversation being brought in (branch.import), cut to what one request to the server can
 * carry, with a note where a long message was shortened, and grouped into requests of at most
 * `maxTurns` turns and about `maxChars` characters (the server takes 256 KB a request).
 */
export function chunkImport<T extends ImportTurn>(turns: T[], o: { maxTurns?: number; maxChars?: number; maxPrompt?: number; maxText?: number; maxSteps?: number } = {}): { chunks: T[][]; shortened: number } {
  const maxTurns = o.maxTurns ?? 150;
  const maxChars = o.maxChars ?? 150_000;
  const maxPrompt = o.maxPrompt ?? 40_000;
  const maxText = o.maxText ?? 80_000;
  const maxSteps = o.maxSteps ?? 200;
  let shortened = 0;
  const cut = (s: string, n: number) => {
    if (s.length <= n) return s;
    shortened++;
    return `${s.slice(0, n)}\n\n[… ${s.length - n} more characters in the original]`;
  };
  const fitted: T[] = turns.map((t) => ({
    ...t, prompt: cut(t.prompt, maxPrompt), text: cut(t.text, maxText),
    ...(t.steps ? { steps: t.steps.length > maxSteps ? [...t.steps.slice(0, maxSteps - 1), { tool: 'More', text: `${t.steps.length - maxSteps + 1} more steps` }] : t.steps } : {}),
  }));
  const chunks: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const t of fitted) {
    const n = JSON.stringify(t).length;
    if (cur.length && (cur.length >= maxTurns || size + n > maxChars)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(t);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return { chunks, shortened };
}

const FILE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
};

/** A file's media type from its name, for a file Claude made (the browser says for uploads). */
export function fileType(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return FILE_TYPES[ext] ?? 'application/octet-stream';
}

/** "820 B", "14 KB", "3.2 MB". */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}
