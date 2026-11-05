// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Command, CommandContext } from './commands.ts';
import { decide } from './decide.ts';
import type { EventBody, SpaceEvent } from './events.ts';
import { mainOf } from './helpers.ts';
import { apply, emptyState } from './reduce.ts';
import { COLORS, DEFAULT_POLICY } from './types.ts';
import type { Branch, Member, MemberId, Role, SpaceState, Via, Policy } from './types.ts';

export interface Applied {
  state: SpaceState;
  events: SpaceEvent[];
}

/** Stamps bodies with seq/at/actor and folds them in. */
export function commit(s: SpaceState, bodies: EventBody[], actor: MemberId | 'server', now: number): Applied {
  const events: SpaceEvent[] = [];
  let state = s;
  for (const b of bodies) {
    const e = { ...b, seq: state.seq + 1, at: now, actor } as SpaceEvent;
    state = apply(state, e);
    events.push(e);
  }
  return { state, events };
}

export type RunResult = ({ ok: true } & Applied) | { ok: false; error: string; code?: string };

/** decide + commit. */
export function run(s: SpaceState, ctx: CommandContext, cmd: Command): RunResult {
  const d = decide(s, ctx, cmd);
  if (!d.ok) return d;
  return { ok: true, ...commit(s, d.events, ctx.actor, ctx.now) };
}

export interface NewSpace {
  spaceId: string;
  name: string;
  code: string;
  host: { id: MemberId; name: string; via: Via };
  firstConversationTitle?: string;
  policy?: Partial<Policy>;
  model?: string;
  now: number;
  id: (prefix: string) => string;
}

/** The first events of every space: it exists, its host is in it, and there's a conversation to write in. */
export function genesis(o: NewSpace): Applied {
  const host: Member = { id: o.host.id, name: o.host.name, color: COLORS[0], role: 'host', via: o.host.via, joinedAt: o.now, notify: 'needed' };
  const conversationId = o.id('c');
  const mainId = o.id('b');
  const main: Branch = {
    id: mainId, conversationId, name: 'Main', ownerId: null, parentId: null, forkTurnId: null, private: false, state: 'active',
    model: { name: o.model || 'opus', effort: 'auto', setBy: host.id, at: o.now }, createdAt: o.now,
  };
  const bodies: EventBody[] = [
    { type: 'space.created', space: { id: o.spaceId, name: o.name, code: o.code, hostId: host.id, policy: { ...DEFAULT_POLICY, ...o.policy }, createdAt: o.now }, host },
    { type: 'conversation.created', conversation: { id: conversationId, title: o.firstConversationTitle || o.name, createdBy: host.id, createdAt: o.now, mainBranchId: mainId, carried: [], filesFromMain: true }, main },
    { type: 'timeline.event', branchId: mainId, item: { kind: 'event', id: o.id('ev'), icon: 'spark', actor: host.id, text: `${host.name} started the space`, at: o.now } },
  ];
  return commit(emptyState(), bodies, host.id, o.now);
}

export interface Joining {
  id: MemberId;
  name: string;
  via: Via;
  role?: Role;
  now: number;
  eventId: string;
}

/** A new member: the next free color, prompter unless asked otherwise. */
export function join(s: SpaceState, j: Joining): Applied | { error: string } {
  if (s.space.endedAt) return { error: 'This space has ended.' };
  const live = Object.values(s.members).filter((m) => !m.leftAt);
  if (live.length >= 6) return { error: 'This space is full: six people at most.' };
  const name = j.name.trim().slice(0, 40) || 'Guest';
  const used = new Set(live.map((m) => m.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[live.length % COLORS.length];
  const member: Member = { id: j.id, name, color, role: j.role === 'viewer' ? 'viewer' : 'prompter', via: j.via, joinedAt: j.now, notify: 'needed' };
  const main = s.conversationOrder[0] ? mainOf(s, s.conversationOrder[0]) : undefined;
  const bodies: EventBody[] = [{ type: 'member.joined', member }];
  const how = j.via === 'claude-ai' ? ' from claude.ai' : member.role === 'viewer' ? ' to watch' : '';
  if (main) bodies.push({ type: 'timeline.event', branchId: main.id, item: { kind: 'event', id: j.eventId, icon: 'join', actor: j.id, text: `${name} joined${how}`, at: j.now } });
  return commit(s, bodies, j.id, j.now);
}
