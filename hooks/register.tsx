// Multiplayer for Claude Code: this session signs in to a space and runs its person's
// turns of the shared conversation, each in its branch's own Claude Code session (see
// child.ts). The work lives in runner.ts; this file wires it to the engine.
import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { MultiplayerView } from '../types'
import type { Port } from './port.ts'
import { EMPTY_VIEW, PANE, Runner } from './runner.ts'

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

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (!child && r.decision === 'ask' && next.origin.plugin === $.plugin.name && (bridging.get(e.tool) ?? 0) > 0) {
      return { ...r, decision: 'allow', reason: 'Allowed in Multiplayer by its owner, for their shared turn.' }
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const role = await $.env.get('MULTIPLAYER_CHILD')
    if (role) {
      child = role === 'private' ? 'private' : 'shared'
      return started
    }
    // Everything the runner does on the engine, each spelled as a call on `$`.
    const io: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
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
      list: async (path) => (await $.fs.list(path)).map((x) => ({ name: x.name, kind: x.kind, size: x.size, mtimeMs: x.mtimeMs })),
      configDir: () => $.env.get('CLAUDE_CONFIG_DIR'),
      listTools: async () => (await $.tool.list()).map((t) => ({ name: t.name, description: t.description })),
      callTool: async (tool, input, approved) => {
        if (approved) bridging.set(tool, (bridging.get(tool) ?? 0) + 1)
        try {
          const r = await $.tool.call({ ...input, tool } as never)
          if (r.deny) return { text: r.deny, isError: true }
          return { text: r.text ?? '', ...(r.isError ? { isError: true } : {}) }
        } finally {
          if (approved) bridging.set(tool, (bridging.get(tool) ?? 1) - 1)
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
