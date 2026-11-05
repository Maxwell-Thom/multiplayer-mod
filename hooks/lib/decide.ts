// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Command, CommandContext } from './commands.ts';
import type { EventBody } from './events.ts';
import {
  activeTurn, branchDecisions, canSee, clip, countText, historyTurns, isActive, isMain, isOneOff, latestTurnId, leftBehind, mainOf, mayRunFor, openAsks,
  memberName, nextDecisionId, nextQuestionId, hhmm, modelLabel, turnsOf, effortLabel, EFFORTS, creditsRefusalFor, fastOk, isModelName, pinText, slashRefusal, steerRefusal, thinkingToggles,
} from './helpers.ts';
import type { Branch, Decision, MergeItem, ModelPin, Part, Policy, Schedule, SharedFile, SpaceState, Turn, TimelineItem, MemberId, Id } from './types.ts';
import { DEFAULT_POLICY, FILE_MAX_BYTES, PART_FILES_MAX, SCHEDULE_MAX_MS, SCHEDULE_MIN_MS, SCHEDULES_PER_MEMBER } from './types.ts';
import { invalid } from './validate.ts';

/** Turns a conversation brought in may have in all. */
export const IMPORT_MAX = 2000;
import { canSeeTurn } from './redact.ts';

export type Decided = { ok: true; events: EventBody[] } | { ok: false; error: string; code?: string };

const fail = (error: string, code?: string): Decided => ({ ok: false, error, code });
const ok = (...events: EventBody[]): Decided => ({ ok: true, events });

function ev(ctx: CommandContext, branchId: Id, icon: string, text: string, link?: Extract<TimelineItem, { kind: 'event' }>['link']): EventBody {
  return { type: 'timeline.event', branchId, item: { kind: 'event', id: ctx.id('ev'), icon, actor: ctx.actor, text, at: ctx.now, link } };
}

const routed = (x: { runnerId: MemberId; events: EventBody[] } | Decided): x is { runnerId: MemberId; events: EventBody[] } => 'runnerId' in x;

/**
 * Who must say yes before a turn runs: the branch's owner (policy.ownerOk), and the Claude Code
 * it runs in when that isn't the sender's and they haven't allowed the sender here. An owner who
 * is also the runner is asked once.
 */
function oksFor(s: SpaceState, b: Branch, senderId: MemberId, runnerId: MemberId): ('send-in-branch' | 'run-here')[] {
  const runHere = runnerId !== senderId && !b.private && !mayRunFor(s, b.conversationId, runnerId, senderId);
  const owner = !!b.ownerId && b.ownerId !== senderId && !b.private && s.space.policy.ownerOk && !s.members[b.ownerId]?.leftAt && !(runHere && b.ownerId === runnerId);
  return [...(owner ? ['send-in-branch' as const] : []), ...(runHere ? ['run-here' as const] : [])];
}

function askEvents(ctx: CommandContext, b: Branch, turn: Turn, kinds: ('send-in-branch' | 'run-here')[]): EventBody[] {
  return kinds.map((kind) => ({ type: 'ask.created' as const, ask: { id: ctx.id('a'), kind, from: turn.senderId, to: kind === 'run-here' ? turn.runnerId : b.ownerId!, branchId: b.id, turnId: turn.id, status: 'open' as const, at: ctx.now } }));
}

/** A branch's work under way between two Claude Codes, if any. */
function moving(s: SpaceState, branchId: Id) {
  // (A copy of a turn's files doesn't hold the conversation up.)
  return Object.values(s.transfers ?? {}).find((x) => x.branchId === branchId && !x.copy && (x.status === 'packing' || x.status === 'sending'));
}

/**
 * Teleport's rule: the work moves only into a copy of the same project (when the server knows).
 * Once the branch has a project, it's the one its Claude Code is in now while that's connected
 * (what the receiving end checks too), else the branch's record.
 */
function wrongProject(s: SpaceState, ctx: CommandContext, b: Branch, who: MemberId): string | null {
  if (!b.repo || !ctx.repos) return null;
  const want = (b.runnerId ? ctx.repos[b.runnerId] : undefined) ?? b.repo;
  if (ctx.repos[who] === want) return null;
  return who === ctx.actor
    ? 'Your Claude Code is in a folder that isn’t a copy of this project. Open Claude Code in your copy of it and try again.'
    : `${memberName(s, who)}’s Claude Code is in a folder that isn’t a copy of this project.`;
}

/** A move needs the Claude Code it goes to to be connected (when the server says who is). */
function offline(s: SpaceState, ctx: CommandContext, who: MemberId): string | null {
  if (!ctx.online || ctx.online.includes(who)) return null;
  return who === ctx.actor ? 'Connect your Claude Code first, then move it here.' : `${memberName(s, who)}’s Claude Code isn’t connected right now.`;
}

/**
 * The branch runs in `to`'s Claude Code from now on, said where everyone reads it. `send`: the
 * Claude Code it leaves is online, so it sends what's only on its computer (a transfer);
 * otherwise the line says what stayed there. `answered`: the ask this move answers, if any.
 */
function moveEvents(s: SpaceState, ctx: CommandContext, b: Branch, to: MemberId, why: 'moved' | 'takeover', send: boolean, answered?: Id): EventBody[] {
  const from = b.runnerId ?? null;
  const actor = ctx.actor as MemberId;
  const where = s.conversations[b.conversationId]?.mainBranchId === b.id ? 'conversation' : 'branch';
  const left = from ? leftBehind(s, b.id, from) : { files: 0, commits: 0 };
  const sending = send && !!from && from !== to && left.files + left.commits > 0;
  const out: EventBody[] = [{ type: 'branch.runner', branchId: b.id, runnerId: to, from, why }];
  // Other asks to move it are moot now.
  for (const a of Object.values(s.asks)) if (a.kind === 'move' && a.branchId === b.id && a.status === 'open' && a.id !== answered) out.push({ type: 'ask.closed', askId: a.id });
  if (sending) out.push({ type: 'transfer.started', transfer: { id: ctx.id('tr'), branchId: b.id, from: from!, to, status: 'packing', at: ctx.now } });
  const head = why === 'takeover'
    ? `${memberName(s, actor)} took over · this ${where} runs in ${memberName(s, to)}’s Claude Code now`
    : `${memberName(s, actor)} moved this ${where} to ${actor === to ? 'their' : `${memberName(s, to)}’s`} Claude Code`;
  const stayed = countText(left.files, left.commits);
  const tail = sending ? ` · the work is on its way from ${memberName(s, from!)}’s computer` : stayed && from ? ` · ${stayed} stayed on ${memberName(s, from)}’s computer` : '';
  if (!b.private) out.push(ev(ctx, b.id, 'laptop', head + tail, { kind: 'work', label: 'Where the code is' }));
  return out;
}

/**
 * Someone leaves, or can only read now: the branches they run run in nobody's Claude Code until
 * the next send; what waits on them closes; turns waiting to run there go back to the box.
 */
function leaveEvents(s: SpaceState, ctx: CommandContext, m: MemberId, why: 'left' | 'viewer'): EventBody[] {
  const out: EventBody[] = [];
  const name = memberName(s, m);
  // Work on its way to or from them goes nowhere now: the move ends, so nothing waits for it.
  for (const tr of Object.values(s.transfers ?? {})) {
    if ((tr.status === 'packing' || tr.status === 'sending') && (tr.from === m || tr.to === m)) out.push({ type: 'transfer.updated', transferId: tr.id, status: 'failed', summary: `${name} ${why === 'left' ? 'left' : 'can only read now'}` });
  }
  for (const b of Object.values(s.branches)) {
    if (b.runnerId !== m || b.state === 'merged') continue;
    out.push({ type: 'branch.runner', branchId: b.id, runnerId: null, from: m, why: 'left' });
    const left = leftBehind(s, b.id, m);
    const stayed = countText(left.files, left.commits);
    if (!b.private) out.push(ev(ctx, b.id, 'laptop', `${name} ${why === 'left' ? 'left' : 'can only read now'} · the next turn picks a Claude Code${stayed ? ` · ${stayed} stayed on ${name}’s computer` : ''}`));
  }
  const gone = new Set<Id>();
  const cancel = (t: Turn) => { if (gone.has(t.id)) return; gone.add(t.id); out.push({ type: 'turn.cancelled', turnId: t.id, by: m, restore: isOneOff(t) || t.mode === 'merge-note' ? [] : restoreOf(ctx, t) }); };
  for (const a of Object.values(s.asks)) {
    if (a.status !== 'open' || (a.to !== m && a.from !== m)) continue;
    const t = a.turnId ? s.turns[a.turnId] : undefined;
    if (t && t.status === 'held' && (a.kind === 'run-here' || a.from === m)) cancel(t);
    else {
      out.push({ type: 'ask.closed', askId: a.id });
      // A branch owner who left no longer needs to OK it: it runs if nothing else waits.
      if (t && t.status === 'held' && !openAsks(s, t.id).some((x) => x.id !== a.id && x.to !== m && x.from !== m)) out.push({ type: 'turn.released', turnId: t.id });
    }
  }
  // Turns that were going to run in their Claude Code can't now.
  for (const t of Object.values(s.turns)) if (t.runnerId === m && (t.status === 'requested' || t.status === 'held')) cancel(t);
  return out;
}

/** A prompt going back to its writers' box: their parts as they were, files included. */
function restoreOf(ctx: CommandContext, t: Turn): Part[] {
  return t.parts.map((p, i) => ({ id: ctx.id('p'), branchId: t.branchId, memberId: p.memberId, text: p.text, at: ctx.now + i, position: p.position, ...(p.cites ? { cites: p.cites } : {}), ...(p.editedBy ? { editedBy: p.editedBy } : {}), ...(p.files?.length ? { files: p.files } : {}) }));
}

/** Text as one sentence: a full stop added only if it has no closing punctuation. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function latestMain(s: SpaceState): Branch | undefined {
  const c = s.conversationOrder[0];
  return c ? mainOf(s, c) : undefined;
}

/**
 * Whose Claude Code a new turn on this branch runs in: the branch's, whoever sends it. A branch
 * nobody's Claude Code runs yet starts in `runIn` (the sender's choice), else the sender's, and
 * says so once. `online`: refuse to start it in a Claude Code the server knows isn't connected.
 */
