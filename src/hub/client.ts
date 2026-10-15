// How a command finds the running server and registers a checkout with it.
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ErrorEnvelope } from '../contract/api.js'
import { AppError, fromEnvelope } from '../server/errors.js'
import type { HubInfoResponse, RegisterInput, RegisterResponse } from './hub-app.js'
import { processAlive, readServerInfo, type ServerInfo } from './home.js'

/** How long a command waits for the server to answer before it counts it as gone. */
const ANSWER_TIMEOUT_MS = 3_000
/** Registering builds the project: git, the project config, the data dir. */
const REGISTER_TIMEOUT_MS = 30_000

export interface RunningServer extends ServerInfo {
  origin: string
}

/** The origin the browser opens a server on `port` at. */
export function originOf(port: number): string {
  return `http://localhost:${port}`
}

/**
 * Where a command calls the server: the address it binds (see node-server.ts), by number.
 * `localhost` may resolve to `::1` first, where a process of another user could listen and be
 * sent the token and the shell's environment.
 */
function callAddress(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** The server's answer; one that is not ok throws its error envelope. */
async function request(
  server: ServerInfo,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const res = await fetch(`${callAddress(server.port)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const error = ((await res.json().catch(() => null)) as ErrorEnvelope | null)?.error
    const status = res.status as ContentfulStatusCode
    throw error === undefined
      ? new AppError('INTERNAL', `the server answered ${res.status}`, status)
      : fromEnvelope(error, status)
  }
  return res
}

async function call<T>(
  server: ServerInfo,
  path: string,
  init: RequestInit = {},
  timeoutMs = ANSWER_TIMEOUT_MS
): Promise<T> {
  const res = await request(server, path, init, timeoutMs)
  const body = (await res.json().catch(() => null)) as unknown
  if (body === null) {
    throw new AppError('INTERNAL', `the server answered ${res.status} with no JSON`, 502)
  }
  return body as T
}

/**
 * The server `server.json` names, when it is still running and answers to its token. A file left
 * by a server that crashed, or a reused process id, reads as no server.
 */
export async function findServer(home: string): Promise<RunningServer | null> {
  const info = await readServerInfo(home)
  if (info === null || !processAlive(info.pid)) {
    return null
  }
  try {
    const answer = await call<HubInfoResponse>(info, '/api/hub')
    return answer.pid === info.pid ? { ...info, version: answer.version, origin: originOf(info.port) } : null
  } catch {
    return null
  }
}

/** The port of the server `server.json` names, if its process runs; no request is made. */
export async function runningPort(home: string): Promise<number | undefined> {
  const info = await readServerInfo(home)
  return info !== null && processAlive(info.pid) ? info.port : undefined
}

export function registerProject(server: ServerInfo, input: RegisterInput): Promise<RegisterResponse> {
  return call<RegisterResponse>(
    server,
    '/api/hub/projects',
    { method: 'POST', body: JSON.stringify(input) },
    REGISTER_TIMEOUT_MS
  )
}

/**
 * A call to one project's API on the server: `path` is under its `/api/`, as `prs/42/generate`.
 * Starting a generation reads the settings, the agent's models, and the host login, so a call
 * gets as long as registering does.
 */
export function callProject<T>(
  server: ServerInfo,
  basePath: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  return call<T>(server, `${basePath}api/${path}`, init, REGISTER_TIMEOUT_MS)
}

/** The file a project's API answers with, by the name its `content-disposition` gives. */
export async function downloadFromProject(
  server: ServerInfo,
  basePath: string,
  path: string
): Promise<{ name: string; bytes: Uint8Array }> {
  const res = await request(server, `${basePath}api/${path}`, {}, REGISTER_TIMEOUT_MS)
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
  if (name === undefined) {
    throw new AppError('INTERNAL', 'the server answered with no file name', 502)
  }
  return { name, bytes: new Uint8Array(await res.arrayBuffer()) }
}
