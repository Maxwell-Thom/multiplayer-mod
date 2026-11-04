// The runner side of the wire, over `$.http.fetch`: what packages/sim's
// RunnerClient does, with the host's fetch in place of the platform's.
import type { Command } from './lib/commands.ts'
import type {
  CommandResponse, CreateSpaceRequest, JoinRequest, PollResponse, RunnerHello, RunnerOutbound, Session, Snapshot,
} from './lib/wire.ts'
import type { Fetch } from './port.ts'

/** A session this Claude Code is signed in with: the wire's Session plus where (`web`: the web app, when it lives apart from the server). */
export type StoredSession = Session & { server: string; spaceName?: string; web?: string }

/** This Claude Code's sign-in to a person's account on a server (from /multiplayer login). */
export type StoredAccount = { server: string; token: string; email?: string }

export class HttpError extends Error {
  readonly status: number
  /** The server's reason, e.g. 'sign-in' when an account sign-in is needed. */
  readonly code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function normalizeServer(url: string): string {
  const s = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

export function webLink(s: StoredSession): string {
  return `${s.web ?? s.server}/s/${s.spaceId}#token=${encodeURIComponent(s.token)}`
}

export async function call<T>(fetch: Fetch, url: string, method: string, token?: string, payload?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const init = payload === undefined ? { method, headers } : { method, headers, body: JSON.stringify(payload) }
  const res = await fetch(url, init)
  let data: (T & { error?: string; code?: string }) | undefined
  try {
    data = res.text ? (JSON.parse(res.text) as T & { error?: string; code?: string }) : undefined
  } catch {
    data = undefined
  }
  if (res.status >= 400 || data === undefined) {
    const msg = data?.error || (res.status >= 400 ? `HTTP ${res.status}` : 'The server sent something that is not JSON.')
    throw new HttpError(msg, res.status, typeof data?.code === 'string' ? data.code : undefined)
  }
  return data
}

/** `account`: this Claude Code's sign-in, on a server that has sign-in. */
export function createSpace(fetch: Fetch, server: string, req: CreateSpaceRequest, account?: string): Promise<Session> {
  return call<Session>(fetch, `${server}/api/spaces`, 'POST', account, req)
}

export function joinSpace(fetch: Fetch, server: string, req: JoinRequest, account?: string): Promise<Session> {
  return call<Session>(fetch, `${server}/api/join`, 'POST', account, req)
}

/** What a server says about itself: whether it has sign-in, and where its web app is. */
export type Health = { signIn: 'supabase' | 'none'; webUrl?: string }

export async function health(fetch: Fetch, server: string): Promise<Health> {
  const h = await call<{ signIn?: string; webUrl?: string }>(fetch, `${server}/api/health`, 'GET')
  const web = typeof h.webUrl === 'string' && /^https?:\/\//i.test(h.webUrl) ? h.webUrl.replace(/\/+$/, '') : undefined
  return { signIn: h.signIn === 'supabase' ? 'supabase' : 'none', webUrl: web }
}

export type DeviceStart = { deviceCode: string; userCode: string; url: string; expiresAt: number; interval: number }
export type DevicePoll = { status: 'pending' | 'expired' } | { status: 'done'; token: string; email?: string }

/** /multiplayer login: a link and a code for the person to approve in the web app. */
export function startDevice(fetch: Fetch, server: string): Promise<DeviceStart> {
  return call<DeviceStart>(fetch, `${server}/api/device`, 'POST', undefined, {})
}

export function pollDevice(fetch: Fetch, server: string, deviceCode: string): Promise<DevicePoll> {
  return call<DevicePoll>(fetch, `${server}/api/device/poll`, 'POST', undefined, { deviceCode })
}

/** Signs this Claude Code out of the account; never throws. */
export async function logoutAccount(fetch: Fetch, server: string, token: string): Promise<void> {
  try { await call(fetch, `${server}/api/account/logout`, 'POST', token, {}) } catch { /* it's forgotten here either way */ }
}

export function redeemPair(fetch: Fetch, server: string, pairCode: string): Promise<Session> {
  return call<Session>(fetch, `${server}/api/pair`, 'POST', undefined, { pairCode })
}

/** One signed-in space's runner endpoints. */
export class Wire {
  readonly base: string
  readonly token: string
  readonly runnerSession: string
  private fetch: Fetch

  constructor(fetch: Fetch, session: StoredSession, runnerSession: string) {
    this.fetch = fetch
    this.base = `${session.server}/api/spaces/${session.spaceId}`
    this.token = session.token
    this.runnerSession = runnerSession
  }

  snapshot(): Promise<Snapshot> {
    return call<Snapshot>(this.fetch, `${this.base}/snapshot`, 'GET', this.token)
  }

  hello(info: RunnerHello['info'], running: string[], tools?: RunnerHello['tools']): Promise<{ ok: boolean; seq: number }> {
    return call(this.fetch, `${this.base}/runner/hello`, 'POST', this.token, { info, running, session: this.runnerSession, ...(tools?.length ? { tools } : {}) })
  }

  poll(after: number, waitSeconds: number): Promise<PollResponse> {
    const q = `after=${after}&wait=${waitSeconds}&session=${encodeURIComponent(this.runnerSession)}`
    return call<PollResponse>(this.fetch, `${this.base}/runner/poll?${q}`, 'GET', this.token)
  }

  /**
   * A runner.* command (or an ordinary one) on the runner endpoint; never throws. `network`: it
   * didn't reach the server (or the server failed), as opposed to the server refusing it.
   */
  async command(cmd: Command): Promise<CommandResponse & { network?: boolean }> {
    try {
      return await call<CommandResponse>(this.fetch, `${this.base}/runner/commands`, 'POST', this.token, { cmd })
    } catch (err) {
      const network = !(err instanceof HttpError) || err.status >= 500
      return { ok: false, error: (err as Error).message, seq: -1, ...(network ? { network } : {}) }
    }
  }

  /** This Claude Code is closing: its turns end now. Never throws. */
  /** Puts a file into the space (a shared turn's file Claude made): its bytes as base64. */
  async upload(q: { branchId: string; name: string; turnId?: string; from: 'claude' | 'upload' }, base64: string, type: string): Promise<{ id: string; name: string; size: number }> {
    const qs = new URLSearchParams({ branchId: q.branchId, name: q.name, from: q.from, ...(q.turnId ? { turnId: q.turnId } : {}) })
    const res = await this.fetch(`${this.base}/files?${qs}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'text/plain', 'x-file-encoding': 'base64', 'x-file-type': type }, body: base64 })
    let data: { ok?: boolean; error?: string; file?: { id: string; name: string; size: number } } | undefined
    try { data = JSON.parse(res.text) } catch { data = undefined }
    if (res.status >= 400 || !data?.file) throw new HttpError(data?.error || `HTTP ${res.status}`, res.status)
    return data.file
  }

  /** A ten-minute link to a file, that works without signing in (for curl). */
  async fileLink(fileId: string): Promise<string> {
    return (await call<{ url: string }>(this.fetch, `${this.base}/files/${encodeURIComponent(fileId)}/link`, 'POST', this.token)).url
  }

  async bye(): Promise<void> {
    try {
      await call(this.fetch, `${this.base}/runner/bye`, 'POST', this.token, { session: this.runnerSession })
    } catch {
      // The server notices by itself when the polls stop.
    }
  }

  /** delta, approval.request / approval.cleared, files.report; never throws. */
  async live(msg: RunnerOutbound): Promise<boolean> {
    try {
      const r = await call<{ ok: boolean }>(this.fetch, `${this.base}/runner/live`, 'POST', this.token, { msg })
      return !!r.ok
    } catch {
      return false
    }
  }
}