function routeTurn(s: SpaceState, ctx: CommandContext, branch: Branch, senderId: MemberId, o: { runIn?: MemberId; online?: boolean } = {}): { runnerId: MemberId; events: EventBody[] } | Decided {
  const runner = branch.runnerId ?? null;
  if (runner) {
    if (o.runIn && o.runIn !== runner) return fail(`This conversation already runs in ${memberName(s, runner)}’s Claude Code.`, 'state');
    // Someone who left, or who can only read now, runs nothing here (security review).
    const m = s.members[runner];
    if (!m || m.leftAt || m.role === 'viewer') return fail(`${memberName(s, runner)} can’t run turns here any more. Move the work to your Claude Code.`, 'state');
    // Fable bills its runner's usage credits without asking in a turn's session: only with their yes.
    const credits = creditsRefusalFor(s, branch.model.name, runner, senderId); if (credits) return fail(credits, 'credits');
    return { runnerId: runner, events: [] };
  }
  const first = o.runIn ?? senderId;
  const who = s.members[first];
  if (!who || who.leftAt || who.role === 'viewer') return fail('That person can’t run turns here.');
  const credits = creditsRefusalFor(s, branch.model.name, first, senderId); if (credits) return fail(credits, 'credits');
  if (o.online && ctx.online && !ctx.online.includes(first)) {
    return fail(first === senderId
      ? 'Connect your Claude Code to start this conversation, or let someone who has one send first.'
      : `${memberName(s, first)}’s Claude Code isn’t connected.`, 'offline');
  }
  const main = s.conversations[branch.conversationId]?.mainBranchId === branch.id;
  return {
    runnerId: first,
    events: [
      { type: 'branch.runner', branchId: branch.id, runnerId: first, from: null, why: 'first' },
      ev(ctx, branch.id, 'laptop', `This ${main ? 'conversation' : 'branch'} runs in ${memberName(s, first)}’s Claude Code`),
    ],
  };
}

function turnFrom(ctx: CommandContext, s: SpaceState, branch: Branch, parts: Turn['parts'], patch: Partial<Turn> = {}): Turn {
  return {
    id: ctx.id('t'),
    branchId: branch.id,
    conversationId: branch.conversationId,
    parts,
    senderId: ctx.actor as MemberId,
    runnerId: ctx.actor as MemberId,
    mode: 'normal',
    status: 'requested',
    requestedAt: ctx.now,
    steps: [],
    text: '',
    model: branch.model.name,
    private: branch.private || undefined,
    ...patch,
  };
}

/**
 * Validates a command against the state and turns it into events.
 * The one place the rules live: who may do what, when.
 */
