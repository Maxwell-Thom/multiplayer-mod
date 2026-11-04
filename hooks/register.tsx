// Multiplayer for Claude Code: this session signs in to a space and runs its person's
// turns of the shared conversation, each in its branch's own Claude Code session (see
// child.ts). The work lives in runner.ts; this file wires it to the engine.
import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { MultiplayerView } from '../types'
import type { Port } from './port.ts'
import { privateSource } from './lib/privacy.ts'
import { EMPTY_VIEW, PANE, Runner } from './runner.ts'

/** JSON with every object's keys in order, so the same input always reads the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/**
 * How long a request to the server may take. The host's fetch has no timeout, and a connection
 * that died without closing (the server's container replaced, a network change) would hold a
 * long poll forever: the runner looks gone, and hears no approval. A long poll gets its own wait
 * and some; anything else, 45 seconds. A timed-out request fails like a dropped one, and the
 * runner reconnects (the same process, so a running turn goes on).
 */
function fetchTimeout(url: string): number {
  const wait = /\/runner\/poll\?.*\bwait=(\d+)/.exec(url)
  return wait ? (Number(wait[1]) + 20) * 1000 : 45_000
}

function withTimeout<T>($: { clock: { after: (ms: number, fn: () => void) => unknown } }, p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    // The timer can be refused once the session is closing: that's no failure of the request.
    Promise.resolve()
      .then(() => $.clock.after(ms, () => { if (!done) { done = true; reject(new Error(`no answer from the server in ${Math.round(ms / 1000)}s`)) } }))
      .catch(() => {})
    p.then((v) => { if (!done) { done = true; resolve(v) } }, (err) => { if (!done) { done = true; reject(err) } })
  })
}

const VIEW = { plugin: 'multiplayer', key: 'view' } as const
const MEMO = { plugin: 'multiplayer', key: 'memo' } as const
const view = atom(VIEW, EMPTY_VIEW)

