// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { SpaceEvent } from './events.ts';
import { canSee } from './helpers.ts';
import type { MemberId, SpaceState, Turn } from './types.ts';

/**
 * What each member may see. Private lanes are their owner's alone; private turns
 * (recaps) belong to whoever runs them. Everything else in a space is shared.
 * The server applies this to every snapshot and every event before it leaves.
 */

export function canSeeTurn(s: SpaceState, memberId: MemberId, t: Turn | undefined): boolean {
  if (!t) return false;
  if (!canSee(s, memberId, t.branchId)) return false;
  if (t.private && t.runnerId !== memberId && t.senderId !== memberId) {
    const b = s.branches[t.branchId];
    return !!b && b.private && b.ownerId === memberId;
  }
  return true;
}

export function redactState(s: SpaceState, memberId: MemberId): SpaceState {
  const hiddenBranches = new Set(Object.values(s.branches).filter((b) => !canSee(s, memberId, b.id)).map((b) => b.id));
  const hiddenTurns = new Set(Object.values(s.turns).filter((t) => !canSeeTurn(s, memberId, t)).map((t) => t.id));
  if (!hiddenBranches.size && !hiddenTurns.size) return s;

  const omit = <T>(rec: Record<string, T>, hidden: Set<string>) =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => !hidden.has(k)));

  const timeline: SpaceState['timeline'] = {};
  for (const [bid, items] of Object.entries(s.timeline)) {
    if (hiddenBranches.has(bid)) continue;
    timeline[bid] = items.filter((i) => !(i.kind === 'turn' && hiddenTurns.has(i.id)));
  }
  return {
    ...s,
    branches: omit(s.branches, hiddenBranches),
    parts: omit(s.parts, hiddenBranches),
    leases: Object.fromEntries(Object.entries(s.leases).filter(([bid, l]) => !hiddenBranches.has(bid) && !hiddenTurns.has(l.turnId))),
    turns: omit(s.turns, hiddenTurns),
    timeline,
    decisions: s.decisions.filter((d) => !d.branchId || !hiddenBranches.has(d.branchId)),
    questions: s.questions.filter((q) => !q.branchId || !hiddenBranches.has(q.branchId)),
    asks: Object.fromEntries(Object.entries(s.asks).filter(([, a]) => !hiddenBranches.has(a.branchId))),
    handoffs: Object.fromEntries(Object.entries(s.handoffs).filter(([, h]) => !hiddenBranches.has(h.branchId))),
    merges: Object.fromEntries(Object.entries(s.merges).filter(([, m]) => !hiddenBranches.has(m.fromBranchId))),
    pushes: s.pushes.filter((p) => !p.branchId || !hiddenBranches.has(p.branchId)),
    notes: Object.fromEntries(Object.entries(s.notes).filter(([, n]) => !hiddenBranches.has(n.branchId))),
  };
}

/**
 * Who may receive an event, judged once when it is committed (against the state
 * just before and just after it). Null: everyone in the space. Otherwise the
 * member ids allowed. Stored with the event so later reads need no state.
 */
export function eventAudience(before: SpaceState, after: SpaceState, e: SpaceEvent): MemberId[] | null {
  const branchAudience = (id: string | undefined | null): MemberId[] | null => {
    if (!id) return null;
    const b = after.branches[id] ?? before.branches[id];
    if (!b || !b.private) return null;
    return b.ownerId ? [b.ownerId] : [];
  };
  const turnAudience = (id: string): MemberId[] | null => {
    const t = after.turns[id] ?? before.turns[id];
    if (!t) return null;
    const byBranch = branchAudience(t.branchId);
    if (byBranch) return byBranch;
    if (t.private) return [...new Set([t.runnerId, t.senderId])];
    return null;
  };
  switch (e.type) {
    case 'branch.created': return branchAudience(e.branch.id);
    case 'branch.updated':
    case 'branch.model': return branchAudience(e.branchId);
    case 'part.added': return branchAudience(e.part.branchId);
    case 'part.removed': return branchAudience(e.branchId);
    case 'turn.imported':
    case 'turn.requested': {
      const byBranch = branchAudience(e.turn.branchId);
      if (byBranch) return byBranch;
      return e.turn.private ? [...new Set([e.turn.runnerId, e.turn.senderId])] : null;
    }
    case 'turn.released':
    case 'turn.conflict':
    case 'turn.resolved':
    case 'turn.cancelled':
    case 'turn.started':
    case 'turn.step':
    case 'turn.approval':
    case 'turn.paused':
    case 'turn.resumed':
    case 'turn.takeover':
    case 'turn.text':
    case 'turn.done':
    case 'turn.failed':
    case 'turn.stopped':
      return turnAudience(e.turnId);
    case 'handoff.offered': return branchAudience(e.handoff.branchId);
    case 'handoff.updated': return branchAudience((after.handoffs[e.handoffId] ?? before.handoffs[e.handoffId])?.branchId);
    case 'ask.created': return branchAudience(e.ask.branchId);
    case 'ask.answered': return branchAudience((after.asks[e.askId] ?? before.asks[e.askId])?.branchId);
    case 'decision.proposed': return branchAudience(e.decision.branchId);
    case 'question.added': return branchAudience(e.question.branchId);
    case 'decision.approved':
    case 'decision.dissent':
    case 'decision.updated':
      return branchAudience(before.decisions.find((x) => x.id === e.decisionId)?.branchId);
    case 'question.updated':
      return branchAudience(before.questions.find((x) => x.id === e.questionId)?.branchId);
    case 'merge.requested': return branchAudience(e.merge.fromBranchId);
    case 'timeline.event': return branchAudience(e.branchId);
    case 'files.pushed': return branchAudience(e.push.branchId);
    case 'note.shared': return branchAudience(e.note.branchId);
    default:
      return null;
  }
}

export function audienceIncludes(audience: MemberId[] | null | undefined, memberId: MemberId): boolean {
  return !audience || audience.includes(memberId);
}