export function decide(s: SpaceState, ctx: CommandContext, cmd: Command): Decided {
  const bad = invalid(cmd);
  if (bad) return fail(bad, 'invalid');
  const actor = ctx.actor;
  const me = actor === 'server' ? undefined : s.members[actor];
  const isServer = actor === 'server';
  const isRunnerCmd = cmd.type.startsWith('runner.');
  const isServerCmd = cmd.type.startsWith('server.');

  if (isServerCmd && !isServer) return fail('Only the server can do that.', 'forbidden');
  if (!isServer && (!me || me.leftAt)) return fail('You are not in this space.', 'forbidden');
  if (isRunnerCmd && ctx.source !== 'runner' && ctx.source !== 'mcp') return fail('Only a runner can report on turns.', 'forbidden');

  const ended = !!s.space.endedAt;
  if (ended && !['seen', 'member.notify', 'sharing.set'].includes(cmd.type)) return fail('This space has ended. It is read-only.', 'ended');

  const role = me?.role;
  const canWrite = isServer || role === 'host' || role === 'prompter';
  const isHost = isServer || role === 'host';
  const needWrite = (): Decided | null => (canWrite ? null : fail('Viewers can read and chat, but not write to Claude.', 'forbidden'));
  const needHost = (): Decided | null => (isHost ? null : fail('Only the host can do that.', 'forbidden'));
  const branchOk = (id: Id): Branch | Decided => {
    const b = s.branches[id];
    if (!b || !canSee(s, actor, id)) return fail('No such branch.', 'not-found');
    return b;
  };
  const isDecided = (x: unknown): x is Decided => !!x && typeof x === 'object' && 'ok' in (x as object);
  /** Turns someone can't see (another person's recap or private lane) don't exist for them. */
  const seesTurn = (t: Turn | undefined): t is Turn => !!t && (isServer || canSeeTurn(s, actor as MemberId, t));
  const seesBranchOf = (branchId: Id | null | undefined) => !branchId || isServer || canSee(s, actor, branchId);

  switch (cmd.type) {
    // ---------------------------------------------------------------- members
    case 'member.rename': {
      const name = cmd.name.trim();
      if (!name || name.length > 40) return fail('Names are 1 to 40 characters.');
      return ok({ type: 'member.updated', memberId: actor as MemberId, patch: { name } });
    }
    case 'member.notify':
      return ok({ type: 'member.updated', memberId: actor as MemberId, patch: { notify: cmd.notify } });
    case 'member.prefs': {
      // Your own Claude Code, so anyone may set theirs, someone who can only read included.
      if (cmd.budget !== undefined && !(cmd.budget >= 0 && cmd.budget <= 1000)) return fail('A budget is 0 to 1000 dollars.');
      const was = s.members[actor]?.prefs ?? {};
      const out: EventBody[] = [];
      const mode = cmd.mode ?? was.mode;
      const credits = cmd.credits ?? was.credits;
      if (cmd.mode !== undefined || cmd.credits !== undefined) out.push({ type: 'member.prefs', memberId: actor as MemberId, prefs: { ...(mode ? { mode } : {}), ...(credits ? { credits } : {}) } });
      if (cmd.budget !== undefined) out.push({ type: 'member.budget', memberId: actor as MemberId, budget: cmd.budget });
      if (!out.length) return fail('Nothing to change.');
      return ok(...out);
    }
    case 'sharing.set': {
      // Only for yourself, and only to stop sharing everything at once with '*'.
      if (cmd.source === '*' && cmd.on) return fail('Share one source at a time.');
      if (!cmd.on && cmd.source !== '*' && !s.sharing?.[actor]?.[cmd.source]) return fail('That isn’t shared here.');
      return ok({ type: 'sharing.changed', memberId: actor as MemberId, source: cmd.source, name: cmd.name.trim() || cmd.source, on: cmd.on });
    }
    case 'member.limit-clear':
      return ok({ type: 'member.updated', memberId: actor as MemberId, patch: { limit: null } });
    case 'member.role': {
      const deny = needHost(); if (deny) return deny;
      const m = s.members[cmd.memberId];
      if (!m || m.leftAt) return fail('No such member.');
      if (cmd.role === 'host') return ok({ type: 'space.host', hostId: m.id });
      if (m.id === s.space.hostId) return fail('Hand hosting to someone else first.');
      // Someone who can only read runs nothing here: their branches stop running in their Claude Code.
      const readOnly = cmd.role === 'viewer' && m.role !== 'viewer' ? leaveEvents(s, ctx, m.id, 'viewer') : [];
      return ok({ type: 'member.updated', memberId: m.id, patch: { role: cmd.role } }, ...readOnly);
    }
    case 'member.leave': {
      const out: EventBody[] = [];
      const main = latestMain(s);
      const name = memberName(s, actor);
      if (actor === s.space.hostId) {
        if (cmd.end) {
          out.push({ type: 'space.ended' });
          if (main) out.push(ev(ctx, main.id, 'power', `${name} ended the space · everyone kept a full copy`));
          return ok(...out);
        }
        const to = cmd.handTo && s.members[cmd.handTo] && !s.members[cmd.handTo].leftAt ? cmd.handTo
          : Object.values(s.members).find((m) => !m.leftAt && m.id !== actor && m.role !== 'viewer')?.id
          ?? Object.values(s.members).find((m) => !m.leftAt && m.id !== actor)?.id;
        if (!to) {
          out.push({ type: 'space.ended' });
          if (main) out.push(ev(ctx, main.id, 'power', `${name} left, and the space ended`));
          out.push(...leaveEvents(s, ctx, actor as MemberId, 'left'), { type: 'member.left', memberId: actor as MemberId });
          return ok(...out);
        }
        out.push({ type: 'space.host', hostId: to });
        out.push(...leaveEvents(s, ctx, actor as MemberId, 'left'), { type: 'member.left', memberId: actor as MemberId });
        if (main) out.push(ev(ctx, main.id, 'crown', `${name} left · ${memberName(s, to)} is the host now`));
        return ok(...out);
      }
      out.push(...leaveEvents(s, ctx, actor as MemberId, 'left'), { type: 'member.left', memberId: actor as MemberId });
      if (main) out.push(ev(ctx, main.id, 'logout', `${name} left the space`));
      return ok(...out);
    }
    case 'member.remove': {
      const deny = needHost(); if (deny) return deny;
      const m = s.members[cmd.memberId];
      if (!m || m.leftAt) return fail('No such member.');
      if (m.id === actor) return fail('Use Leave to leave the space yourself.');
      const main = latestMain(s);
      const out: EventBody[] = [...leaveEvents(s, ctx, m.id, 'left'), { type: 'member.left', memberId: m.id }];
      if (main) out.push(ev(ctx, main.id, 'logout', `${memberName(s, actor)} removed ${m.name} from the space`));
      return ok(...out);
    }
    case 'space.policy': {
      const deny = needHost(); if (deny) return deny;
      // Spaces from before the sandbox promise was dropped still carry `sandbox`; it goes on the next change.
      const { sandbox: _dropped, ...policy } = { ...DEFAULT_POLICY, ...s.space.policy, ...cmd.policy } as Policy & { sandbox?: unknown };
      if (policy.leaseSeconds < 10 || policy.leaseSeconds > 3600) return fail('The lease must be between 10 seconds and an hour.');
      return ok({ type: 'space.policy', policy });
    }
    case 'space.end': {
      const deny = needHost(); if (deny) return deny;
      const main = latestMain(s);
      const out: EventBody[] = [{ type: 'space.ended' }];
      if (main) out.push(ev(ctx, main.id, 'power', `${memberName(s, actor)} ended the space · everyone kept a full copy`));
      return ok(...out);
    }

    // ---------------------------------------------------------- conversations
    case 'conversation.create': {
      const deny = needWrite(); if (deny) return deny;
      const prev = latestMain(s);
      const conversationId = ctx.id('c');
      const mainId = ctx.id('b');
      const carried = cmd.carry ? s.decisions.filter((d) => d.branchId === null && d.status === 'approved').map((d) => d.id) : [];
      const main: Branch = {
        id: mainId, conversationId, name: 'Main', ownerId: null, parentId: null, forkTurnId: null, private: false, state: 'active',
        model: { name: cmd.model || prev?.model.name || 'opus', effort: 'auto', setBy: actor as MemberId, at: ctx.now },
        createdAt: ctx.now,
      };
      const title = (cmd.title || '').trim() || 'New conversation';
      return ok(
        { type: 'conversation.created', conversation: { id: conversationId, title, createdBy: actor as MemberId, createdAt: ctx.now, mainBranchId: mainId, carried, filesFromMain: cmd.filesFromMain }, main },
        ev(ctx, mainId, 'compose', `${memberName(s, actor)} started this conversation${carried.length ? `, carrying ${carried.length} decision${carried.length === 1 ? '' : 's'}` : ''}`),
      );
    }
    case 'conversation.rename': {
      const deny = needWrite(); if (deny) return deny;
      const c = s.conversations[cmd.conversationId];
      if (!c) return fail('No such conversation.');
      const title = cmd.title.trim();
      if (!title || title.length > 80) return fail('Titles are 1 to 80 characters.');
      return ok({ type: 'conversation.renamed', conversationId: c.id, title });
    }

    // --------------------------------------------------------------- branches
    case 'branch.fork': {
      const deny = needWrite(); if (deny) return deny;
      const parent = branchOk(cmd.fromBranchId); if (isDecided(parent)) return parent;
      let forkTurnId = cmd.atTurnId ?? latestTurnId(s, parent.id) ?? parent.forkTurnId;
      if (cmd.atTurnId) {
        const inHistory = historyTurns(s, parent.id).some((t) => t.id === cmd.atTurnId && seesTurn(t));
        if (!inHistory) return fail('That turn is not on this branch.');
      }
      if (cmd.editOf && !historyTurns(s, parent.id).some((t) => t.id === cmd.editOf && seesTurn(t))) return fail('That turn is not on this branch.');
      const id = ctx.id('b');
      const name = (cmd.name || '').trim() || (cmd.private ? 'Private lane' : cmd.editOf ? `${memberName(s, actor)}’s edit` : `${memberName(s, actor)}’s branch`);
      const branch: Branch = {
        id, conversationId: parent.conversationId, name, ownerId: actor as MemberId, parentId: parent.id,
        forkTurnId: forkTurnId ?? null, editOf: cmd.editOf, private: !!cmd.private || parent.private, state: 'active',
        model: { ...parent.model }, createdAt: ctx.now,
        // It runs where its parent runs, as Claude Code forks a session where it is; a private
        // lane, or one branched off "in my Claude Code", runs in its owner's.
        runnerId: cmd.private || parent.private || cmd.inMine ? actor as MemberId : parent.runnerId ?? null,
      };
      const out: EventBody[] = [{ type: 'branch.created', branch }];
      const at = cmd.atTurnId && s.turns[cmd.atTurnId] ? hhmm(s.turns[cmd.atTurnId].requestedAt) : null;
      if (!branch.private) {
        out.push(ev(ctx, parent.id, 'branch', `${memberName(s, actor)} branched “${name}”${at ? ` from ${at}` : ''}`, { kind: 'branch', id, label: 'Open' }));
      }
      out.push(ev(ctx, id, branch.private ? 'lock' : 'branch', branch.private ? 'Your private lane, from the latest turn' : `Branched from ${parent.name}${at ? ` at ${at}` : ''}${cmd.editOf ? ', with an edit' : ''}`));
      if (cmd.inMine && !branch.private) out.push(ev(ctx, id, 'laptop', `This branch runs in ${memberName(s, actor)}’s Claude Code`));
      const original = cmd.editOf ? s.turns[cmd.editOf] : undefined;
      if (cmd.editParts && original) {
        // A reveal's positions are shown without names: an edit must not put them back.
        if (original.mode === 'reveal') return fail('Opinions shown after Claude’s answer can’t be edited.');
        // Each person's part stays theirs; one someone else changed says who changed it.
        const authors = new Set<string>([...original.parts.map((p) => p.memberId), actor]);
        if (cmd.editParts.some((p) => !authors.has(p.memberId))) return fail('An edit keeps the turn’s own authors.');
        const parts: Turn['parts'] = cmd.editParts.filter((p) => p.text.trim()).map((p) => {
          const text = p.text.trim();
          // Unchanged keeps its marker (it's still the earlier editor's wording); changed by someone else gets theirs.
          const prev = original.parts.find((o) => !o.position && o.memberId === p.memberId && o.text.trim() === text);
          const editedBy = prev ? prev.editedBy : p.memberId !== actor ? actor as MemberId : undefined;
          return { memberId: p.memberId as MemberId, text, ...(editedBy ? { editedBy } : {}) };
        });
        if (!parts.length) return fail('Nothing to send.');
        // Positions held back stay exactly as they were, and held back: the editor never saw them.
        const held = original.parts.filter((p) => p.position).map((p) => ({ ...p }));
        const route = routeTurn(s, ctx, branch, actor as MemberId, { online: true }); if (!routed(route)) return route;
        const oks = oksFor(s, branch, actor as MemberId, route.runnerId);
        const t = turnFrom(ctx, s, branch, [...parts, ...held], { ...(held.length ? { mode: 'view-first' } : {}), runnerId: route.runnerId, status: oks.length ? 'held' : 'requested' });
        out.push(...route.events, { type: 'turn.requested', turn: t, consumed: [] }, ...askEvents(ctx, branch, t, oks));
      } else if (cmd.editText && cmd.editText.trim()) {
        const route = routeTurn(s, ctx, branch, actor as MemberId, { online: true }); if (!routed(route)) return route;
        const oks = oksFor(s, branch, actor as MemberId, route.runnerId);
        const t = turnFrom(ctx, s, branch, [{ memberId: actor as MemberId, text: cmd.editText.trim() }], { runnerId: route.runnerId, status: oks.length ? 'held' : 'requested' });
        out.push(...route.events, { type: 'turn.requested', turn: t, consumed: [] }, ...askEvents(ctx, branch, t, oks));
      }
      return ok(...out);
    }
    case 'branch.state': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (isMain(s, b.id)) return fail('A main line can’t be parked.');
      if (b.state === 'merged') return fail('That branch was merged.');
      const out: EventBody[] = [{ type: 'branch.updated', branchId: b.id, patch: { state: cmd.state } }];
      out.push(ev(ctx, b.id, cmd.state === 'parked' ? 'pause' : 'play', cmd.state === 'parked' ? `Parked by ${memberName(s, actor)}` : `${memberName(s, actor)} picked it back up`));
      return ok(...out);
    }
    case 'branch.rename': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const name = cmd.name.trim();
      if (!name || name.length > 60) return fail('Names are 1 to 60 characters.');
      return ok({ type: 'branch.updated', branchId: b.id, patch: { name } });
    }
    case 'branch.model': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (![...EFFORTS, 'auto'].includes(cmd.effort)) return fail('Effort is Low, Medium, High, Extra high, Max or Default.');
      if (cmd.fast && !fastOk(cmd.name)) return fail('Fast mode is for Opus 5.5, Opus 5 and Opus 4.8.');
      if (cmd.style === 'Learning' && !b.private) return fail('Learning asks you to write code yourself, so it’s for private lanes.');
      if (cmd.advisor && cmd.advisor !== 'off' && !isModelName(cmd.advisor)) return fail('An advisor is a model, or Off.');
      if (cmd.fallback && !isModelName(cmd.fallback)) return fail('A fallback is a model.');
      if (cmd.thinking === false && !thinkingToggles(cmd.name)) return fail(`${modelLabel(cmd.name)} thinks on every turn.`);
      // The whole pin each time: what a switch leaves out goes back to its Claude Code's own.
      const model: ModelPin = {
        name: cmd.name, effort: cmd.effort, ...(cmd.fast ? { fast: true } : {}), ...(cmd.style ? { style: cmd.style } : {}),
        ...(cmd.advisor ? { advisor: cmd.advisor } : {}), ...(cmd.thinking === false ? { thinking: false as const } : {}), ...(cmd.fallback ? { fallback: cmd.fallback } : {}),
        setBy: actor as MemberId, at: ctx.now,
      };
      return ok(
        { type: 'branch.model', branchId: b.id, model },
        ev(ctx, b.id, 'layers', `${memberName(s, actor)} switched ${isMain(s, b.id) ? 'main' : 'this branch'} to ${pinText(model)}, for everyone`),
      );
    }

    case 'branch.import': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (b.parentId || b.private) return fail('A conversation comes in as a conversation’s main line.');
      // Into an empty main line, or one this same person is still bringing a conversation into.
      const there = turnsOf(s, b.id);
      if (there.some((t) => !t.imported || t.senderId !== actor)) return fail('That conversation has turns of its own already. Bring it into a new conversation.');
      if (there.length + cmd.turns.length > IMPORT_MAX) return fail(`A conversation brought in can have up to ${IMPORT_MAX} turns.`);
      const source = { from: cmd.source.from, ...(cmd.source.title ? { title: clip(cmd.source.title.trim(), 200) } : {}) };
      const events: EventBody[] = [];
      if (!there.length) {
        events.push(ev(ctx, b.id, 'download', `${memberName(s, actor)} brought in a conversation from ${source.from === 'claude-code' ? 'Claude Code' : 'claude.ai'}${source.title ? `: “${clip(source.title, 80)}”` : ''}`));
        // It carries on on the model it was had on.
        if (cmd.model) events.push({ type: 'branch.model', branchId: b.id, model: { name: cmd.model, effort: b.model.effort, setBy: actor as MemberId, at: ctx.now } });
        // And in the Claude Code it was had in: the session is on the importer's computer.
        if (b.runnerId !== actor) events.push({ type: 'branch.runner', branchId: b.id, runnerId: actor as MemberId, from: b.runnerId ?? null, why: 'first' });
      }
      // Times as they were there, kept in order and never in the future.
      let last = there.length ? there[there.length - 1].requestedAt : 0;
      for (const x of cmd.turns) {
        const at = Math.max(last, Math.min(ctx.now, typeof x.at === 'number' && x.at > 0 ? x.at : ctx.now));
        last = at;
        const prompt = x.prompt.trim() || '(no text)';
        const turn: Turn = {
          id: ctx.id('t'), branchId: b.id, conversationId: b.conversationId,
          parts: [{ memberId: actor as MemberId, text: prompt }], senderId: actor as MemberId, runnerId: actor as MemberId,
          mode: 'normal', status: 'done', requestedAt: at, startedAt: at, endedAt: at,
          steps: (x.steps ?? []).map((st, i) => ({ i, tool: st.tool, text: st.text, state: st.failed ? 'fail' as const : 'done' as const })),
          text: x.text, model: x.model || undefined, imported: source,
        };
        events.push({ type: 'turn.imported', turn });
      }
      return ok(...events);
    }

    // -------------------------------------------------------------- writing
    case 'part.add': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const text = cmd.text.trim();
      const refused = slashRefusal(text); if (refused) return fail(refused);
      // Files attached: ones this person uploaded to this branch, a few at a time.
      let files: Id[] | undefined;
      if (cmd.files !== undefined) {
        const fs = cmd.files;
        if (!Array.isArray(fs) || fs.length > PART_FILES_MAX || fs.some((f) => typeof f !== 'string')) return fail(`Attach up to ${PART_FILES_MAX} files to one part.`);
        if (fs.some((f) => { const x = s.files?.[f as string]; return !x || x.by !== actor || x.branchId !== b.id || x.from !== 'upload'; })) return fail('Attach a file you uploaded here.');
        files = fs.length ? [...new Set(fs as Id[])] : undefined;
      }
      if (!text && !files) return fail('Write something first.');
      if (text.length > 20000) return fail('That part is too long.');
      if (b.state === 'merged') return fail('That branch was merged. Write in main instead.');
      if (cmd.id && (s.parts[b.id] || []).some((p) => p.id === cmd.id)) return ok(); // already have it (offline replay)
      let cites: Id | undefined;
      if (cmd.cites) {
        // A finished, shared turn from another branch: private lanes share through notes instead.
        const c = s.turns[cmd.cites];
        if (!seesTurn(c) || c.private || isOneOff(c) || (c.status !== 'done' && c.status !== 'stopped')) return fail('Cite a finished turn you can see.');
        if (historyTurns(s, b.id).some((t) => t.id === c.id)) return fail('That turn is already part of this branch.');
        cites = c.id;
      }
      const part: Part = { id: cmd.id || ctx.id('p'), branchId: b.id, memberId: actor as MemberId, text, at: ctx.now, position: cmd.position || undefined, ...(cites ? { cites } : {}), ...(files ? { files } : {}) };
      return ok({ type: 'part.added', part });
    }
    case 'part.remove': {
      for (const [branchId, list] of Object.entries(s.parts)) {
        const p = list.find((x) => x.id === cmd.partId);
        if (p) {
          if (p.memberId !== actor && !isHost) return fail('You can only remove your own parts.');
          return ok({ type: 'part.removed', partId: p.id, branchId });
        }
      }
      return ok();
    }
    case 'turn.send': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (b.state === 'merged') return fail('That branch was merged.');
      // /context: what this person's own session of the branch holds, to them alone (as a side question).
      if (cmd.mode === 'context') {
        const text = (cmd.text ?? '').trim();
        if (!/^\/context(\s|$)/.test(text)) return fail('Send /context on its own.');
        if (Object.values(s.turns).some((x) => x.mode === 'context' && x.senderId === actor && isActive(x))) return fail('Your /context is on its way.');
        const turn = turnFrom(ctx, s, b, [{ memberId: actor as MemberId, text }], { mode: 'context', private: true, checked: true });
        return ok({ type: 'turn.requested', turn, consumed: [] });
      }
      const busy = activeTurn(s, b.id);
      if (busy) return fail(`${memberName(s, busy.runnerId)}’s turn is still running here. One at a time on each branch.`, 'busy');
      // /compact: the branch's session, compacted for everyone, where it runs (asking as a turn would).
      if (cmd.mode === 'compact') {
        const text = (cmd.text ?? '').trim();
        if (!/^\/compact(\s|$)/.test(text)) return fail('Send /compact, and what to keep if you like.');
        const route = routeTurn(s, ctx, b, actor as MemberId, { online: true }); if (!routed(route)) return route;
        const oks = oksFor(s, b, actor as MemberId, route.runnerId);
        const turn = turnFrom(ctx, s, b, [{ memberId: actor as MemberId, text }], { mode: 'compact', status: oks.length ? 'held' : 'requested', runnerId: route.runnerId, checked: true });
        return ok(...route.events, { type: 'turn.requested', turn, consumed: [] }, ...askEvents(ctx, b, turn, oks));
      }
      const parts = s.parts[b.id] || [];
      if (!parts.length) return fail('Nothing to send yet.');
      const mode = cmd.mode === 'view-first' ? 'view-first' : 'normal';
      if (mode === 'view-first') {
        if (!parts.some((p) => p.position)) return fail('Add at least one opinion to hide.');
        if (!parts.some((p) => !p.position)) return fail('Add the question first: turn off Hide opinions and write what you’re asking.');
      }
      const out: EventBody[] = [];
      if (b.state === 'parked') {
        out.push({ type: 'branch.updated', branchId: b.id, patch: { state: 'active' } });
      }
      let handedFrom: MemberId | undefined;
      if (cmd.handoffId) {
        const h = s.handoffs[cmd.handoffId];
        if (!h || h.status !== 'offered' || h.to !== actor) return fail('That hand-off isn’t yours to take.');
        handedFrom = h.from;
        out.push({ type: 'handoff.updated', handoffId: h.id, status: 'taken' });
      }
      const route = routeTurn(s, ctx, b, actor as MemberId, { runIn: cmd.runIn, online: true }); if (!routed(route)) return route;
      const oks = oksFor(s, b, actor as MemberId, route.runnerId);
      const turn = turnFrom(ctx, s, b, parts.map((p) => ({ memberId: p.memberId, text: p.text, position: p.position || undefined, ...(p.cites ? { cites: p.cites } : {}), ...(p.editedBy ? { editedBy: p.editedBy } : {}), ...(p.files?.length ? { files: p.files } : {}) })), {
        mode, status: oks.length ? 'held' : 'requested', handedFrom, ...(cmd.plan ? { plan: true } : {}), ...(cmd.research ? { research: true } : {}), runnerId: route.runnerId,
      });
      out.push(...route.events, { type: 'turn.requested', turn, consumed: parts.map((p) => p.id) }, ...askEvents(ctx, b, turn, oks));
      return ok(...out);
    }
    case 'turn.steer': {
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!seesTurn(t)) return fail('No such turn.');
      const refused = steerRefusal(s, t, actor as MemberId); if (refused) return fail(refused);
      const text = cmd.text.trim();
      if (!text) return fail('Write something to add.');
      if ((t.steers?.length ?? 0) >= 20) return fail('That’s a lot to add to one turn. Add the rest to the next prompt.');
      return ok({ type: 'turn.steered', turnId: t.id, steer: { n: (t.steers?.length ?? 0) + 1, by: actor as MemberId, text, at: ctx.now } });
    }
    case 'turn.resolve': {
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!seesTurn(t) || t.status !== 'conflict' || !t.conflict) return fail('Nothing to settle there.');
      if (cmd.pick === 'cancel') {
        const restore: Part[] = restoreOf(ctx, t);
        return ok({ type: 'turn.cancelled', turnId: t.id, by: actor as MemberId, restore });
      }
      if (cmd.pick === 'both') {
        return ok({ type: 'turn.resolved', turnId: t.id, pick: 'both', parts: t.parts, mode: 'weigh' });
      }
      const conflicting = new Set(t.conflict.conflicting);
      const opt = t.conflict.options.find((o) => o.key === cmd.pick);
      if (!opt) return fail('Pick one of the options.');
      const keepBy = opt.memberId;
      const parts = t.parts.filter((p, i) => !conflicting.has(i) || (keepBy ? p.memberId === keepBy : false));
      if (!parts.length) return fail('That would leave nothing to send.');
      return ok({ type: 'turn.resolved', turnId: t.id, pick: cmd.pick, parts, mode: t.mode });
    }
    case 'turn.stop': {
      const t = s.turns[cmd.turnId];
      if (!seesTurn(t) || !isActive(t)) return fail('That turn isn’t running.');
      if (!canWrite && t.runnerId !== actor) return fail('Viewers can’t stop turns.', 'forbidden');
      if (t.status === 'held' || t.status === 'conflict' || (t.status === 'requested' && !t.startedAt)) {
        // A recap's text is the asker's own: it never goes back into anyone's draft.
        const restore: Part[] = isOneOff(t) || t.mode === 'merge-note' ? [] : restoreOf(ctx, t);
        return ok({ type: 'turn.cancelled', turnId: t.id, by: actor as MemberId, restore });
      }
      return ok({ type: 'turn.stopped', turnId: t.id, by: actor as MemberId });
    }
    case 'turn.takeover': {
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!seesTurn(t) || t.status !== 'paused' || !t.pausedAt) return fail('Only a paused turn can be taken over.');
      if (isOneOff(t) && t.senderId !== actor) return fail('Only a paused turn can be taken over.');
      const waited = ctx.now - t.pausedAt;
      if (waited < s.space.policy.leaseSeconds * 1000) return fail(`Wait ${Math.ceil((s.space.policy.leaseSeconds * 1000 - waited) / 1000)} more seconds, in case ${memberName(s, t.runnerId)} comes back.`, 'lease');
      if (t.runnerId === actor) return ok({ type: 'turn.resumed', turnId: t.id });
      // Taking over is moving the work: the branch runs in the taker's Claude Code from now on.
      const tb = s.branches[t.branchId];
      const moves = tb && !isOneOff(t) && tb.runnerId !== actor;
      if (moves) { const wrong = wrongProject(s, ctx, tb, actor as MemberId); if (wrong) return fail(wrong); }
      return ok({ type: 'turn.takeover', turnId: t.id, runnerId: actor as MemberId }, ...(moves ? moveEvents(s, ctx, tb, actor as MemberId, 'takeover', false) : []));
    }
    case 'turn.retry': {
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!seesTurn(t) || !['failed', 'stopped', 'declined'].includes(t.status)) return fail('Only a failed or stopped turn can be retried.');
      if (isOneOff(t) && t.senderId !== actor) return fail('Only a failed or stopped turn can be retried.');
      const b = branchOk(t.branchId); if (isDecided(b)) return b;
      const busy = activeTurn(s, b.id);
      if (busy) return fail('Another turn is running on this branch.', 'busy');
      // A side question or recap is its asker's own; anything else runs where its branch runs.
      const route = isOneOff(t) ? { runnerId: actor as MemberId, events: [] } : routeTurn(s, ctx, b, actor as MemberId, { online: true }); if (!routed(route)) return route;
      if (isOneOff(t)) { const credits = creditsRefusalFor(s, b.model.name, actor as MemberId, actor as MemberId); if (credits) return fail(credits, 'credits'); }
      const oks = isOneOff(t) ? [] : oksFor(s, b, actor as MemberId, route.runnerId);
      const turn = turnFrom(ctx, s, b, t.parts, { mode: t.mode === 'reveal' ? 'reveal' : t.mode, retryOf: t.id, revealOf: t.revealOf, checked: true, private: t.private, runnerId: route.runnerId, status: oks.length ? 'held' : 'requested' });
      return ok(...route.events, { type: 'turn.requested', turn, consumed: [] }, ...askEvents(ctx, b, turn, oks));
    }
    case 'turn.reveal': {
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!seesTurn(t) || t.mode !== 'view-first' || t.status !== 'done') return fail('Opinions are shown after Claude’s first answer.');
      if (Object.values(s.turns).some((x) => x.revealOf === t.id && x.status !== 'failed' && x.status !== 'stopped')) return fail('Already shown.');
      const b = branchOk(t.branchId); if (isDecided(b)) return b;
      const busy = activeTurn(s, b.id);
      if (busy) return fail('Another turn is running on this branch.', 'busy');
      const positions = t.parts.filter((p) => p.position);
      // Shuffle so the order says nothing about who sent it.
      const shuffled = positions.map((p, i) => ({ p, k: (i * 7919 + t.id.length * 31 + ctx.now) % 101 })).sort((a, b2) => a.k - b2.k).map((x) => ({ memberId: x.p.memberId, text: x.p.text, position: true }));
      const route = routeTurn(s, ctx, b, actor as MemberId, { online: true }); if (!routed(route)) return route;
      const oks = oksFor(s, b, actor as MemberId, route.runnerId);
      const turn = turnFrom(ctx, s, b, shuffled, { mode: 'reveal', revealOf: t.id, checked: true, runnerId: route.runnerId, status: oks.length ? 'held' : 'requested' });
      return ok(...route.events, { type: 'turn.requested', turn, consumed: [] }, ...askEvents(ctx, b, turn, oks));
    }
    case 'handoff.offer': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const to = s.members[cmd.to];
      if (!to || to.leftAt || to.role === 'viewer' || to.id === actor) return fail('Hand it to someone who can send.');
      const parts = (s.parts[b.id] || []).map((p) => ({ memberId: p.memberId, text: p.text }));
      if (!parts.length) return fail('Nothing to hand off.');
      const out: EventBody[] = [];
      for (const h of Object.values(s.handoffs)) if (h.status === 'offered' && h.branchId === b.id) out.push({ type: 'handoff.updated', handoffId: h.id, status: 'cancelled' });
      out.push({ type: 'handoff.offered', handoff: { id: ctx.id('h'), branchId: b.id, from: actor as MemberId, to: to.id, parts, status: 'offered', at: ctx.now } });
      return ok(...out);
    }
    case 'handoff.cancel': {
      const h = s.handoffs[cmd.handoffId];
      if (!h || h.status !== 'offered') return ok();
      if (h.from !== actor && h.to !== actor) return fail('Not your hand-off.');
      return ok({ type: 'handoff.updated', handoffId: h.id, status: 'cancelled' });
    }
    case 'ask.answer': {
      const a = s.asks[cmd.askId];
      if (!a || a.status !== 'open') return fail('That request was already answered.');
      if (a.to !== actor) return fail(a.kind === 'send-in-branch' ? 'Only the branch owner can answer that.' : `Only ${memberName(s, a.to)} can answer that.`, 'forbidden');
      const out: EventBody[] = [{ type: 'ask.answered', askId: a.id, allow: cmd.allow }];
      if (a.kind === 'move') {
        if (!cmd.allow) return ok(...out);
        const b = s.branches[a.branchId];
        if (!b || b.state === 'merged') return fail('That branch is gone.');
        const to = a.moveTo!;
        // Asked of its runner (a request) or by it (an offer): it must still run there.
        const runner = a.moveTo === a.from ? a.to : a.from;
        if (b.runnerId !== runner) return fail('It runs somewhere else now.', 'state');
        if (activeTurn(s, b.id)) return fail('Wait for the turn to finish, or stop it first.', 'busy');
        if (moving(s, b.id)) return fail('Its work is already on its way to another Claude Code.', 'busy');
        const off = offline(s, ctx, to); if (off) return fail(off, 'state');
        const wrong = wrongProject(s, ctx, b, to); if (wrong) return fail(wrong);
        // The Claude Code it leaves just asked or answered, so it's here to send the work.
        const sends = !s.members[runner]?.leftAt && (!ctx.online || ctx.online.includes(runner));
        return ok(...out, ...moveEvents(s, ctx, b, to, 'moved', sends, a.id));
      }
      // "Yes, and don't ask again for them here": their turns run in my Claude Code in this conversation.
      const t = s.turns[a.turnId];
      if (cmd.allow && cmd.always && a.kind === 'run-here' && t) out.push({ type: 'run.allowed', conversationId: t.conversationId, runnerId: actor as MemberId, memberId: a.from, on: true });
      if (t && t.status === 'held') {
        // It runs once everyone it waits on said yes; one No sends it back to its writers' box.
        if (!cmd.allow) out.push({ type: 'turn.cancelled', turnId: t.id, by: actor as MemberId, restore: restoreOf(ctx, t) });
        else if (!openAsks(s, t.id).some((x) => x.id !== a.id)) out.push({ type: 'turn.released', turnId: t.id });
      }
      return ok(...out);
    }
    case 'work.move': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (b.runnerId === actor) return fail('It already runs in your Claude Code.', 'state');
      if (b.private) return fail('A private lane runs in its owner’s Claude Code.');
      if (b.state === 'merged') return fail('That branch was merged.');
      if (activeTurn(s, b.id)) return fail('Wait for the turn to finish, or stop it first.', 'busy');
      if (moving(s, b.id)) return fail('Its work is already on its way to another Claude Code.', 'busy');
      const off = offline(s, ctx, actor as MemberId); if (off) return fail(off, 'state');
      const wrong = wrongProject(s, ctx, b, actor as MemberId); if (wrong) return fail(wrong);
      const from = b.runnerId ?? null;
      // Its Claude Code is gone or offline: the move is at once, and the line says what stayed there.
      if (!from || s.members[from]?.leftAt || (ctx.online && !ctx.online.includes(from))) return ok(...moveEvents(s, ctx, b, actor as MemberId, 'moved', false));
      if (Object.values(s.asks).some((a) => a.kind === 'move' && a.branchId === b.id && a.status === 'open')) return fail('Someone has asked to move it already.', 'state');
      return ok({ type: 'ask.created', ask: { id: ctx.id('a'), kind: 'move', from: actor as MemberId, to: from, branchId: b.id, turnId: '', moveTo: actor as MemberId, status: 'open', at: ctx.now } });
    }
    case 'work.offer': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (b.private) return fail('A private lane runs in its owner’s Claude Code.');
      if (b.runnerId !== actor) return fail('Only the Claude Code it runs in can offer it.', 'forbidden');
      const m = s.members[cmd.to];
      if (!m || m.leftAt || m.role === 'viewer' || cmd.to === actor) return fail('Pick someone in the space who can run turns.');
      if (activeTurn(s, b.id)) return fail('Wait for the turn to finish, or stop it first.', 'busy');
      if (moving(s, b.id)) return fail('Its work is already on its way to another Claude Code.', 'busy');
      if (Object.values(s.asks).some((a) => a.kind === 'move' && a.branchId === b.id && a.status === 'open')) return fail('Someone has asked to move it already.', 'state');
      return ok({ type: 'ask.created', ask: { id: ctx.id('a'), kind: 'move', from: actor as MemberId, to: cmd.to as MemberId, branchId: b.id, turnId: '', moveTo: cmd.to as MemberId, status: 'open', at: ctx.now } });
    }
    case 'files.get': {
      // Files made outside git live only on the computer that made them: a copy comes from there,
      // for someone who works in the conversation (not someone here to watch).
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!t || !seesTurn(t) || isOneOff(t)) return fail('No such turn.');
      if (s.members[actor as MemberId]?.leftAt) return fail('You left this space.', 'forbidden');
      if (!t.work?.uncommitted?.length) return fail('That turn didn’t leave any files to get.');
      if (!t.work.noRepo) return fail('Those are in git: pull them instead.');
      if (t.runnerId === actor) return fail('They’re on your computer already.', 'state');
      const owner = memberName(s, t.runnerId);
      if (s.members[t.runnerId]?.leftAt || (ctx.online && !ctx.online.includes(t.runnerId))) return fail(`${owner}’s Claude Code is offline. Ask ${owner} to come back online to get these.`, 'state');
      if (Object.values(s.transfers ?? {}).some((x) => x.copy?.turnId === t.id && x.to === actor && (x.status === 'packing' || x.status === 'sending'))) return fail('They’re on their way already.', 'busy');
      return ok({ type: 'transfer.started', transfer: { id: ctx.id('tr'), branchId: t.branchId, from: t.runnerId, to: actor as MemberId, status: 'packing', at: ctx.now, copy: { turnId: t.id, paths: [...t.work.uncommitted] } } });
    }
    case 'files.got': {
      const tr = s.transfers?.[cmd.transferId];
      if (!tr || !tr.copy || tr.to !== actor) return fail('No such copy on its way to you.', 'forbidden');
      if (tr.status !== 'sending' && tr.status !== 'packing') return ok();
      return ok({ type: 'transfer.updated', transferId: tr.id, status: cmd.ok ? 'done' : 'failed', ...(cmd.ok ? {} : { summary: 'it didn’t all arrive' }) });
    }
    case 'work.send': {
      // The work moved away while this Claude Code was offline: it sends what it kept, late.
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const to = b.runnerId;
      if (!to || to === actor) return fail('It runs in your Claude Code; there’s nothing to send.', 'state');
      const left = leftBehind(s, b.id, actor as MemberId);
      if (!left.files && !left.commits) return fail('You have nothing of this conversation’s left to send.', 'state');
      if (moving(s, b.id)) return fail('Its work is already on its way.', 'busy');
      // Into a folder Claude isn't working in, and a Claude Code that's here to take it.
      if (activeTurn(s, b.id)) return fail('Wait for the turn to finish, or stop it first.', 'busy');
      const off = offline(s, ctx, to); if (off) return fail(off, 'state');
      return ok(
        { type: 'transfer.started', transfer: { id: ctx.id('tr'), branchId: b.id, from: actor as MemberId, to, status: 'packing', at: ctx.now } },
        ev(ctx, b.id, 'laptop', `${memberName(s, actor)}’s Claude Code is sending what it kept (${countText(left.files, left.commits)}) to ${memberName(s, to)}’s`),
      );
    }
    case 'work.resend': {
      // A move's work didn't come in here (this folder said no): ask the computer it's on for it again.
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      if (b.runnerId !== actor) return fail('It doesn’t run in your Claude Code.', 'forbidden');
      if (moving(s, b.id)) return fail('Its work is already on its way.', 'busy');
      if (activeTurn(s, b.id)) return fail('Wait for the turn to finish, or stop it first.', 'busy');
      const last = Object.values(s.transfers ?? {}).filter((x) => x.branchId === b.id && !x.copy && x.to === actor).sort((x, y) => x.at - y.at).pop();
      if (!last || last.status !== 'failed') return fail('Nothing is waiting to come here.', 'state');
      const from = last.from;
      const left = leftBehind(s, b.id, from);
      if (!left.files && !left.commits) return fail(`${memberName(s, from)}’s computer has nothing of it left to send.`, 'state');
      if (s.members[from]?.leftAt || (ctx.online && !ctx.online.includes(from))) return fail(`${memberName(s, from)}’s Claude Code isn’t connected right now, and the work is on its computer.`, 'state');
      return ok(
        { type: 'transfer.started', transfer: { id: ctx.id('tr'), branchId: b.id, from, to: actor as MemberId, status: 'packing', at: ctx.now } },
        ev(ctx, b.id, 'laptop', `${memberName(s, actor)}’s Claude Code asked for the work again · it’s on its way from ${memberName(s, from)}’s computer`),
      );
    }
    case 'run.allow': {
      // The runner says whose turns run in their Claude Code here without asking.
      const conv = s.conversations[cmd.conversationId];
      if (!conv) return fail('No such conversation.');
      const runsSome = Object.values(s.branches).some((b) => b.conversationId === conv.id && b.runnerId === actor);
      if (!runsSome) return fail('This conversation doesn’t run in your Claude Code.', 'forbidden');
      const m = s.members[cmd.memberId];
      if (!m || cmd.memberId === actor) return fail('Pick someone else in the space.');
      return ok({ type: 'run.allowed', conversationId: conv.id, runnerId: actor as MemberId, memberId: cmd.memberId as MemberId, on: cmd.on });
    }

    // ------------------------------------------------------------- decisions
    case 'decision.propose': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const text = cmd.text.trim();
      if (!text) return fail('Write the decision first.');
      const d: Decision = { id: nextDecisionId(s), text: clip(text, 400), status: 'proposed', proposedBy: actor as MemberId, approvedBy: [], at: ctx.now, dissent: [], notes: [], branchId: isMain(s, b.id) ? null : b.id, conversationId: b.conversationId, replaces: cmd.replaces };
      return ok({ type: 'decision.proposed', decision: d, branchId: b.id });
    }
    case 'decision.approve': {
      const deny = needWrite(); if (deny) return deny;
      const d = s.decisions.find((x) => x.id === cmd.decisionId);
      if (!d || !seesBranchOf(d.branchId)) return fail('No such decision.');
      if (d.status === 'replaced' || d.status === 'withdrawn') return fail('That decision no longer holds.');
      if (d.approvedBy.includes(actor as MemberId)) return ok();
      return ok({ type: 'decision.approved', decisionId: d.id, memberId: actor as MemberId });
    }
    case 'decision.dissent': {
      const deny = needWrite(); if (deny) return deny;
      const d = s.decisions.find((x) => x.id === cmd.decisionId);
      if (!d || !seesBranchOf(d.branchId)) return fail('No such decision.');
      const text = cmd.text.trim();
      if (!text) return fail('Say what you disagree with.');
      return ok({ type: 'decision.dissent', decisionId: d.id, memberId: actor as MemberId, text: clip(text, 400) });
    }
    case 'question.add': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const text = cmd.text.trim();
      if (!text) return fail('Write the question first.');
      return ok({ type: 'question.added', question: { id: nextQuestionId(s), text: clip(text, 300), by: actor as MemberId, at: ctx.now, branchId: isMain(s, b.id) ? null : b.id, conversationId: b.conversationId }, branchId: b.id });
    }
    case 'question.resolve': {
      const deny = needWrite(); if (deny) return deny;
      const q = s.questions.find((x) => x.id === cmd.questionId);
      if (!q || !seesBranchOf(q.branchId)) return fail('No such question.');
      return ok({ type: 'question.updated', questionId: q.id, resolved: !q.resolvedAt });
    }
    case 'chat.send': {
      const text = cmd.text.trim();
      if (!text) return fail('Write something first.');
      if (text.length > 4000) return fail('That message is too long.');
      return ok({ type: 'chat.message', message: { id: ctx.id('m'), memberId: actor as MemberId, text, at: ctx.now } });
    }

    // ---------------------------------------------------------------- merges
    case 'merge.request': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.fromBranchId); if (isDecided(b)) return b;
      if (isMain(s, b.id)) return fail('Main is where merges go.');
      if (b.private) return fail('Share from a private lane instead; it never merges.');
      if (b.state === 'merged') return fail('Already merged.');
      if (Object.values(s.merges).some((m) => m.fromBranchId === b.id && m.status === 'requested')) return fail('There is already a merge request for this branch.');
      const target = b.parentId && s.branches[b.parentId] ? s.branches[b.parentId] : mainOf(s, b.conversationId)!;
      const items: MergeItem[] = [];
      let conflict: { decisionId: string; summary: string } | undefined;
      for (const d of s.decisions.filter((x) => x.branchId === b.id && x.status !== 'withdrawn')) {
        if (d.replaces) {
          const old = s.decisions.find((x) => x.id === d.replaces);
          if (old && old.status === 'approved') {
            conflict = { decisionId: old.id, summary: `${target.name} says: ${sentence(old.text)} This branch says: ${sentence(d.text)}` };
            continue;
          }
        }
        items.push({ key: d.id, kind: 'decision', title: `${d.id} · ${d.text}`, sub: d.status === 'approved' ? 'Approved on the branch' : 'Proposed on the branch', defaultOn: true });
      }
      for (const q of s.questions.filter((x) => x.branchId === b.id && !x.resolvedAt)) {
        items.push({ key: q.id, kind: 'question', title: q.text, sub: 'Open question', defaultOn: true });
      }
      const pushes = s.pushes.filter((p) => p.branchId === b.id);
      if (pushes.length) {
        const n = pushes.reduce((a, p) => a + p.commits.length, 0);
        items.push({ key: 'files', kind: 'files', title: `${n} commit${n === 1 ? '' : 's'} on ${pushes[pushes.length - 1].branch}`, sub: 'The branch’s file changes, into main’s files', defaultOn: false });
      }
      if (conflict && b.ownerId) {
        items.push({ key: 'dissent', kind: 'dissent', title: `${memberName(s, b.ownerId)}’s view, kept as dissent`, sub: `Always travels with ${conflict.decisionId}`, locked: true, defaultOn: true });
      }
      const mergeId = ctx.id('mr');
      return ok(
        { type: 'merge.requested', merge: { id: mergeId, fromBranchId: b.id, toBranchId: target.id, requestedBy: actor as MemberId, at: ctx.now, status: 'requested', items, conflict } },
        ev(ctx, b.id, 'merge', `${memberName(s, actor)} asked to merge this into ${target.name}`, { kind: 'merge', id: mergeId, label: 'Review' }),
      );
    }
    case 'merge.complete': {
      const m = s.merges[cmd.mergeId];
      if (!m || m.status !== 'requested') return fail('That merge isn’t open.');
      if (s.space.policy.hostMerges && !isHost) return fail('Only the host merges into main in this space. You can ask them.', 'forbidden');
      const deny = needWrite(); if (deny) return deny;
      const from = s.branches[m.fromBranchId];
      const to = s.branches[m.toBranchId];
      if (!from || !to) return fail('That branch is gone.');
      const target = isMain(s, to.id) ? null : to.id;
      const picks = { ...Object.fromEntries(m.items.map((i) => [i.key, i.locked ? true : !!(cmd.picks[i.key] ?? i.defaultOn)])) };
      const out: EventBody[] = [];
      const name = memberName(s, actor);
      const brought: string[] = [];
      for (const it of m.items) {
        if (!picks[it.key]) continue;
        if (it.kind === 'decision') {
          out.push({ type: 'decision.updated', decisionId: it.key, branchId: target, note: `Merged from ${from.name}` });
          const d = s.decisions.find((x) => x.id === it.key);
          if (d && d.status === 'proposed' && actor !== 'server') out.push({ type: 'decision.approved', decisionId: d.id, memberId: actor as MemberId });
          brought.push(it.key);
        }
        if (it.kind === 'question') out.push({ type: 'question.updated', questionId: it.key, branchId: target });
      }
      let choiceText = '';
      if (m.conflict) {
        const old = s.decisions.find((x) => x.id === m.conflict!.decisionId)!;
        const nu = s.decisions.find((x) => x.branchId === from.id && x.replaces === old.id)!;
        if (cmd.choice === 'replace' && nu) {
          out.push({ type: 'decision.updated', decisionId: old.id, status: 'replaced', note: `Replaced by ${nu.id} when ${from.name} merged` });
          out.push({ type: 'decision.updated', decisionId: nu.id, branchId: target, note: `Replaced ${old.id}` });
          if (nu.status === 'proposed' && actor !== 'server') out.push({ type: 'decision.approved', decisionId: nu.id, memberId: actor as MemberId });
          choiceText = `${old.id} replaced by ${nu.id}`;
        } else if (cmd.choice === 'open' && nu) {
          out.push({ type: 'question.added', question: { id: nextQuestionId(s), text: clip(`${old.text}, or ${nu.text}?`, 300), by: actor as MemberId, at: ctx.now, branchId: target, conversationId: to.conversationId }, branchId: to.id });
          out.push({ type: 'decision.updated', decisionId: nu.id, status: 'withdrawn', note: 'Left open as a question at merge' });
          choiceText = `${old.id} left open as a question`;
        } else if (nu) {
          out.push({ type: 'decision.updated', decisionId: old.id, note: `Kept when ${from.name} merged` });
          out.push({ type: 'decision.updated', decisionId: nu.id, status: 'withdrawn', note: `Not adopted; ${old.id} kept` });
          if (from.ownerId) out.push({ type: 'decision.dissent', decisionId: old.id, memberId: from.ownerId, text: nu.text });
          choiceText = `${old.id} kept`;
        }
      }
      // The writer gets the branch's own turns as context (buildTurnContext), so the note
      // can carry what the branch found, not only its decisions.
      const noteBrief = [
        `Write the merge note for “${from.name}” going into ${to.name}: two to four plain, specific sentences on what the branch found or concluded that ${to.name} should now know, then what changed in the decisions.`,
        choiceText ? `Conflict: ${choiceText}.` : '',
        brought.length ? `Decisions brought in: ${brought.join(', ')}.` : 'No new decisions brought in.',
        // Only keeping the old decision records the branch owner's view as dissent.
        m.conflict && from.ownerId && cmd.choice === 'keep' ? `${memberName(s, from.ownerId)}’s view is kept as dissent.` : '',
        'Don’t describe how merging works.',
      ].filter(Boolean).join(' ');
      const noteTurn = turnFrom(ctx, s, to, [{ memberId: actor as MemberId, text: noteBrief }], { mode: 'merge-note', mergeId: m.id, checked: true });
      out.push(
        { type: 'branch.updated', branchId: from.id, patch: { state: 'merged' } },
        ev(ctx, to.id, 'merge', `${name} merged “${from.name}” into ${to.name}`, { kind: 'decision', label: 'Decisions' }),
        ev(ctx, from.id, 'merge', `Merged into ${to.name} by ${name}`),
        { type: 'turn.requested', turn: noteTurn, consumed: [] },
        { type: 'merge.done', mergeId: m.id, choice: cmd.choice, picks, noteTurnId: noteTurn.id },
      );
      return ok(...out);
    }
    case 'merge.cancel': {
      const m = s.merges[cmd.mergeId];
      if (!m || m.status !== 'requested') return ok();
      if (m.requestedBy !== actor && !isHost) return fail('Only who asked, or the host, can cancel it.');
      return ok({ type: 'merge.cancelled', mergeId: m.id });
    }
    case 'share.post': {
      const deny = needWrite(); if (deny) return deny;
      if (!cmd.fromBranchId === !cmd.toBranchId) return fail('Share from your private lane, or to a branch.');
      if (cmd.toBranchId) {
        // From the person's own Claude Code: a note they reviewed, on a branch they can write in.
        const to = branchOk(cmd.toBranchId); if (isDecided(to)) return to;
        if (to.private) return fail('Share to a branch the others can see.');
        const text = cmd.text.trim();
        if (!text) return fail('Nothing to share.');
        return ok({ type: 'note.shared', note: { id: ctx.id('n'), branchId: to.id, memberId: actor as MemberId, text: clip(text, 8000), at: ctx.now } });
      }
      const b = branchOk(cmd.fromBranchId!); if (isDecided(b)) return b;
      if (!b.private || b.ownerId !== actor) return fail('Share from your own private lane.');
      const main = mainOf(s, b.conversationId);
      if (!main) return fail('No main line to share to.');
      const text = cmd.text.trim();
      if (!text) return fail('Nothing to share.');
      return ok({ type: 'note.shared', note: { id: ctx.id('n'), branchId: main.id, memberId: actor as MemberId, fromBranchId: b.id, text: clip(text, 8000), question: cmd.question?.trim() || undefined, at: ctx.now } });
    }
    case 'aside.ask': {
      const deny = needWrite(); if (deny) return deny;
      const b = branchOk(cmd.branchId); if (isDecided(b)) return b;
      const text = cmd.text.trim();
      if (!text) return fail('Say what to ask.');
      if (Object.values(s.turns).some((x) => x.mode === 'aside' && x.senderId === actor && isActive(x))) return fail('Your side question is on its way.');
      const turn = turnFrom(ctx, s, b, [{ memberId: actor as MemberId, text }], { mode: 'aside', private: true, checked: true });
      return ok({ type: 'turn.requested', turn, consumed: [] });
    }
    case 'aside.share': {
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!t || t.mode !== 'aside' || t.senderId !== actor) return fail('Bring back a side question of your own.');
      if (t.status !== 'done' || !t.text.trim()) return fail('It hasn’t been answered yet.');
      if (Object.values(s.notes).some((n) => n.turnId === t.id)) return fail('It’s already back.');
      return ok({ type: 'note.shared', note: { id: ctx.id('n'), branchId: t.branchId, memberId: actor as MemberId, turnId: t.id, text: clip(t.text, 8000), question: clip(t.parts[0]?.text ?? '', 2000), at: ctx.now } });
    }
    case 'recap.request': {
      const deny = needWrite(); if (deny) return deny;
      const main = mainOf(s, cmd.conversationId);
      if (!main) return fail('No such conversation.');
      if (!cmd.text.trim()) return fail('Say what to recap.');
      if (Object.values(s.turns).some((x) => x.mode === 'recap' && x.senderId === actor && isActive(x))) return fail('Your recap is on its way.');
      const turn = turnFrom(ctx, s, main, [{ memberId: actor as MemberId, text: cmd.text }], { mode: 'recap', private: true, checked: true });
      return ok({ type: 'turn.requested', turn, consumed: [] });
    }
    case 'seen':
      if (cmd.seq <= (s.seen[actor] || 0)) return ok();
      return ok({ type: 'seen', memberId: actor as MemberId, seq: Math.min(cmd.seq, s.seq) });

    // --------------------------------------------------------------- runners
    case 'runner.check': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn to run.', 'forbidden');
      if (t.status !== 'requested') return fail('That turn isn’t waiting.');
      if (!cmd.conflict.options.length) return fail('A conflict needs options.');
      return ok({ type: 'turn.conflict', turnId: t.id, conflict: cmd.conflict });
    }
    case 'runner.start': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn to run.', 'forbidden');
      if (t.status !== 'requested') return fail(`That turn is ${t.status}.`, 'state');
      // Someone who left or can only read runs nothing shared (security review).
      const me = s.members[actor as MemberId];
      if (!isOneOff(t) && (!me || me.leftAt || me.role === 'viewer')) return fail('You can’t run turns here.', 'forbidden');
      const away = isOneOff(t) ? undefined : moving(s, t.branchId);
      if (away) return fail(`The work is still on its way to ${memberName(s, away.to)}’s Claude Code.`, 'busy');
      const lease = s.leases[t.branchId];
      if (lease && lease.turnId !== t.id && !isOneOff(t)) return fail('Another turn holds this branch.', 'busy');
      // Checked again as it starts: the branch may have switched to Fable since it was sent.
      const pinned = s.branches[t.branchId]?.model.name ?? '';
      const credits = creditsRefusalFor(s, cmd.model || pinned, actor as MemberId, t.senderId) ?? creditsRefusalFor(s, pinned, actor as MemberId, t.senderId);
      if (credits) return fail(credits, 'credits');
      return ok({ type: 'turn.started', turnId: t.id, runnerId: actor as MemberId, model: cmd.model });
    }
    case 'runner.step': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor || !isActive(t)) return fail('Not running.', 'state');
      return ok({ type: 'turn.step', turnId: t.id, step: cmd.step });
    }
    case 'runner.approval': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor || !isActive(t)) return fail('Not running.', 'state');
      return ok({ type: 'turn.approval', turnId: t.id, waiting: cmd.waiting, ...(cmd.waiting && cmd.sharing ? { sharing: true } : {}) });
    }
    case 'runner.text': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn.', 'forbidden');
      return ok({ type: 'turn.text', turnId: t.id, text: cmd.text });
    }
    case 'runner.done': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn.', 'forbidden');
      if (t.status === 'stopped') return ok({ type: 'turn.text', turnId: t.id, text: cmd.text });
      if (!isActive(t)) return fail('That turn already ended.', 'state');
      return ok({ type: 'turn.done', turnId: t.id, text: cmd.text, usage: cmd.usage, model: cmd.model, replies: cmd.replies, ...(cmd.thinking?.trim() ? { thinking: cmd.thinking } : {}), ...(cmd.effort ? { effort: cmd.effort } : {}), ...(cmd.fast !== undefined ? { fast: cmd.fast } : {}), ...(cmd.notices?.length ? { notices: cmd.notices } : {}), ...(cmd.suggestion?.trim() ? { suggestion: cmd.suggestion } : {}) });
    }
    case 'runner.fail': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn.', 'forbidden');
      if (!isActive(t)) return ok();
      const r = cmd.failure.reason;
      if (!t.startedAt && (r === 'limit' || r === 'model-unavailable' || r === 'credits' || r === 'not-connected' || r === 'not-signed-in')) {
        // Declined before anything ran: give the parts back so someone else can send them.
        const out: EventBody[] = [{ type: 'turn.failed', turnId: t.id, failure: cmd.failure }];
        if (t.mode === 'normal' || t.mode === 'view-first' || t.mode === 'weigh') {
          const restore: Part[] = restoreOf(ctx, t);
          out.length = 0;
          out.push({ type: 'turn.cancelled', turnId: t.id, by: actor as MemberId, restore });
        }
        if (r === 'limit') out.push({ type: 'member.updated', memberId: actor as MemberId, patch: { limit: { at: ctx.now, until: cmd.failure.resetsAt } } });
        // A limit shows on the sender's composer; the others leave nothing behind, so say why on the branch.
        const pin = s.branches[t.branchId]?.model.name;
        if (r === 'model-unavailable') out.push(ev(ctx, t.branchId, 'layers', `${memberName(s, actor)}’s Claude Code can’t use ${modelLabel(pin)}, so the turn went back to the draft`));
        if (r === 'not-connected') out.push(ev(ctx, t.branchId, 'power', `${memberName(s, actor)}’s Claude isn’t connected, so the turn went back to the draft`));
        if (r === 'not-signed-in') out.push(ev(ctx, t.branchId, 'power', `${memberName(s, actor)}’s Claude Code isn’t signed in for shared turns, so the turn went back to the draft`));
        return ok(...out);
      }
      return ok({ type: 'turn.failed', turnId: t.id, failure: cmd.failure });
    }
    case 'runner.decision': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn.', 'forbidden');
      if (isOneOff(t) || !canWrite) return fail('Only a shared turn can record decisions.', 'forbidden');
      const text = cmd.text.trim();
      if (!text) return fail('Empty decision.');
      if (cmd.replaces && !s.decisions.some((d) => d.id === cmd.replaces)) return fail(`No decision ${cmd.replaces}.`);
      const d: Decision = { id: nextDecisionId(s), text: clip(text, 400), status: 'proposed', proposedBy: 'claude', turnId: t.id, approvedBy: [], at: ctx.now, dissent: [], notes: [], branchId: isMain(s, t.branchId) ? null : t.branchId, conversationId: t.conversationId, replaces: cmd.replaces };
      return ok({ type: 'decision.proposed', decision: d, branchId: t.branchId });
    }
    case 'runner.question': {
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor) return fail('Not your turn.', 'forbidden');
      if (isOneOff(t) || !canWrite) return fail('Only a shared turn can record questions.', 'forbidden');
      const text = cmd.text.trim();
      if (!text) return fail('Empty question.');
      return ok({ type: 'question.added', question: { id: nextQuestionId(s), text: clip(text, 300), by: 'claude', at: ctx.now, branchId: isMain(s, t.branchId) ? null : t.branchId, conversationId: t.conversationId }, branchId: t.branchId });
    }
    case 'runner.work': {
      // Only the turn's own runner knows its folder; it may say so after the turn ends too.
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor || t.imported) return fail('Not your turn.', 'forbidden');
      if (!t.startedAt) return fail('That turn never ran.', 'state');
      const w = cmd.work;
      const work = {
        ...(w.noRepo ? { noRepo: true } : {}),
        ...(w.uncommitted?.length ? { uncommitted: w.uncommitted } : {}),
        ...(w.more ? { more: w.more } : {}),
        ...(w.commits?.length ? { commits: w.commits } : {}),
        ...(w.pushed && w.commits?.length ? { pushed: w.pushed } : {}),
        at: ctx.now,
      };
      // The branch's project, from the Claude Code it runs in (the fingerprint, never the URL).
      const tb = s.branches[t.branchId];
      const repo: EventBody[] = cmd.repo && tb && tb.runnerId === actor && tb.repo !== cmd.repo ? [{ type: 'branch.repo', branchId: tb.id, repo: cmd.repo }] : [];
      // Nothing changed and nothing was there before: no event.
      if (!t.work && !work.noRepo && !work.uncommitted && !work.more && !work.commits) return ok(...repo);
      return ok({ type: 'turn.work', turnId: t.id, work: { ...work, ...(t.work?.movedTo ? { movedTo: t.work.movedTo } : {}) } }, ...repo);
    }
    case 'runner.pushed': {
      const deny = needWrite(); if (deny) return deny;
      const p = cmd.push;
      if (!p.commits?.length) return fail('Nothing pushed.');
      if (p.branchId && !seesBranchOf(p.branchId)) return fail('No such branch.');
      const push = { ...p, id: ctx.id('fp'), memberId: actor as MemberId, at: ctx.now };
      const out: EventBody[] = [{ type: 'files.pushed', push }];
      if (p.branchId && s.branches[p.branchId] && !s.branches[p.branchId].private) {
        out.push(ev(ctx, p.branchId, 'file', `${memberName(s, actor)} pushed ${p.commits.length} commit${p.commits.length === 1 ? '' : 's'} to ${p.branch}`, { kind: 'map', label: 'Review' }));
      }
      return ok(...out);
    }

    // ---------------------------------------------------------------- server
    case 'server.pause': {
      const t = s.turns[cmd.turnId];
      if (!t || (t.status !== 'running' && t.status !== 'approval')) return ok();
      return ok({ type: 'turn.paused', turnId: t.id });
    }
    case 'server.resume': {
      const t = s.turns[cmd.turnId];
      if (!t || t.status !== 'paused') return ok();
      return ok({ type: 'turn.resumed', turnId: t.id });
    }
    case 'server.transfer-timeout': {
      const tr = s.transfers?.[cmd.transferId];
      if (!tr || (tr.status !== 'packing' && tr.status !== 'sending')) return ok();
      return ok(
        { type: 'transfer.updated', transferId: tr.id, status: 'failed', summary: 'it took too long' },
        // A copy of someone's files says nothing on the branch: only its two people knew of it.
        ...(tr.copy ? [] : [ev(ctx, tr.branchId, 'alert', 'The work couldn’t be sent: it took too long. Only what was pushed came along.')]),
      );
    }
    case 'runner.transfer': {
      const tr = s.transfers?.[cmd.transferId];
      if (!tr || (tr.status !== 'packing' && tr.status !== 'sending')) return fail('No such move under way.', 'state');
      if (cmd.status === 'ready') {
        if (actor !== tr.from || tr.status !== 'packing' || !cmd.manifest) return fail('Only the Claude Code sending it says it’s ready.', 'forbidden');
        return ok({ type: 'transfer.updated', transferId: tr.id, status: 'sending', manifest: cmd.manifest });
      }
      if (actor !== tr.from && actor !== tr.to) return fail('Not your move.', 'forbidden');
      if (cmd.status === 'done') {
        // A copy goes to a browser, which says so itself (files.got).
        if (actor !== tr.to || tr.status !== 'sending' || tr.copy) return fail('Only the Claude Code receiving it says it arrived.', 'forbidden');
        const summary = clip((cmd.summary ?? '').trim() || 'it arrived', 200);
        return ok({ type: 'transfer.updated', transferId: tr.id, status: 'done', summary }, ev(ctx, tr.branchId, 'laptop', `${memberName(s, tr.to)}’s Claude Code has the work: ${summary}`));
      }
      const why = clip((cmd.summary ?? '').trim() || 'something went wrong', 200).replace(/[.!]+$/, '');
      return ok({ type: 'transfer.updated', transferId: tr.id, status: 'failed', summary: why }, ...(tr.copy ? [] : [ev(ctx, tr.branchId, 'alert', `The work couldn’t be sent: ${why}. Only what was pushed came along.`)]));
    }
    case 'runner.arrived': {
      const b = s.branches[cmd.branchId];
      if (!b || b.runnerId !== actor) return fail('It doesn’t run in your Claude Code.', 'forbidden');
      const note = cmd.note?.trim();
      return ok(ev(ctx, b.id, 'laptop', note ? clip(note, 200) : `${memberName(s, actor)}’s Claude Code pulled ${cmd.pulled} commit${cmd.pulled === 1 ? '' : 's'}`));
    }
    case 'runner.schedule': {
      // Claude asked for work later in a turn this runner runs: kept by the space, shown to everyone.
      const deny = needWrite(); if (deny) return deny;
      const t = s.turns[cmd.turnId];
      if (!t || t.runnerId !== actor || !isActive(t)) return fail('Set up work for later from a turn you’re running.', 'forbidden');
      // A side question or recap is private, but a schedule shows on its branch: only from a private lane.
      if (isOneOff(t) || (t.private && !s.branches[t.branchId]?.private)) return fail('Set up work for later from a turn on the branch, not a side question.');
      const prompt = cmd.prompt.trim();
      if (!prompt) return fail('Say what to do then.');
      const ok_ms = (v: number | undefined) => v === undefined || (Number.isFinite(v) && v >= SCHEDULE_MIN_MS && v <= SCHEDULE_MAX_MS);
      if (!ok_ms(cmd.inMs) || !ok_ms(cmd.everyMs)) return fail('Between a minute and 30 days from now, and at least a minute apart.');
      if (cmd.inMs === undefined && cmd.everyMs === undefined) return fail('Say when: in a while, or every so often.');
      if (cmd.times !== undefined && (!Number.isInteger(cmd.times) || cmd.times < 1 || cmd.times > 100)) return fail('Up to 100 times.');
      const mine = Object.values(s.schedules ?? {}).filter((x) => x.by === actor && x.status === 'on').length;
      if (mine >= SCHEDULES_PER_MEMBER) return fail(`You have ${SCHEDULES_PER_MEMBER} running already here. Stop one first.`);
      const schedule: Schedule = {
        id: ctx.id('sc'), branchId: t.branchId, by: actor as MemberId, prompt, next: ctx.now + (cmd.inMs ?? cmd.everyMs!), status: 'on', at: ctx.now, fromTurn: t.id,
        ...(cmd.everyMs !== undefined ? { everyMs: cmd.everyMs } : {}),
        ...(cmd.times !== undefined && cmd.everyMs !== undefined ? { left: cmd.times } : {}),
      };
      return ok({ type: 'schedule.created', schedule });
    }
    case 'schedule.stop': {
      const deny = needWrite(); if (deny) return deny;
      const x = s.schedules?.[cmd.scheduleId];
      if (!x || !canSee(s, actor as MemberId, x.branchId)) return fail('No such schedule.');
      if (x.status !== 'on') return ok();
      return ok({ type: 'schedule.updated', scheduleId: x.id, patch: { status: 'off', stoppedBy: actor as MemberId } });
    }
    case 'server.schedule-fire': {
      const x = s.schedules?.[cmd.scheduleId];
      if (!x || x.status !== 'on' || x.next > ctx.now) return fail('Not due.', 'state');
      const b = s.branches[x.branchId];
      const runner = s.members[x.by];
      // Its branch, its person, or their right to prompt there gone: it stops, saying so.
      const writes = !!runner && (runner.role === 'host' || runner.role === 'prompter');
      if (!b || b.state === 'merged' || !runner || runner.leftAt || !writes || !canSee(s, x.by, b.id)) return ok({ type: 'schedule.updated', scheduleId: x.id, patch: { status: 'off', stoppedBy: 'server' } });
      // One turn at a time on a branch: it waits for the running one.
      if (activeTurn(s, b.id)) return fail('Busy.', 'busy');
      // It runs where the branch runs now, which may not be where it was set up, and it waits for
      // the OKs a turn sent by hand would (the branch's owner, the Claude Code it runs in).
      const route = routeTurn(s, ctx, b, x.by); if (!routed(route)) return route;
      const oks = oksFor(s, b, x.by, route.runnerId);
      const turn: Turn = {
        id: ctx.id('t'), branchId: b.id, conversationId: b.conversationId, parts: [{ memberId: x.by, text: x.prompt }], senderId: x.by, runnerId: route.runnerId,
        mode: 'normal', status: oks.length ? 'held' : 'requested', requestedAt: ctx.now, steps: [], text: '', model: b.model.name, private: b.private || undefined, scheduled: x.id,
      };
      const left = x.left !== undefined ? x.left - 1 : undefined;
      const again = x.everyMs !== undefined && (left === undefined || left > 0);
      const out: EventBody[] = [];
      if (b.state === 'parked') out.push({ type: 'branch.updated', branchId: b.id, patch: { state: 'active' } });
      out.push(...route.events, { type: 'turn.requested', turn, consumed: [] }, ...askEvents(ctx, b, turn, oks));
      out.push({ type: 'schedule.updated', scheduleId: x.id, patch: again ? { next: Math.max(x.next + x.everyMs!, ctx.now + SCHEDULE_MIN_MS), lastTurn: turn.id, ...(left !== undefined ? { left } : {}) } : { status: 'off', lastTurn: turn.id, ...(left !== undefined ? { left } : {}) } });
      return ok(...out);
    }
    case 'server.file': {
      // The upload route stored its bytes and says who sent it, where, and from which turn.
      const f = cmd.file as Partial<SharedFile>;
      const str = (v: unknown, n: number) => typeof v === 'string' && v.length > 0 && v.length <= n;
      if (!str(f.id, 64) || !str(f.name, 255) || !str(f.type, 200) || typeof f.size !== 'number' || f.size < 0 || f.size > FILE_MAX_BYTES) return fail('Not a file.');
      if (f.from !== 'upload' && f.from !== 'claude') return fail('Not a file.');
      if (!str(f.by, 64) || !s.members[f.by!] || !str(f.branchId, 64) || !s.branches[f.branchId!]) return fail('Not a file.');
      if (f.turnId !== undefined && (!str(f.turnId, 64) || s.turns[f.turnId!]?.branchId !== f.branchId)) return fail('Not a file.');
      if (s.files?.[f.id!]) return ok();
      const file: SharedFile = { id: f.id!, name: f.name!, type: f.type!, size: f.size, by: f.by as MemberId, at: ctx.now, branchId: f.branchId!, from: f.from, ...(f.turnId ? { turnId: f.turnId } : {}) };
      return ok({ type: 'file.added', file });
    }
    case 'server.steers-taken': {
      const t = s.turns[cmd.turnId];
      if (!t || !(cmd.through > (t.steersTaken ?? 0)) || cmd.through > (t.steers?.length ?? 0)) return ok();
      return ok({ type: 'turn.steers-taken', turnId: t.id, through: cmd.through });
    }
    case 'server.note': {
      const t = s.turns[cmd.turnId];
      if (!t || !isActive(t)) return ok();
      return ok({ type: 'turn.done', turnId: t.id, text: cmd.text });
    }
  }
  return fail('Unknown command.');
}

export { branchDecisions };
