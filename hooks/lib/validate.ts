// Copied from packages/protocol/src by packages/mod/scripts/sync-protocol.mjs. Do not edit here.
import type { Command } from './commands.ts';
import { isModelName, isSite } from './helpers.ts';
import { TRANSFER_MAX_BYTES, WORK_COMMITS_MAX, WORK_FILES_MAX } from './types.ts';

/**
 * Shape checks for commands arriving from the network, before `decide` reads
 * them. `decide` assumes well-typed fields; this makes that true.
 *
 * Field specs: 'id' (a short string that isn't an Object.prototype key),
 * 'str:N' (string up to N chars), 'bool', 'num', 'enum:a|b', '?' suffix for optional,
 * 'obj' (plain object; checked further in decide), 'any'.
 */

type Spec = Record<string, string>;

const TEXT = 'str:20000';

/** What one branch.import may hold: turns per command, characters per prompt and answer, steps per turn. */
export const IMPORT_CHUNK = 200;
export const IMPORT_PROMPT = 100_000;
export const IMPORT_TEXT = 200_000;
export const IMPORT_STEPS = 300;
const SPECS: Record<Command['type'], Spec> = {
  'member.rename': { name: 'str:80' },
  'member.notify': { notify: 'enum:needed|all|off' },
  'sharing.set': { source: 'str:200', name: 'str:100', on: 'bool' },
  'member.role': { memberId: 'id', role: 'enum:host|prompter|viewer' },
  'member.leave': { handTo: 'id?', end: 'bool?' },
  'member.remove': { memberId: 'id' },
  'member.limit-clear': {},
  'space.policy': { policy: 'obj' },
  'space.end': {},
  'conversation.create': { title: 'str:120?', carry: 'bool', filesFromMain: 'bool', model: 'str:100?' },
  'conversation.rename': { conversationId: 'id', title: 'str:120' },
  'branch.fork': { fromBranchId: 'id', atTurnId: 'id?', private: 'bool?', name: 'str:80?', editOf: 'id?', editText: `${TEXT}?`, editParts: 'any?', inMine: 'bool?' },
  'branch.state': { branchId: 'id', state: 'enum:parked|active' },
  'branch.rename': { branchId: 'id', name: 'str:80' },
  'branch.model': { branchId: 'id', name: 'str:100', effort: 'enum:low|medium|high' },
  'branch.import': { branchId: 'id', source: 'obj', turns: 'any', model: 'str:100?' },
  'part.add': { branchId: 'id', text: TEXT, position: 'bool?', id: 'id?', cites: 'id?', files: 'any?' },
  'part.remove': { partId: 'id' },
  'turn.send': { branchId: 'id', mode: 'enum:normal|view-first?', handoffId: 'id?', plan: 'bool?', runIn: 'id?' },
  'turn.resolve': { turnId: 'id', pick: 'str:80' },
  'turn.stop': { turnId: 'id' },
  'turn.takeover': { turnId: 'id' },
  'turn.retry': { turnId: 'id' },
  'turn.reveal': { turnId: 'id' },
  'handoff.offer': { branchId: 'id', to: 'id' },
  'handoff.cancel': { handoffId: 'id' },
  'ask.answer': { askId: 'id', allow: 'bool', always: 'bool?' },
  'work.resend': { branchId: 'id' },
  'files.get': { turnId: 'id' },
  'files.got': { transferId: 'id', ok: 'bool' },
  'run.allow': { conversationId: 'id', memberId: 'id', on: 'bool' },
  'decision.propose': { branchId: 'id', text: 'str:2000', replaces: 'id?' },
  'decision.approve': { decisionId: 'id' },
  'decision.dissent': { decisionId: 'id', text: 'str:2000' },
  'question.add': { branchId: 'id', text: 'str:2000' },
  'question.resolve': { questionId: 'id' },
  'chat.send': { text: 'str:4000' },
  'merge.request': { fromBranchId: 'id' },
  'merge.complete': { mergeId: 'id', choice: 'enum:keep|replace|open', picks: 'obj' },
  'merge.cancel': { mergeId: 'id' },
  'aside.ask': { branchId: 'id', text: TEXT },
  'aside.share': { turnId: 'id' },
  'share.post': { fromBranchId: 'id?', toBranchId: 'id?', text: TEXT, question: 'str:2000?' },
  'recap.request': { conversationId: 'id', text: 'str:4000' },
  seen: { seq: 'num' },
  'runner.check': { turnId: 'id', conflict: 'obj' },
  'runner.start': { turnId: 'id', model: 'str:100?' },
  'runner.step': { turnId: 'id', step: 'obj' },
  'runner.approval': { turnId: 'id', waiting: 'bool', sharing: 'bool?' },
  'runner.text': { turnId: 'id', text: 'str:200000' },
  'runner.done': { turnId: 'id', text: 'str:200000', usage: 'obj?', model: 'str:100?', replies: 'any?', thinking: 'str:100000?' },
  'runner.fail': { turnId: 'id', failure: 'obj' },
  'runner.decision': { turnId: 'id', text: 'str:2000', replaces: 'id?' },
  'runner.question': { turnId: 'id', text: 'str:2000' },
  'runner.pushed': { push: 'obj' },
  'runner.work': { turnId: 'id', work: 'obj', repo: 'str:16?' },
  'runner.transfer': { transferId: 'id', status: 'enum:ready|done|failed', summary: 'str:200?', manifest: 'obj?' },
  'runner.arrived': { branchId: 'id', pulled: 'num', note: 'str:200?' },
  'work.move': { branchId: 'id' },
  'work.offer': { branchId: 'id', to: 'id' },
  'work.send': { branchId: 'id' },
  'server.transfer-timeout': { transferId: 'id' },
  'server.pause': { turnId: 'id' },
  'server.resume': { turnId: 'id' },
  'server.note': { turnId: 'id', text: 'str:200000' },
  'server.file': { file: 'obj' },
  'server.schedule-fire': { scheduleId: 'id' },
  'runner.schedule': { turnId: 'id', prompt: 'str:4000', inMs: 'num?', everyMs: 'num?', times: 'num?' },
  'schedule.stop': { scheduleId: 'id' },
};

