// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Branch, Decision, Id, MemberId, Note, Question, SpaceState, Turn } from './types.ts';

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
export function isOneOff(t: Turn): boolean {
  return t.mode === 'recap' || t.mode === 'aside';
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

/** "Opus", "Sonnet 4.5", … from an alias or a full model id. */
export function modelLabel(name: string | undefined): string {
  if (!name) return 'Model';
  const n = name.toLowerCase();
  const fam = n.includes('opus') ? 'Opus' : n.includes('sonnet') ? 'Sonnet' : n.includes('haiku') ? 'Haiku' : name;
  const m = n.match(/(\d+)[-.](\d+)/);
  return m && fam !== name ? `${fam} ${m[1]}.${m[2]}` : fam;
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

export function approvalCard(tool: string, input: Record<string, unknown>): { title: string; detail: string; site?: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (tool) {
    case 'Bash': return { title: 'Run a command', detail: str(input.command) };
    case 'WebFetch': {
      const url = str(input.url);
      return { title: 'Fetch a page', detail: url, site: siteOf(url) };
    }
    case 'Write': return { title: 'Write a file', detail: str(input.file_path) };
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