export const register: Register = (on, options) => {
  const rt = new Runner({
    server: String(options.server || 'https://server-production-491c.up.railway.app'),
    name: String(options.name || ''),
  })
  /** Set in a branch session this mod started for a shared turn: only the privacy filter runs there. */
  let child: 'shared' | 'private' | null = null
  /**
   * Bridged calls this mod is making here for a shared turn that the server says their person
   * allowed in Multiplayer, by tool. Where this session would ask, it doesn't ask again; its own
   * deny rules still hold. Only this mod's own calls (the model's come from the engine).
   */
  const bridging = new Map<string, number>()
  // Exactly the call allowed: the tool and its input (keys in order), never just the tool.
  const callKey = (tool: string, input: unknown) => `${tool}\u0000${canonical(input)}`

  /** Claude Code's own ways of doing things later: they'd end with a turn's session. */
  const BACKGROUND = new Set(['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor', 'RemoteTrigger'])
  /** In a shared turn's session: where to ask what its person shares in this space (docs/PRIVACY.md). */
  let sharedUrl = ''

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    // Background work in a turn's session ends with the turn: the space keeps it instead, so its
    // runs are turns everyone (and every later session) reads.
    if (child && BACKGROUND.has(e.tool)) return { decision: 'deny', reason: `In a Multiplayer turn, this session ends when the turn does, so ${e.tool} would stop with it. Use mcp__multiplayer__schedule instead: each run is a new turn on this branch, everyone sees it and what it finds. (A watch on a command: check it on a schedule.)` }
    // Something from the person's own world that would run without asking (an allow rule, auto
    // mode), in a turn others read: unless they share it here, ask, so the share card comes up.
    if (child === 'shared' && sharedUrl && r.decision === 'allow') {
      const src = privateSource(e.tool, e.input, await $.session.cwd())
      if (src) {
        const res = await $.http.fetch(sharedUrl).catch(() => null)
        let shared: unknown = null
        try { shared = res && res.ok ? (JSON.parse(res.text) as { shared?: unknown }).shared : null } catch { shared = null }
        // Not sure what's shared: ask rather than guess.
        if (!Array.isArray(shared) || !shared.includes(src.id)) return { ...r, decision: 'ask', reason: `Shares ${src.label} with the space.` }
      }
    }
    if (!child && r.decision === 'ask' && next.origin.plugin === $.plugin.name && (bridging.get(callKey(e.tool, e.input)) ?? 0) > 0) {
      return { ...r, decision: 'allow', reason: 'Allowed in Multiplayer by its owner, for their shared turn.' }
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const role = await $.env.get('MULTIPLAYER_CHILD')
    if (role) {
      child = role === 'private' ? 'private' : 'shared'
      sharedUrl = (await $.env.get('MULTIPLAYER_SHARED_URL')) ?? ''
      return started
    }
    // Everything the runner does on the engine, each spelled as a call on `$`.
    const io: Port = {
      fetch: (url, init) => withTimeout($, $.http.fetch(url, init), fetchTimeout(url)),
      status: (text) => $.ui.status(text),
      toast: (text) => $.ui.toast(text, { timeoutMs: 6000 }),
      log: (text, debug) => $.ui.log(text, { to: debug ? 'debug' : 'transcript' }),
      ask: (question, options) => $.ui.ask(question, options),
      storeGet: (key) => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeDelete: (key) => $.store.delete(key),
      getMemo: async () => (await $.state.get(MEMO)).value,
      setMemo: (memo) => $.state.set(MEMO, memo),
      setView: (v) => $.state.set(VIEW, v),
      sleep: (ms) => $.clock.sleep(ms),
      after: (ms, fn) => $.clock.after(ms, fn),
      model: () => $.session.model(),
      version: async () => (await $.session.version()).version,
      cwd: () => $.session.cwd(),
      sessionId: () => $.session.id(),
      usage: () => $.session.usage(),
      sandbox: async () => {
        const s = await $.settings.read({ key: 'sandbox' })
        return !!(s && typeof s === 'object' && (s as { enabled?: unknown }).enabled === true)
      },
      home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
      userName: async () => (await $.env.get('USER')) ?? (await $.env.get('USERNAME')),
      execPath: () => $.env.get('CLAUDE_CODE_EXECPATH'),
      systemRoot: () => $.env.get('SystemRoot'),
      userSettings: () => $.settings.read({ source: 'user' }),
      pluginRoot: $.plugin.root,
      append: async (text) => {
        const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        return { deny: r.deny }
      },
      submit: (text, asUser) => (asUser ? $.prompt.submit({ text, asUser: true }) : $.prompt.submit({ text })),
      complete: (request) => $.model.complete(request),
      registerCommand: (spec) => $.command.register(spec),
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request),
      read: async (path) => {
        const t = await $.fs.read(path)
        if (typeof t !== 'string') throw new Error(`${path} is not text`)
        return t
      },
      write: (path, text) => $.fs.write(path, text),
      realPath: async (path) => (await $.fs.stat(path, { resolve: true })).realPath,
      readBytes: async (path) => {
        const r = await $.fs.read(path, { as: 'bytes' })
        if (typeof r === 'string' || !r || typeof r.base64 !== 'string') throw new Error(`${path} couldn't be read`)
        return r.base64
      },
      list: async (path) => (await $.fs.list(path)).map((x) => ({ name: x.name, kind: x.kind, size: x.size, mtimeMs: x.mtimeMs })),
      configDir: () => $.env.get('CLAUDE_CONFIG_DIR'),
      listTools: async () => (await $.tool.list()).map((t) => ({ name: t.name, description: t.description })),
      callTool: async (tool, input, approved) => {
        const key = callKey(tool, input)
        if (approved) bridging.set(key, (bridging.get(key) ?? 0) + 1)
        try {
          const r = await $.tool.call({ ...input, tool } as never)
          if (r.deny) return { text: r.deny, isError: true }
          return { text: r.text ?? '', ...(r.isError ? { isError: true } : {}) }
        } finally {
          if (approved) {
            const n = (bridging.get(key) ?? 1) - 1
            if (n > 0) bridging.set(key, n); else bridging.delete(key)
          }
        }
      },
    }
    // A `claude -p` run or an SDK host (a script, an automatic review) has nobody at the prompt:
    // it never takes this person's turns over by itself.
    await rt.init(io, started.cwd || e.cwd, e.isInteractive !== false)
    return started
  })

  // The runner belongs to the process. A /clear or a resume goes on under a new session id (with
  // no session.start), and the runner with it. Leaving ends the process, and the sessions of its
  // shared turns: say so, so nobody waits for them.
  on('session.end', async ($, e, next) => {
    if (!child && e.reason !== 'clear' && e.reason !== 'resume') await rt.bye()
    return next(e)
  })

  on('command.run', { command: 'multiplayer' }, async ($, e) => {
    const r = await rt.command(e.args)
    if (r.openPane) await $.ui.open({ id: PANE, title: 'Multiplayer' }).catch(() => undefined)
    return { text: r.text }
  })

  // The person's own turns in this session: a shared turn waits for them to finish.
  on('turn.start', ($, e, next) => {
    if (!child && e.agentId === undefined) rt.onTurnStart(e.text, e.turnId)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!child && e.agentId === undefined) void rt.onTurnComplete(e)
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    if (!child) rt.onMeasure(e.rateLimits)
    return next(e)
  })

  // ----------------------------------------------------------------- privacy

  // In a shared branch session, the person's auto-memory stays out of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (child !== 'shared') return composed
    return { sections: composed.sections.filter((s) => s.id !== 'memory') }
  })

  // ------------------------------------------------------------------ footer

  // The steady state ("connected", "running Sam's turn") as a dim label at the right of the prompt
  // footer. The status line is kept for what needs the person: Claude Code draws it as a warning.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (child) return next(e)
    const v: MultiplayerView = await read($, view)
    if (!v.isSignedIn || v.needsYou) return next(e)
    const label = `multiplayer: ${v.space || 'space'}${v.status === 'connected' ? '' : ` · ${v.status}`}`
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  // -------------------------------------------------------------------- pane

  on('ui.render', { component: 'Pane', requestId: 'multiplayer' }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const v: MultiplayerView = await read($, view)
    const width = Math.max(20, e.props.bodyColumns)
    const fit = (s: string) => (s.length > width ? s.slice(0, width - 1) + '…' : s)
    if (!v.isSignedIn) {
      return (
        <Box flexDirection="column">
          <Text bold>Multiplayer</Text>
          <Text dimColor>Not signed in to a space.</Text>
          <Text>/multiplayer start {'<space name>'}</Text>
          <Text>/multiplayer join {'<code>'} [your name]</Text>
          <Text>/multiplayer connect {'<pairing code>'}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>{fit(v.space || 'Multiplayer')}</Text>
        <Text dimColor>{fit(`Code ${v.code} · you are ${v.me}`)}</Text>
        <Text color={v.approval ? 'warning' : undefined}>{fit(v.status)}</Text>
        {v.approval ? <Text color="warning">{fit(`Approve in the web app, or /multiplayer allow or deny: ${v.approval.title}`)}</Text> : null}
        <Text> </Text>
        <Text bold>People</Text>
        {v.people.map((p) => (
          <Text dimColor={!p.runner && !p.here}>
            {fit(`${p.runner ? '●' : '○'} ${p.name}${p.isMe ? ' (you)' : ''} · ${p.role}${p.here ? ' · in the web app' : ''}`)}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Turns in flight</Text>
        {v.turns.length === 0 ? <Text dimColor>None.</Text> : null}
        {v.turns.map((t) => (
          <Text>{fit(`${t.who} · ${t.status} · ${t.text}`)}</Text>
        ))}
        <Text> </Text>
        <Link href={v.link} label="Open in the browser" />
        <Text dimColor>● runner connected  ○ not connected</Text>
      </Box>
    )
  })
}
