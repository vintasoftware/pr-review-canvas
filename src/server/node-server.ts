import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { removeServerInfo, type ServerInfo, writeServerInfo } from '../hub/home.js'
import type { Hub } from '../hub/hub.js'

/** How long a second Ctrl-C has to come to stop a server that still runs an agent. */
export const CONFIRM_STOP_MS = 5_000

export interface HubServerOptions {
  fetch: (request: Request) => Response | Promise<Response>
  port: number
  hub: Hub
  /** Where `server.json` goes, so commands find this server; written once it listens. */
  home: string
  /** False when another server already owns `server.json`, which then stays as it is. */
  advertise: boolean
  info: Omit<ServerInfo, 'port' | 'pid'>
  log: (line: string) => void
  now?: () => number
}

export interface HubServer {
  port: number
  close: () => Promise<void>
}

/**
 * Binds 127.0.0.1 only; the Host allowlist in security.ts covers the rest. Resolves once the port
 * is bound, and rejects when it cannot be, such as when another program holds it.
 */
export async function startHubServer(opts: HubServerOptions): Promise<HubServer> {
  const now = opts.now ?? Date.now
  const server = serve({ fetch: opts.fetch, port: opts.port, hostname: '127.0.0.1' })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  if (opts.advertise) {
    await writeServerInfo(opts.home, { ...opts.info, pid: process.pid, port })
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    opts.hub.close()
    // A browser holds its keep-alive socket open, and `close()` alone waits for it, so Ctrl-C
    // would look like a hung process. Dropping the sockets ends the wait. HTTP/2 servers have no
    // such method, and this one never is one.
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    server.close()
    if (opts.advertise) {
      await removeServerInfo(opts.home, process.pid)
    }
  }

  // Every project's chat and generation live in this process, so a stop ends all of them. With
  // any running, the first Ctrl-C lists them and a second one, soon after, stops the server.
  let warnedAt: number | null = null
  const onSignal = (signal: NodeJS.Signals): void => {
    const running = opts.hub.running()
    const confirmed = warnedAt !== null && now() - warnedAt <= CONFIRM_STOP_MS
    if (signal === 'SIGINT' && running.length > 0 && !confirmed) {
      warnedAt = now()
      opts.log(
        [
          'still running:',
          ...running.map(line => `  ${line}`),
          `press Ctrl-C again within ${CONFIRM_STOP_MS / 1000} seconds to stop them and the server`,
        ].join('\n')
      )
      return
    }
    void close().then(() => {
      opts.log('stopped')
      process.exit(0)
    })
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return { port, close }
}
