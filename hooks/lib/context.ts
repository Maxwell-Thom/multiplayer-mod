// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import { branchDecisions, branchQuestions, clip, historyTurns, isOneOff, memberName, mainOf, isMain, noteLine, turnsOf, workFiles, workStatus } from './helpers.ts';
import type { Decision, Id, MemberId, SpaceState, Turn } from './types.ts';

/**
 * What a runner knows about its own folder, for "Where the code is". Everyone's Claude works
 * in their own copy, so this is how a session knows which changes from earlier turns it has.
 */
export interface FolderView {
  /** Turns run in this folder whose changes aren't all pushed yet. */
  here: Id[];
  /** Commits this folder has (12-character shas), among those turns' work names. */
  has: string[];
  /** This folder isn't a git repository: it can't pull anyone's changes. */
  noRepo?: boolean;
  /** The git branch this folder is on, to say when a push went to another one. */
  branch?: string;
}

/** Who reads a turn, and from which folder (none: a claude.ai chat, which has no files). */
type Reader = { runnerId: MemberId; folder?: FolderView };

const sha12 = (sha: string) => sha.slice(0, 12);

function turnLabel(s: SpaceState, t: Turn): string {
  return `${memberName(s, t.senderId)}'s turn “${clip(t.parts[0]?.text ?? '', 60)}”`;
}

/** Where a turn's changes were made, as its reader sees it. */
function madeWhere(s: SpaceState, t: Turn, r: Reader): string {
  const who = memberName(s, t.runnerId);
  if (!r.folder) return `on ${who}'s computer`;
  if (r.folder.here.includes(t.id)) return 'in this folder';
  return t.runnerId === r.runnerId ? `in another of ${who}'s folders (another computer or copy), not this one` : `on ${who}'s computer, not in this folder`;
}

