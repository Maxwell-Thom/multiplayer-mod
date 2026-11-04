// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { SpaceEvent } from './events.ts';
import type { SpaceState, Turn, TimelineItem } from './types.ts';

/** The state before any event: only valid once `space.created` is applied. */
export function emptyState(): SpaceState {
  return {
    seq: 0,
    space: null as unknown as SpaceState['space'],
    members: {},
    conversations: {},
    conversationOrder: [],
    branches: {},
    parts: {},
    turns: {},
    timeline: {},
    decisions: [],
    questions: [],
    chat: [],
    merges: {},
    asks: {},
    handoffs: {},
    leases: {},
    notes: {},
    pushes: [],
    seen: {},
    sharing: {},
    files: {},
    schedules: {},
  };
}

export function fromEvents(events: SpaceEvent[]): SpaceState {
  let s = emptyState();
  for (const e of events) s = apply(s, e);
  return s;
}

function patchTurn(s: SpaceState, id: string, patch: Partial<Turn>): SpaceState {
  const t = s.turns[id];
  if (!t) return s;
  return { ...s, turns: { ...s.turns, [id]: { ...t, ...patch } } };
}

function pushTimeline(s: SpaceState, branchId: string, item: TimelineItem): SpaceState {
  const list = s.timeline[branchId] || [];
  return { ...s, timeline: { ...s.timeline, [branchId]: [...list, item] } };
}

function releaseLease(s: SpaceState, turnId: string): SpaceState {
  const t = s.turns[turnId];
  if (!t) return s;
  const l = s.leases[t.branchId];
  if (!l || l.turnId !== turnId) return s;
  const leases = { ...s.leases };
  delete leases[t.branchId];
  return { ...s, leases };
}