/** A string usable as a record key: short, and not something every object already has. */
export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 80 && !(v in Object.prototype);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

function checkField(v: unknown, spec: string): boolean {
  const optional = spec.endsWith('?');
  const s = optional ? spec.slice(0, -1) : spec;
  if (v === undefined || (optional && v === null)) return optional;
  if (s === 'id') return isId(v);
  if (s === 'bool') return typeof v === 'boolean';
  if (s === 'num') return typeof v === 'number' && Number.isFinite(v);
  if (s === 'obj') return isObj(v);
  if (s === 'any') return true;
  if (s.startsWith('str:')) return typeof v === 'string' && v.length <= Number(s.slice(4));
  if (s.startsWith('enum:')) return typeof v === 'string' && s.slice(5).split('|').includes(v);
  return false;
}

/** Null when the command is well formed; otherwise a short reason. */
export function invalid(cmd: unknown): string | null {
  if (!isObj(cmd) || typeof cmd.type !== 'string') return 'Send a command.';
  const spec = (SPECS as Record<string, Spec | undefined>)[cmd.type];
  if (!spec || !Object.hasOwn(SPECS, cmd.type)) return 'Unknown command.';
  for (const [k, s] of Object.entries(spec)) if (!checkField(cmd[k], s)) return `Bad or missing “${k}”.`;
  // Nested shapes decide relies on.
  const c = cmd as Record<string, unknown>;
  if (cmd.type === 'runner.step') {
    const st = c.step as Record<string, unknown>;
    if (typeof st.i !== 'number' || typeof st.tool !== 'string' || typeof st.text !== 'string' || !['run', 'done', 'fail', 'wait', 'denied'].includes(st.state as string)) return 'Bad step.';
    if (st.tool.length > 100 || st.text.length > 2000 || (st.detail !== undefined && (typeof st.detail !== 'string' || st.detail.length > 20000))) return 'Step too long.';
    if (st.under !== undefined && (typeof st.under !== 'number' || !Number.isInteger(st.under) || st.under < 0 || st.under >= st.i)) return 'Bad step.';
  }
  if (cmd.type === 'runner.fail') {
    const f = c.failure as Record<string, unknown>;
    if (!['error', 'limit', 'refusal', 'model-unavailable', 'runner-offline', 'not-connected', 'not-signed-in'].includes(f.reason as string)) return 'Bad failure.';
    if (f.detail !== undefined && (typeof f.detail !== 'string' || f.detail.length > 2000)) return 'Bad failure.';
    if (f.resetsAt !== undefined && typeof f.resetsAt !== 'number') return 'Bad failure.';
  }
  if (cmd.type === 'branch.fork' && c.editParts !== undefined && (!Array.isArray(c.editParts) || c.editParts.length > 50
    || !c.editParts.every((p) => isObj(p) && isId(p.memberId) && typeof p.text === 'string' && p.text.length <= 20000))) return 'Bad edit.';
  if (cmd.type === 'runner.done' && c.replies !== undefined && (!Array.isArray(c.replies) || c.replies.length > 50 || c.replies.some((r) => typeof r !== 'string' || r.length > 4000))) return 'Bad replies.';
  if (cmd.type === 'runner.check') {
    const k = c.conflict as Record<string, unknown>;
    if (typeof k.summary !== 'string' || k.summary.length > 2000 || !Array.isArray(k.conflicting) || !k.conflicting.every((n) => Number.isInteger(n)) || !Array.isArray(k.options) || k.options.length > 10
      || !k.options.every((o) => isObj(o) && typeof o.key === 'string' && o.key.length <= 80 && typeof o.label === 'string' && o.label.length <= 200 && (o.memberId === undefined || isId(o.memberId)))) return 'Bad conflict.';
  }
  if (cmd.type === 'runner.pushed') {
    const p = c.push as Record<string, unknown>;
    if (typeof p.branch !== 'string' || p.branch.length > 200 || typeof p.summary !== 'string' || p.summary.length > 4000 || (p.branchId !== undefined && !isId(p.branchId))
      || !Array.isArray(p.commits) || !p.commits.length || p.commits.length > 200
      || !p.commits.every((x) => isObj(x) && typeof x.sha === 'string' && x.sha.length <= 64 && typeof x.subject === 'string' && x.subject.length <= 500)) return 'Bad push.';
  }
  if (cmd.type === 'runner.work') {
    const w = c.work as Record<string, unknown>;
    const known = ['noRepo', 'uncommitted', 'more', 'commits', 'pushed'];
    if (Object.keys(w).some((k) => !known.includes(k))) return 'Bad work.';
    if (w.noRepo !== undefined && typeof w.noRepo !== 'boolean') return 'Bad work.';
    // These reach other people's Claude: no control characters (a newline could pass for a note of the space's own).
    const line = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v);
    if (w.uncommitted !== undefined && (!Array.isArray(w.uncommitted) || w.uncommitted.length > WORK_FILES_MAX || !w.uncommitted.every((f) => line(f, 300)))) return 'Bad work.';
    if (w.more !== undefined && (typeof w.more !== 'number' || !Number.isInteger(w.more) || w.more < 0 || w.more > 1_000_000)) return 'Bad work.';
    if (w.commits !== undefined && (!Array.isArray(w.commits) || w.commits.length > WORK_COMMITS_MAX
      || !w.commits.every((x) => isObj(x) && typeof x.sha === 'string' && /^[0-9a-f]{7,64}$/.test(x.sha) && typeof x.subject === 'string' && x.subject.length <= 300 && !CONTROL.test(x.subject)))) return 'Bad work.';
    // A git branch name's characters only.
    if (w.pushed !== undefined && (typeof w.pushed !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(w.pushed))) return 'Bad work.';
  }
  if (cmd.type === 'runner.work' && c.repo !== undefined && !/^[0-9a-f]{16}$/.test(c.repo as string)) return 'Bad work.';
  // What a move says reaches everyone's screen: one plain line, and a manifest of exact numbers.
  if ((cmd.type === 'runner.transfer' || cmd.type === 'runner.arrived') && [c.summary, c.note].some((v) => typeof v === 'string' && CONTROL.test(v))) return 'Bad summary.';
  if (cmd.type === 'runner.arrived' && (!Number.isInteger(c.pulled) || (c.pulled as number) < 0 || (c.pulled as number) > 100_000)) return 'Bad count.';
  if (cmd.type === 'runner.transfer' && c.manifest !== undefined) {
    const m = c.manifest as Record<string, unknown>;
    const n = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
    if (Object.keys(m).some((k) => !['size', 'sha256', 'chunks'].includes(k)) || !n(m.size, TRANSFER_MAX_BYTES) || !n(m.chunks, 64) || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'Bad manifest.';
  }
  if (cmd.type === 'merge.complete' && !Object.values(c.picks as object).every((v) => typeof v === 'boolean')) return 'Bad picks.';
  // A pinned model goes to Claude Code's --model on the runner's machine.
  if (cmd.type === 'branch.model' && c.name !== '' && !isModelName(c.name)) return 'Bad model.';
  if (cmd.type === 'branch.import') {
    const src = c.source as Record<string, unknown>;
    if (!['claude-code', 'claude-ai'].includes(src.from as string) || (src.title !== undefined && (typeof src.title !== 'string' || src.title.length > 200))) return 'Bad source.';
    if (c.model !== undefined && c.model !== '' && !isModelName(c.model)) return 'Bad model.';
    if (!Array.isArray(c.turns) || !c.turns.length || c.turns.length > IMPORT_CHUNK) return 'Bad turns.';
    for (const t of c.turns as unknown[]) {
      if (!isObj(t) || typeof t.prompt !== 'string' || t.prompt.length > IMPORT_PROMPT || typeof t.text !== 'string' || t.text.length > IMPORT_TEXT) return 'Bad turn.';
      if (t.model !== undefined && (typeof t.model !== 'string' || t.model.length > 100)) return 'Bad turn.';
      if (t.at !== undefined && (typeof t.at !== 'number' || !Number.isFinite(t.at))) return 'Bad turn.';
      if (t.steps !== undefined && (!Array.isArray(t.steps) || t.steps.length > IMPORT_STEPS
        || !t.steps.every((st) => isObj(st) && typeof st.tool === 'string' && st.tool.length <= 100 && typeof st.text === 'string' && st.text.length <= 2000 && (st.failed === undefined || typeof st.failed === 'boolean')))) return 'Bad steps.';
    }
  }
  if (cmd.type === 'conversation.create' && c.model !== undefined && c.model !== '' && !isModelName(c.model)) return 'Bad model.';
  if (cmd.type === 'space.policy') {
    const p = c.policy as Record<string, unknown>;
    const ok: Record<string, (v: unknown) => boolean> = {
      ownerOk: (v) => typeof v === 'boolean', hostMerges: (v) => typeof v === 'boolean', projectSetup: (v) => typeof v === 'boolean',
      leaseSeconds: (v) => typeof v === 'number' && Number.isFinite(v),
      sites: (v) => Array.isArray(v) && v.length <= 50 && v.every(isSite),
    };
    for (const [k, v] of Object.entries(p)) if (!Object.hasOwn(ok, k) || !ok[k](v)) return `Bad policy “${k}”.`;
  }
  if (cmd.type === 'runner.done' && c.usage !== undefined) {
    const u = c.usage as Record<string, unknown>;
    if (!Object.values(u).every((v) => typeof v === 'number' && Number.isFinite(v))) return 'Bad usage.';
  }
  return null;
}