/** The bracket under a turn that changed files: where, and what. */
function workNote(s: SpaceState, t: Turn, r: Reader | undefined): string {
  const w = t.work;
  if (!w || !r || workStatus(w) === 'none') return '';
  const what = [
    w.uncommitted?.length || w.more ? workFiles(w, 8) : '',
    w.commits?.length ? `${w.commits.length} commit${w.commits.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join('; ');
  return `\n[Its file changes were made ${madeWhere(s, t, r)}${what ? ` (${what})` : ''}.]`;
}

/** Where one turn's changes stand now; `missing` when the reader's folder doesn't have them. */
function standing(s: SpaceState, t: Turn, r: Reader): { text: string; missing: boolean } {
  const w = t.work!;
  const f = r.folder;
  const here = !!f?.here.includes(t.id);
  const who = memberName(s, t.runnerId);
  const away = t.runnerId === r.runnerId ? `only in another of ${who}'s folders` : `only on ${who}'s computer`;
  const newest = w.commits?.[0];
  const commits = newest ? `${w.commits!.length === 1 ? 'commit' : `${w.commits!.length} commits, newest`} ${sha12(newest.sha)} “${clip(newest.subject, 80)}”` : '';
  const pushedHas = () => !f ? '' : here || f.has.includes(sha12(newest!.sha)) ? '; this folder has it'
    : f.noRepo ? `; this folder doesn't have it (it isn't a git repository, so it can't pull)`
    : f.branch && w.pushed && f.branch !== w.pushed ? `; this folder doesn't have it: this folder is on ${f.branch}, so pulling won't bring it (it needs ${w.pushed} fetched and merged, or checked out)`
    : `; this folder doesn't have it yet (a pull would bring it)`;
  switch (workStatus(w)) {
    case 'no-repo':
      return here ? { text: `in this folder, which isn't a git repository`, missing: false }
        : { text: `${f ? away : `on ${who}'s computer`}, in a folder that isn't a git repository, so nobody else can pull it`, missing: !!f };
    case 'uncommitted': {
      const rest = newest ? `; ${commits}, ${w.pushed ? `pushed to ${w.pushed}` : 'not pushed'}` : '';
      return here ? { text: `in this folder, not committed (${workFiles(w, 6)})${rest}`, missing: false }
        : { text: `${f ? away : `on ${who}'s computer`}, not committed (${workFiles(w, 6)})${rest}`, missing: !!f };
    }
    case 'unpushed':
      return here ? { text: `in this folder: ${commits}, not pushed`, missing: false }
        : { text: `${f ? away : `on ${who}'s computer`}: ${commits}, not pushed`, missing: !!f };
    default: {
      const has = pushedHas();
      return { text: `pushed to ${w.pushed} (${commits})${has}`, missing: has.startsWith(`; this folder doesn't`) };
    }
  }
}

/**
 * "Where the code is": the turns of this conversation that changed files, where each one's
 * changes are, and what this folder lacks. Also changes from the runner's other shared
 * branches, which share its one folder. Empty when no turn changed files.
 */
function codeSection(s: SpaceState, turn: Turn, r: Reader): string {
  const branch = s.branches[turn.branchId];
  if (!branch) return '';
  const changed = (t: Turn | undefined): t is Turn => !!t && t.id !== turn.id && !isOneOff(t) && workStatus(t.work) !== 'none';
  const hist = historyTurns(s, branch.id).filter((t) => changed(t) && !(t.private && t.runnerId !== turn.runnerId));
  const inHist = new Set(hist.map((t) => t.id));
  // Other branches' turns in this same folder (never a private lane's or a recap's: this is read by everyone).
  const elsewhere = (r.folder?.here ?? []).map((id) => s.turns[id]).filter((t): t is Turn => changed(t) && !inHist.has(t.id) && !t.private && !s.branches[t.branchId]?.private);
  if (!hist.length && !elsewhere.length) return '';
  const shown = hist.slice(-12);
  let missing = 0;
  const lines = shown.map((t) => {
    const st = standing(s, t, r);
    if (st.missing) missing++;
    return `- ${turnLabel(s, t)}: ${st.text}.`;
  });
  if (hist.length > shown.length) lines.unshift(`- ${hist.length - shown.length} earlier turns changed files too.`);
  for (const t of elsewhere.slice(-6)) {
    const b = s.branches[t.branchId];
    const conv = s.conversations[t.conversationId];
    const from = t.conversationId !== turn.conversationId ? `the conversation “${conv?.title ?? '?'}”` : b && isMain(s, b.id) ? 'the main line' : `the branch “${b?.name ?? '?'}”`;
    lines.push(`- Also in this folder, from ${from}: ${turnLabel(s, t)}: ${standing(s, t, r).text}.`);
  }
  const head = r.folder
    ? `Where the code is (each person's Claude works in their own folder; you can read only this one, ${memberName(s, r.runnerId)}'s):`
    : `Where the code is (on people's computers; you can't read any of it from here):`;
  const tail = !r.folder ? ''
    : missing ? `\nChanges not in this folder aren't in the files you can read. Don't assume they're there, and don't quietly redo them: say what's missing and whose it is (they can push it, then a pull brings it here). Pull, commit or push only when someone asks.`
    : hist.length ? '\nEvery change above is in this folder.' : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/**
 * What a runner hands its Claude for one shared turn. Each person's Claude Code
 * holds its own session, so other people's turns reach it as context here.
 *
 * `prompt` is the visible user message for the turn; `context` is hidden blocks
 * the model reads alongside (decisions, who's here, what others did since).
 */
export interface TurnContext {
  prompt: string;
  context: string[];
}

export interface ContextOptions {
  /** The last turn this runner's session already holds for this branch. Null: none, send the history. */
  sinceTurnId?: Id | null;
  /** Rough cap on the history block, in characters. */
  maxHistoryChars?: number;
  /** The runner's own folder, when it has one (Claude Code): which changes it holds. */
  folder?: FolderView;
}

/**
 * Files on a part or a turn, by name and id: the runner lists where each one is on its computer,
 * so Claude can read it (`[attached: chart.png (file f_1)]`).
 */
export function filesLine(s: SpaceState, ids: readonly Id[] | undefined, verb = 'attached'): string {
  const list = (ids ?? []).map((id) => s.files?.[id]).filter((x): x is NonNullable<typeof x> => !!x);
  return list.length ? ` [${verb}: ${list.map((x) => `${x.name} (file ${x.id})`).join(', ')}]` : '';
}

function partsText(s: SpaceState, t: Turn, withPositions: boolean): string {
  const parts = t.parts.filter((p) => withPositions || !p.position);
  const authors = new Set(parts.map((p) => p.memberId));
  const who = (p: Turn['parts'][number]) => {
    // A turn a schedule sent: its person set it up earlier; nobody typed it just now.
    if (t.scheduled) return `${memberName(s, p.memberId)} (scheduled earlier, running now)`;
    const cited = p.cites ? s.turns[p.cites] : undefined;
    const from = cited ? s.branches[cited.branchId] : undefined;
    return `${memberName(s, p.memberId)}${p.editedBy ? ` (edited by ${memberName(s, p.editedBy)})` : ''}${cited ? ` (citing a turn from ${from && isMain(s, from.id) ? 'the main line' : `the branch “${from?.name ?? '?'}”`}, given above)` : ''}`;
  };
  // A slash command (a skill: `/review the login page`) sent on its own goes as the command
  // itself, on its own last line, as Claude Code reads one; who sent it, just above.
  if (authors.size === 1 && parts.length === 1 && /^\/[A-Za-z][\w:-]*(\s|$)/.test(parts[0].text.trim())) {
    return `${who(parts[0])} runs this command:\n\n${parts[0].text.trim()}`;
  }
  if (authors.size === 1 && parts.length === 1) return `${who(parts[0])}: ${parts[0].text}${filesLine(s, parts[0].files)}`;
  return parts.map((p) => `${who(p)}: ${p.text}${filesLine(s, p.files)}`).join('\n\n');
}

function turnTranscript(s: SpaceState, t: Turn, maxAnswer: number, r?: Reader): string {
  // Reveal turns show positions without names, and stay that way in later context.
  const who = t.mode === 'merge-note' ? 'Merge note'
    : t.mode === 'reveal' ? `Positions people held back (unattributed):\n${t.parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}`
    : partsText(s, t, t.mode !== 'view-first');
  // A subagent's own steps stay under its Agent step: the summary names Claude's.
  const own = t.steps.filter((x) => x.under === undefined);
  const steps = own.length ? `\n[Claude used ${own.length} step${own.length === 1 ? '' : 's'}: ${own.slice(0, 6).map((x) => x.text).join('; ')}${own.length > 6 ? '; …' : ''}]` : '';
  const answer = t.status === 'done' ? clip(t.text, maxAnswer) : t.status === 'stopped' ? `${clip(t.text, maxAnswer)} [stopped]` : `[${t.status}]`;
  return `${who}${steps}${workNote(s, t, r)}\nClaude (run by ${memberName(s, t.runnerId)}): ${answer}`;
}

/** Turns word for word, newest kept whole, oldest cut short or left out past `cap` characters. */
function transcript(s: SpaceState, turns: Turn[], cap: number, r?: Reader): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const full = i >= turns.length - 4;
    const line = turnTranscript(s, turns[i], full ? 4000 : 400, r);
    if (used + line.length > cap && lines.length) { lines.unshift(`[${i + 1} earlier turn${i ? 's' : ''} left out]`); break; }
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n\n---\n\n');
}

export function buildTurnContext(s: SpaceState, turn: Turn, opts: ContextOptions = {}): TurnContext {
  const branch = s.branches[turn.branchId];
  const conv = s.conversations[turn.conversationId];
  const runner = memberName(s, turn.runnerId);
  const here = Object.values(s.members).filter((m) => !m.leftAt);
  const main = branch ? isMain(s, branch.id) : true;
  const reader: Reader = { runnerId: turn.runnerId, folder: opts.folder };

  const context: string[] = [];

  // A private lane or a recap: only its owner sees it, and their own profile is welcome there.
  if (turn.private) {
    const where = branch?.private ? `${runner}'s private lane` : `a private recap for ${runner}`;
    context.push([
      `This is ${where} in Multiplayer, space “${s.space.name}”${conv ? `, conversation “${conv.title}”` : ''}. Only ${runner} sees this turn and your answer; nothing reaches the others unless ${runner} shares it.`,
      `${runner}'s own memory, notes and instructions are fine to use here.`,
    ].join('\n'));
  } else context.push([
    `This is a shared conversation in Multiplayer, space “${s.space.name}”${conv ? `, conversation “${conv.title}”` : ''}${branch && !main ? `, branch “${branch.name}”` : ''}.`,
    `Several people write each turn together; each part is labelled with who wrote it. People here: ${here.map((m) => `${m.name} (${m.role})`).join(', ')}. Call them by their names (not he or she: a name doesn't tell you).`,
    `You are running on ${runner}'s machine, on ${runner}'s own plan. Treat everyone's parts equally.`,
    `Keep ${runner}'s personal memory, notes and unrelated files out of this shared conversation unless ${runner} asks for them here.`,
    `When the group settles something, record it with the propose_decision tool. When something stays open, use add_question. Don't record things nobody has agreed on.`,
  ].join('\n'));

  const decisions = branch ? branchDecisions(s, branch.id) : [];
  const holding = decisions.filter((d) => d.status === 'approved' || d.status === 'proposed');
  if (holding.length) {
    context.push('Decisions so far (cite them by id):\n' + holding.map((d) => {
      const dissent = d.dissent.length ? ` — dissent: ${d.dissent.map((x) => `${memberName(s, x.memberId)}: ${clip(x.text, 160)}`).join(' | ')}` : '';
      return `${d.id} [${d.status}${d.branchId ? ', this branch' : ''}] ${d.text}${dissent}`;
    }).join('\n'));
  }
  const open = branch ? branchQuestions(s, branch.id) : [];
  if (open.length) context.push('Open questions:\n' + open.map((q) => `${q.id} ${q.text}`).join('\n'));

  // History this session doesn't hold yet.
  if (branch) {
    const hist = historyTurns(s, branch.id).filter((t) => t.id !== turn.id && t.status !== 'requested' && t.status !== 'held' && t.status !== 'conflict' && !isOneOff(t) && !(t.private && t.runnerId !== turn.runnerId));
    let from = 0;
    if (opts.sinceTurnId) {
      const at = hist.findIndex((t) => t.id === opts.sinceTurnId);
      from = at === -1 ? 0 : at + 1;
    }
    const missing = hist.slice(from);
    if (missing.length) {
      const head = opts.sinceTurnId ? 'Since your last turn here, others ran these turns:' : `The conversation so far${branch.parentId ? ` (this branch continues from ${s.branches[branch.parentId]?.name ?? 'its parent'})` : ''}:`;
      context.push(`${head}\n\n${transcript(s, missing, opts.maxHistoryChars ?? 24000, reader)}`);
    }
    for (const c of citedTurns(s, turn)) context.push(`${memberName(s, c.by)} cites a turn from ${c.where}, word for word:\n\n${transcript(s, [c.turn], opts.maxHistoryChars ?? 24000)}`);
    // A merge note is written on the target, whose history doesn't hold the branch: give its writer the branch's own turns.
    const merge = turn.mode === 'merge-note' && turn.mergeId ? s.merges[turn.mergeId] : undefined;
    const merged = merge ? s.branches[merge.fromBranchId] : undefined;
    if (merged) {
      const own = turnsOf(s, merged.id).filter((t) => t.status === 'done' || t.status === 'stopped');
      context.push(own.length
        ? `The branch “${merged.name}” being merged, its own turns since it left ${branch.name}:\n\n${transcript(s, own, opts.maxHistoryChars ?? 24000)}`
        : `The branch “${merged.name}” being merged has no turns of its own.`);
    }
    if (branch.editOf && s.turns[branch.editOf]) {
      context.push(`This branch was made by editing a shared turn. The original asked: ${clip(partsText(s, s.turns[branch.editOf], true), 600)}`);
    }
  }

  const notes = Object.values(s.notes).filter((n) => n.branchId === turn.branchId);
  if (notes.length) context.push('Notes people shared:\n' + notes.map((n) => clip(noteLine(s, n), 1600)).join('\n\n'));
  const code = codeSection(s, turn, reader);
  if (code) context.push(code);

  let prompt: string;
  switch (turn.mode) {
    case 'view-first': {
      const held = turn.parts.filter((p) => p.position).length;
      prompt = `${partsText(s, turn, false)}\n\n(${held} ${held === 1 ? 'person is' : 'people are'} holding back their own position until you answer. Give your own view first, plainly, with your reasons.)`;
      break;
    }
    case 'reveal': {
      const list = turn.parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
      prompt = `Here are the positions people held back, in random order and without names:\n\n${list}\n\nFor each one, in order, reply in one or two sentences: where it agrees or differs with your view and whether it changes your answer. Format your reply as a numbered list with exactly ${turn.parts.length} items, then one closing line on what, if anything, you'd now revise.`;
      break;
    }
    case 'weigh': {
      prompt = `${partsText(s, turn, true)}\n\n(These parts disagree. The group asked you to weigh both before answering: set out each side fairly, then say which you'd pick and why.)`;
      break;
    }
    case 'merge-note':
      prompt = turn.parts.map((p) => p.text).join('\n\n');
      break;
    case 'recap': {
      prompt = turn.parts.map((p) => p.text).join('\n\n');
      break;
    }
    case 'aside': {
      const who = memberName(s, turn.senderId);
      prompt = `[Multiplayer] ${who} asks this on the side, just for themself: it won't join the shared conversation. Answer briefly, from what's in this conversation.\n\n${who}: ${turn.parts.map((p) => p.text).join('\n\n')}`;
      break;
    }
    case 'combine':
      prompt = turn.parts.map((p) => p.text).join('\n\n');
      break;
    default:
      prompt = partsText(s, turn, true);
  }
  // Three or more writers: say who they are, and that each request has an owner.
  const writers = [...new Set(turn.parts.map((p) => p.memberId))];
  if (writers.length >= 3 && (turn.mode === 'normal' || turn.mode === 'view-first' || turn.mode === 'weigh')) {
    const names = writers.map((m) => memberName(s, m));
    prompt = `(${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} each wrote part of this turn. When you take up a request, say whose it is.)\n\n${prompt}`;
  }
  if (turn.handedFrom) prompt += `\n\n(${memberName(s, turn.handedFrom)} wrote this and handed it to ${memberName(s, turn.senderId)} to send.)`;
  if (turn.takenFrom) context.push(`${memberName(s, turn.takenFrom)}'s Claude went quiet while running this turn, so ${runner} took it over. Start it fresh.`);

  return { prompt, context };
}

// ------------------------------------------------- native branch sessions

/**
 * One shared turn for a branch's own Claude Code session (see docs/CONTEXT.md). The
 * session keeps its turns word for word, as any Claude Code session does, and Claude
 * Code's own compaction handles length. Only what the session can't have is given:
 * - `system`: stable instructions for the session's system prompt (kept the same on
 *   every turn of a session, so the prompt cache holds);
 * - `message`: what changed in the space since the session last heard, and the turns
 *   it didn't run itself (other people's, or its own that were stopped or failed), in
 *   full, then the prompt.
 */
export interface SessionTurn {
  system: string;
  message: string;
  /** The space facts the session now holds (people, decisions, questions, notes), to send only changes next time. */
  state: string;
  prompt: string;
}

export interface SessionTurnOptions {
  /** The last turn of this branch's history the session already holds (ran, forked from, or was given). Null: it holds none. */
  heldThrough?: Id | null;
  /** `state` from the session's last turn. */
  lastState?: string;
  /** A safety cap on turns given at once, in characters (oldest left out past it). */
  maxChars?: number;
  /** The runner's own folder: which changes from earlier turns it holds. */
  folder?: FolderView;
}

/** The stable instructions for a shared branch session: the same for every turn it runs. */
export function sessionSystem(s: SpaceState, turn: Turn): string {
  const branch = s.branches[turn.branchId];
  const conv = s.conversations[turn.conversationId];
  const runner = memberName(s, turn.runnerId);
  const where = `space “${s.space.name}”${conv ? `, conversation “${conv.title}”` : ''}${branch && !isMain(s, branch.id) ? `, branch “${branch.name}”` : ''}`;
  // A side question runs in a fork of its branch's own session: the same instructions, so the cache holds.
  if (turn.private && !(turn.mode === 'aside' && !branch?.private)) {
    return [
      `This session is ${branch?.private ? `${runner}'s private lane` : `a private recap for ${runner}`} in Multiplayer, ${where}.`,
      `Only ${runner} sees these turns and your answers; nothing reaches the others unless ${runner} shares it. ${runner}'s own memory, notes and instructions are fine to use here.`,
    ].join('\n');
  }
  return [
    `This session is a shared conversation in Multiplayer, ${where}. Several people write each turn together, and each part is labelled with who wrote it; treat everyone's parts equally, and call people by their names (not he or she: a name doesn't tell you).`,
    `It runs on ${runner}'s machine and plan, but everyone in the space reads your answers. Keep ${runner}'s personal memory, notes, credentials and unrelated files out of it unless they're asked for in the turn.`,
    `It works in ${runner}'s own folder. Everyone else's turns run in their own copies, so a change from someone else's turn is here only once it's pushed and pulled; "Where the code is" notes say which changes this folder has.`,
    `Turns this session didn't run itself (other people's, or ones stopped or cut short) reach you as "[Multiplayer]" notes before the prompt, word for word.`,
    `When the group settles something, record it with the propose_decision tool; when something stays open, use add_question. Don't record things nobody has agreed on.`,
  ].join('\n');
}

/** Facts about the space the session should know: they're only sent when they change. */
function spaceState(s: SpaceState, turn: Turn, r: Reader): string {
  const branch = s.branches[turn.branchId];
  const out: string[] = [];
  if (!turn.private) out.push(`People here: ${Object.values(s.members).filter((m) => !m.leftAt).map((m) => `${m.name} (${m.role})`).join(', ')}.`);
  const holding = (branch ? branchDecisions(s, branch.id) : []).filter((d) => d.status === 'approved' || d.status === 'proposed');
  out.push(holding.length ? 'Decisions (cite them by id):\n' + holding.map((d) => {
    const dissent = d.dissent.length ? ` — dissent: ${d.dissent.map((x) => `${memberName(s, x.memberId)}: ${x.text}`).join(' | ')}` : '';
    return `${d.id} [${d.status}${d.branchId ? ', this branch' : ''}] ${d.text}${dissent}`;
  }).join('\n') : 'Decisions: none yet.');
  const open = branch ? branchQuestions(s, branch.id) : [];
  out.push(open.length ? 'Open questions:\n' + open.map((q) => `${q.id} ${q.text}`).join('\n') : 'Open questions: none.');
  const notes = Object.values(s.notes).filter((n) => n.branchId === turn.branchId);
  if (notes.length) out.push('Notes people shared:\n' + notes.map((n) => noteLine(s, n)).join('\n\n'));
  if (branch?.editOf && s.turns[branch.editOf]) out.push(`This branch was made by editing a shared turn. The original asked: ${partsText(s, s.turns[branch.editOf], true)}`);
  // Sent again whenever it changes: a push, a pull, a commit.
  const code = codeSection(s, turn, r);
  if (code) out.push(code);
  return out.join('\n\n');
}

/** Turns this turn's parts cite, from other branches: who cited each, and where it's from. */
function citedTurns(s: SpaceState, turn: Turn): { by: string; where: string; turn: Turn }[] {
  const out: { by: string; where: string; turn: Turn }[] = [];
  for (const p of turn.parts) {
    const c = p.cites ? s.turns[p.cites] : undefined;
    if (!c || out.some((x) => x.turn.id === c.id)) continue;
    const b = s.branches[c.branchId];
    out.push({ by: p.memberId, where: b && isMain(s, b.id) ? 'the main line' : `the branch “${b?.name ?? '?'}”`, turn: c });
  }
  return out;
}

/** A turn as the session reads one it didn't run: the parts, the steps, the whole answer. */
function fullTurn(s: SpaceState, t: Turn, r: Reader, nested = false): string {
  const who = t.mode === 'merge-note' ? 'Merge note'
    : t.mode === 'reveal' ? `Positions people held back (unattributed):\n${t.parts.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}`
    : partsText(s, t, t.mode !== 'view-first');
  const own = t.steps.filter((x) => x.under === undefined);
  const steps = own.length ? `\n[Claude used ${own.length} step${own.length === 1 ? '' : 's'}: ${own.map((x) => x.text).join('; ')}]` : '';
  const answer = (t.status === 'done' ? t.text : t.status === 'stopped' ? `${t.text} [stopped]` : `[${t.status}]`) + filesLine(s, t.files, 'shared with everyone');
  // A turn that cites another brings it along (one level deep), so every session reads what it read.
  const cited = nested ? [] : citedTurns(s, t).map((c) => `(${memberName(s, c.by)} cited this turn from ${c.where}:)\n${fullTurn(s, c.turn, r, true)}`);
  // A turn brought in happened in that person's own conversation elsewhere, before it came here.
  const where = t.imported
    ? `in ${memberName(s, t.runnerId)}'s own ${t.imported.from === 'claude-code' ? 'Claude Code session' : 'claude.ai chat'}, before it was brought here`
    : `on ${memberName(s, t.runnerId)}'s machine`;
  return [...cited, `${who}${steps}${t.imported ? '' : workNote(s, t, r)}\nClaude (${where}): ${answer}`].join('\n\n');
}

function fullTurns(s: SpaceState, turns: Turn[], cap: number, r: Reader): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = fullTurn(s, turns[i], r);
    if (used + line.length > cap && lines.length) { lines.unshift(`[${i + 1} earlier turn${i ? 's' : ''} left out]`); break; }
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n\n---\n\n');
}

