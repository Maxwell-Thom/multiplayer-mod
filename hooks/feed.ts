// What a Claude Code's transcript shows of each shared turn (the Multiplayer mirror): the feed one
// placed row draws. Pure: the space's state (already redacted for this person), the turn, and what
// only this runner knows (its own turn's live text, its pending approval, others' live text).
import type { MultiplayerFeed, MultiplayerFeedStep } from '../types'
import { isMain, memberName, modelLabel, openAsks } from './lib/helpers.ts'
import type { MemberId, SpaceState, Turn } from './lib/types.ts'

/** How many of a turn's steps its row shows: the latest. */
export const FEED_STEPS = 12

/** A turn's row id, for `$.ui.place` (letters, digits, _ and - only). */
export const feedRowId = (turnId: string) => `turn-${turnId}`

/** Which turns get a row: every one this person can see (the state holds no other), recaps and side questions included. */
export function feedTurns(s: SpaceState, since: number): Turn[] {
  return Object.values(s.turns).filter((t) => t.requestedAt >= since).sort((a, b) => a.requestedAt - b.requestedAt)
}

/** What people wrote, as this terminal may draw it: no control characters or escapes; `block` keeps newlines and tabs. */
// eslint-disable-next-line no-control-regex
// (Bidi controls and invisible format characters too: they can reorder or hide what a row shows.)
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
export const block = (s: string) => s.replace(CTRL, '')
export const one = (s: string) => block(s).replace(/[\n\t]+/g, ' ')

const secs = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)

/**
 * One turn's row: who wrote what, its steps (the latest, drawn like Claude Code's own), the answer
 * so far, what people added while Claude worked, an approval waiting here, and one closing line.
 */
export function feedOf(s: SpaceState, t: Turn, me: MemberId, o: { now: number; live?: string; approval?: MultiplayerFeed['approval'] }): MultiplayerFeed {
  const who = (m: MemberId) => (m === me ? 'You' : one(memberName(s, m)))
  const b = s.branches[t.branchId]
  const conv = b ? s.conversations[b.conversationId]?.title ?? 'A conversation' : 'A conversation'
  const where = one(b && !isMain(s, b.id) ? `${conv} · ${b.private ? 'your private lane' : b.name}` : conv)
  const runner = t.runnerId === me ? 'your Claude Code' : `${one(memberName(s, t.runnerId))}’s Claude Code`
  const held = t.parts.filter((p) => p.position).length
  const parts = t.parts.filter((p) => !p.position).map((p) => ({ who: who(p.memberId), text: block(p.text) }))
  if (held) parts.push({ who: 'Opinions', text: `${held} held back until Claude answers` })
  const all = t.steps ?? []
  const steps: MultiplayerFeedStep[] = all.slice(-FEED_STEPS).map((st) => ({ tool: one(st.tool), text: one(st.text), state: st.state, under: st.under !== undefined }))
  const taken = t.steersTaken ?? 0
  const active = ['requested', 'held', 'conflict', 'running', 'approval', 'paused'].includes(t.status)
  const queued = (t.steers ?? []).filter((x) => !x.withdrawn && !x.carried).map((x) => ({ who: who(x.by), text: block(x.text), state: x.n > taken && active ? 'queued' as const : 'read' as const }))
  const ask = t.status === 'held' ? openAsks(s, t.id)[0] : undefined
  let status: MultiplayerFeed['status']
  let line: string
  switch (t.status) {
    case 'requested': status = 'waiting'; line = `Waiting to start in ${runner}`; break
    case 'held': case 'conflict':
      status = 'held'
      line = !ask ? 'Waiting to be settled'
        : ask.kind === 'project' ? (ask.to === me ? 'Waiting for you: your Claude Code is open in another project · /multiplayer allow or deny' : `Waiting for ${memberName(s, ask.to)}: their Claude Code is open in another project`)
        : ask.kind === 'run-here' ? (ask.to === me ? `Waiting for you to let ${memberName(s, ask.from)} send here · /multiplayer allow or deny` : `Waiting for ${memberName(s, ask.to)} to say yes`)
        : `Waiting for ${ask.to === me ? 'you' : memberName(s, ask.to)} to OK it`
      break
    case 'paused': status = 'paused'; line = `Paused in ${runner}`; break
    case 'approval': status = 'approval'; line = o.approval ? 'Waiting for you to answer' : `Waiting for ${t.runnerId === me ? 'you' : memberName(s, t.runnerId)} to answer`; break
    case 'running': status = 'running'; line = `Running in ${runner}${t.startedAt ? ` · ${secs(o.now - t.startedAt)}` : ''}`; break
    case 'done': status = 'done'; line = [`Ran in ${runner}`, t.startedAt && t.endedAt ? secs(t.endedAt - t.startedAt) : '', t.model ? modelLabel(t.model) : ''].filter(Boolean).join(' · '); break
    case 'stopped': status = 'stopped'; line = `Stopped${t.stoppedBy ? ` by ${who(t.stoppedBy)}` : ''}`; break
    default: status = 'failed'; line = `Didn’t finish: ${t.failure?.detail?.split('\n')[0]?.slice(0, 200) || t.failure?.reason || 'it failed'}`
  }
  if (t.senderId !== t.runnerId && status !== 'held') line += ` · sent by ${who(t.senderId)}`
  return {
    id: t.id,
    where,
    parts,
    runner,
    status,
    line: one(line),
    steps,
    more: Math.max(0, all.length - FEED_STEPS),
    text: block((status === 'running' || status === 'approval') && o.live ? o.live : t.text),
    queued,
    approval: o.approval ? { ...o.approval, title: one(o.approval.title), ...(o.approval.always ? { always: one(o.approval.always) } : {}) } : null,
  }
}