/** Folds one event into the state. Pure: returns a new state, sharing what didn't change. */
export function apply(prev: SpaceState, e: SpaceEvent): SpaceState {
  let s: SpaceState = { ...prev, seq: e.seq };
  switch (e.type) {
    case 'space.created':
      s.space = e.space;
      s.members = { [e.host.id]: e.host };
      return s;
    case 'member.joined':
      s.members = { ...s.members, [e.member.id]: e.member };
      return s;
    case 'schedule.created':
      s.schedules = { ...(s.schedules ?? {}), [e.schedule.id]: e.schedule };
      return s;
    case 'schedule.updated': {
      const x = s.schedules?.[e.scheduleId];
      if (x) s.schedules = { ...s.schedules, [x.id]: { ...x, ...e.patch } };
      return s;
    }
    case 'file.added': {
      s.files = { ...(s.files ?? {}), [e.file.id]: e.file };
      const t = e.file.turnId ? s.turns[e.file.turnId] : undefined;
      if (t && e.file.from === 'claude') return patchTurn(s, t.id, { files: [...(t.files ?? []), e.file.id] });
      return s;
    }
    case 'sharing.changed': {
      const mine = { ...(s.sharing?.[e.memberId] ?? {}) };
      if (e.source === '*') for (const k of Object.keys(mine)) delete mine[k];
      else if (e.on) mine[e.source] = { name: e.name, at: e.at };
      else delete mine[e.source];
      s.sharing = { ...(s.sharing ?? {}), [e.memberId]: mine };
      return s;
    }
    case 'member.updated': {
      const m = s.members[e.memberId];
      if (m) s.members = { ...s.members, [e.memberId]: { ...m, ...e.patch } };
      return s;
    }
    case 'member.left': {
      const m = s.members[e.memberId];
      if (m) s.members = { ...s.members, [e.memberId]: { ...m, leftAt: e.at } };
      // Leaving ends whatever they shared here.
      if (s.sharing?.[e.memberId]) { const { [e.memberId]: _gone, ...rest } = s.sharing; s.sharing = rest; }
      return s;
    }
    case 'space.policy':
      s.space = { ...s.space, policy: e.policy };
      return s;
    case 'space.host': {
      s.space = { ...s.space, hostId: e.hostId };
      const members = { ...s.members };
      for (const id of Object.keys(members)) {
        const m = members[id];
        if (id === e.hostId) members[id] = { ...m, role: 'host' };
        else if (m.role === 'host') members[id] = { ...m, role: 'prompter' };
      }
      s.members = members;
      return s;
    }
    case 'space.ended':
      s.space = { ...s.space, endedAt: e.at, endedBy: e.actor === 'server' ? undefined : e.actor };
      return s;
    case 'conversation.created':
      s.conversations = { ...s.conversations, [e.conversation.id]: e.conversation };
      s.conversationOrder = [e.conversation.id, ...s.conversationOrder];
      s.branches = { ...s.branches, [e.main.id]: e.main };
      s.timeline = { ...s.timeline, [e.main.id]: [] };
      s.parts = { ...s.parts, [e.main.id]: [] };
      return s;
    case 'conversation.renamed': {
      const c = s.conversations[e.conversationId];
      if (c) s.conversations = { ...s.conversations, [c.id]: { ...c, title: e.title } };
      return s;
    }
    case 'branch.created':
      s.branches = { ...s.branches, [e.branch.id]: e.branch };
      s.timeline = { ...s.timeline, [e.branch.id]: [] };
      s.parts = { ...s.parts, [e.branch.id]: [] };
      return s;
    case 'branch.updated': {
      const b = s.branches[e.branchId];
      if (b) s.branches = { ...s.branches, [b.id]: { ...b, ...e.patch } };
      return s;
    }
    case 'branch.model': {
      const b = s.branches[e.branchId];
      if (b) s.branches = { ...s.branches, [b.id]: { ...b, model: e.model } };
      return s;
    }
    case 'part.added':
      s.parts = { ...s.parts, [e.part.branchId]: [...(s.parts[e.part.branchId] || []), e.part] };
      return s;
    case 'part.removed':
      s.parts = { ...s.parts, [e.branchId]: (s.parts[e.branchId] || []).filter((p) => p.id !== e.partId) };
      return s;
    case 'turn.imported':
      s.turns = { ...s.turns, [e.turn.id]: e.turn };
      return pushTimeline(s, e.turn.branchId, { kind: 'turn', id: e.turn.id });
    case 'turn.requested': {
      const t = e.turn;
      s.turns = { ...s.turns, [t.id]: t };
      if (e.consumed.length) {
        const gone = new Set(e.consumed);
        s.parts = { ...s.parts, [t.branchId]: (s.parts[t.branchId] || []).filter((p) => !gone.has(p.id)) };
      }
      return pushTimeline(s, t.branchId, { kind: 'turn', id: t.id });
    }
    case 'turn.released':
      return patchTurn(s, e.turnId, { status: 'requested' });
    case 'turn.conflict':
      return patchTurn(s, e.turnId, { status: 'conflict', conflict: e.conflict });
    case 'turn.resolved':
      return patchTurn(s, e.turnId, { status: 'requested', parts: e.parts, mode: e.mode, conflict: undefined, checked: true });
    case 'turn.cancelled': {
      const t = s.turns[e.turnId];
      if (!t) return s;
      const turns = { ...s.turns };
      delete turns[e.turnId];
      s.turns = turns;
      s.timeline = { ...s.timeline, [t.branchId]: (s.timeline[t.branchId] || []).filter((i) => !(i.kind === 'turn' && i.id === e.turnId)) };
      s.parts = { ...s.parts, [t.branchId]: [...e.restore, ...(s.parts[t.branchId] || [])] };
      return releaseLease(s, e.turnId);
    }
    case 'turn.started': {
      const t = s.turns[e.turnId];
      if (!t) return s;
      s = patchTurn(s, e.turnId, { status: 'running', runnerId: e.runnerId, startedAt: e.at, model: e.model ?? t.model, pausedAt: undefined });
      if (t.mode !== 'recap' && t.mode !== 'aside') s.leases = { ...s.leases, [t.branchId]: { branchId: t.branchId, holderId: e.runnerId, turnId: t.id, heartbeatAt: e.at } };
      return s;
    }
    case 'turn.step': {
      const t = s.turns[e.turnId];
      if (!t) return s;
      const steps = t.steps.slice();
      const at = steps.findIndex((x) => x.i === e.step.i);
      if (at === -1) steps.push(e.step); else steps[at] = e.step;
      return patchTurn(s, e.turnId, { steps });
    }
    case 'turn.approval': {
      const t = s.turns[e.turnId];
      if (!t || (t.status !== 'running' && t.status !== 'approval')) return s;
      return patchTurn(s, e.turnId, { status: e.waiting ? 'approval' : 'running', askingToShare: e.waiting && e.sharing ? true : undefined });
    }
    case 'turn.paused':
      return patchTurn(s, e.turnId, { status: 'paused', pausedAt: e.at });
    case 'turn.resumed':
      return patchTurn(s, e.turnId, { status: 'running', pausedAt: undefined });
    case 'turn.takeover': {
      const t = s.turns[e.turnId];
      if (!t) return s;
      s = patchTurn(s, e.turnId, { status: 'requested', takenFrom: t.runnerId, runnerId: e.runnerId, steps: [], text: '', pausedAt: undefined, startedAt: undefined });
      return releaseLease(s, e.turnId);
    }
    case 'turn.text':
      return patchTurn(s, e.turnId, { text: e.text });
    case 'turn.done':
      s = patchTurn(s, e.turnId, { status: 'done', text: e.text, usage: e.usage, model: e.model ?? s.turns[e.turnId]?.model, replies: e.replies, endedAt: e.at, ...(e.thinking ? { thinking: e.thinking } : {}) });
      return releaseLease(s, e.turnId);
    case 'turn.failed': {
      const declined = e.failure.reason === 'limit' || e.failure.reason === 'model-unavailable' || e.failure.reason === 'not-connected' || e.failure.reason === 'not-signed-in';
      const t = s.turns[e.turnId];
      const notStarted = !!t && !t.startedAt;
      s = patchTurn(s, e.turnId, { status: declined && notStarted ? 'declined' : 'failed', failure: e.failure, endedAt: e.at });
      return releaseLease(s, e.turnId);
    }
    case 'turn.stopped':
      s = patchTurn(s, e.turnId, { status: 'stopped', stoppedBy: e.by, endedAt: e.at });
      return releaseLease(s, e.turnId);
    case 'turn.work':
      return patchTurn(s, e.turnId, { work: e.work });
    case 'handoff.offered':
      s.handoffs = { ...s.handoffs, [e.handoff.id]: e.handoff };
      return s;
    case 'handoff.updated': {
      const h = s.handoffs[e.handoffId];
      if (h) s.handoffs = { ...s.handoffs, [h.id]: { ...h, status: e.status } };
      return s;
    }
    case 'ask.created':
      s.asks = { ...s.asks, [e.ask.id]: e.ask };
      return s;
    case 'ask.answered': {
      const a = s.asks[e.askId];
      if (a) s.asks = { ...s.asks, [a.id]: { ...a, status: e.allow ? 'allowed' : 'declined' } };
      return s;
    }
    case 'decision.proposed':
      s.decisions = [...s.decisions, { ...e.decision, branchId: e.branchId === undefined ? e.decision.branchId : e.decision.branchId }];
      return s;
    case 'decision.approved':
      s.decisions = s.decisions.map((d) => d.id !== e.decisionId ? d : {
        ...d,
        approvedBy: d.approvedBy.includes(e.memberId) ? d.approvedBy : [...d.approvedBy, e.memberId],
        status: d.status === 'proposed' ? 'approved' : d.status,
      });
      return s;
    case 'decision.dissent':
      s.decisions = s.decisions.map((d) => d.id !== e.decisionId ? d : { ...d, dissent: [...d.dissent.filter((x) => x.memberId !== e.memberId), { memberId: e.memberId, text: e.text, at: e.at }] });
      return s;
    case 'decision.updated':
      s.decisions = s.decisions.map((d) => d.id !== e.decisionId ? d : {
        ...d,
        status: e.status ?? d.status,
        notes: e.note ? [...d.notes, e.note] : d.notes,
        branchId: e.branchId === undefined ? d.branchId : e.branchId,
      });
      return s;
    case 'question.added':
      s.questions = [...s.questions, e.question];
      return s;
    case 'question.updated':
      s.questions = s.questions.map((q) => q.id !== e.questionId ? q : {
        ...q,
        resolvedAt: e.resolved === undefined ? q.resolvedAt : (e.resolved ? e.at : undefined),
        branchId: e.branchId === undefined ? q.branchId : e.branchId,
      });
      return s;
    case 'chat.message':
      s.chat = [...s.chat, e.message];
      return s;
    case 'merge.requested':
      s.merges = { ...s.merges, [e.merge.id]: e.merge };
      return s;
    case 'merge.done': {
      const m = s.merges[e.mergeId];
      if (m) s.merges = { ...s.merges, [m.id]: { ...m, status: 'done', choice: e.choice, picks: e.picks, doneBy: e.actor === 'server' ? undefined : e.actor, doneAt: e.at, noteTurnId: e.noteTurnId } };
      return s;
    }
    case 'merge.cancelled': {
      const m = s.merges[e.mergeId];
      if (m) s.merges = { ...s.merges, [m.id]: { ...m, status: 'cancelled' } };
      return s;
    }
    case 'note.shared':
      s.notes = { ...s.notes, [e.note.id]: e.note };
      return pushTimeline(s, e.note.branchId, { kind: 'note', id: e.note.id });
    case 'files.pushed':
      s.pushes = [...s.pushes, e.push];
      return s;
    case 'timeline.event':
      return pushTimeline(s, e.branchId, e.item);
    case 'seen':
      s.seen = { ...s.seen, [e.memberId]: Math.max(s.seen[e.memberId] || 0, e.seq) };
      return s;
  }
  return s;
}