export function buildSessionTurn(s: SpaceState, turn: Turn, opts: SessionTurnOptions = {}): SessionTurn {
  const branch = s.branches[turn.branchId];
  const { prompt } = buildTurnContext(s, turn);
  const cap = opts.maxChars ?? 400_000;
  const notes: string[] = [];
  const r: Reader = { runnerId: turn.runnerId, folder: opts.folder };

  const state = spaceState(s, turn, r);
  if (state !== opts.lastState) notes.push(state);

  if (branch) {
    // A recap or side question never joins the branch: not even its asker's session hears it again.
    const hist = historyTurns(s, branch.id).filter((t) => t.id !== turn.id && t.status !== 'requested' && t.status !== 'held' && t.status !== 'conflict' && !isOneOff(t) && !(t.private && t.runnerId !== turn.runnerId));
    const at = opts.heldThrough ? hist.findIndex((t) => t.id === opts.heldThrough) : -1;
    const missing = hist.slice(at + 1);
    if (missing.length) {
      const head = at >= 0 ? 'Since your last turn here, the conversation went on:' : `The conversation so far${branch.parentId ? ` (this branch continues from ${s.branches[branch.parentId]?.name ?? 'its parent'})` : ''}:`;
      notes.push(`${head}\n\n${fullTurns(s, missing, cap, r)}`);
    }
    for (const c of citedTurns(s, turn)) notes.push(`${memberName(s, c.by)} cites a turn from ${c.where}, word for word:\n\n${fullTurn(s, c.turn, r)}`);
    const merge = turn.mode === 'merge-note' && turn.mergeId ? s.merges[turn.mergeId] : undefined;
    const merged = merge ? s.branches[merge.fromBranchId] : undefined;
    if (merged) {
      const own = turnsOf(s, merged.id).filter((t) => t.status === 'done' || t.status === 'stopped');
      notes.push(own.length ? `The branch “${merged.name}” being merged, its own turns since it left ${branch.name}:\n\n${fullTurns(s, own, cap, r)}` : `The branch “${merged.name}” being merged has no turns of its own.`);
    }
  }
  if (turn.takenFrom) notes.push(`${memberName(s, turn.takenFrom)}'s Claude went quiet while running this turn, so ${memberName(s, turn.runnerId)} took it over. Start it fresh.`);

  const message = notes.length ? `${notes.map((n) => `[Multiplayer] ${n}`).join('\n\n')}\n\n---\n\n${prompt}` : prompt;
  return { system: sessionSystem(s, turn), message, state, prompt };
}

