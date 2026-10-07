// How a command finds the running server and registers a checkout with it.
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ErrorEnvelope } from '../contract/api.js'
import { AppError } from '../server/errors.js'
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

async function call<T>(
  server: ServerInfo,
  path: string,
  init: RequestInit = {},
  timeoutMs = ANSWER_TIMEOUT_MS
): Promise<T> {
  const res = await fetch(`${callAddress(server.port)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const error = (body as ErrorEnvelope | null)?.error
    throw new AppError(
      error?.code ?? 'INTERNAL',
      error?.message ?? `the server answered ${res.status}`,
      res.status as ContentfulStatusCode,
      error?.hint
    )
  }
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