/** Parses a reveal answer into one reply per position, plus the closing line. */
export function parseReplies(text: string, n: number): string[] {
  const out: string[] = new Array(n).fill('');
  const re = /^\s*(\d+)[.)]\s+(.*)$/;
  let cur = -1;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) { cur = parseInt(m[1], 10) - 1; if (cur >= 0 && cur < n) out[cur] = m[2].trim(); continue; }
    if (cur >= 0 && cur < n && line.trim() && !out[cur].endsWith('.') ) out[cur] += ' ' + line.trim();
  }
  return out;
}

/**
 * The recap a member asks for after being away: turns on main since they last looked. Found live
 * (PARITY #68): it gave a bare count of approved decisions across the whole space, so a recap
 * asked seconds after Claude proposed D1 and D2 said "0 approved", which read as wrong once they
 * were approved. It names this conversation's decisions by where they stand, as of now.
 */
export function recapBrief(s: SpaceState, conversationId: Id, sinceSeq: number): string {
  const main = mainOf(s, conversationId);
  const since = Object.values(s.turns).filter((t) => t.conversationId === conversationId && t.status === 'done' && !t.private && (t.endedAt ?? 0) > 0);
  const here = main ? branchDecisions(s, main.id) : [];
  const ids = (st: Decision['status']) => here.filter((d) => d.status === st).map((d) => d.id);
  const approved = ids('approved');
  const proposed = ids('proposed');
  const list = (xs: string[]) => xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  const standing = !approved.length && !proposed.length ? 'No decisions yet.'
    : [approved.length ? `approved: ${list(approved)}` : 'none approved yet', proposed.length ? `proposed and waiting for approval: ${list(proposed)}` : ''].filter(Boolean).join('; ');
  return [
    `Catch me up on this conversation since I was last here. Three to five short lines: what was decided (cite decision ids), what's still open, and anything I'm needed for.`,
    main ? `Main line: ${main.name}.` : '',
    `It has ${since.length} finished turn${since.length === 1 ? '' : 's'}. Decisions right now: ${standing}${standing.endsWith('.') ? '' : '.'} I last saw event #${sinceSeq}.`,
  ].filter(Boolean).join(' ');
}
