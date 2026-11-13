import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { removeServerInfo, type ServerInfo, writeServerInfo } from '../hub/home.js'
import type { Hub } from '../hub/hub.js'
import { createApp } from './app.js'
import type { AppContext } from './context.js'

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

  const onSignal = (): void => {
    void close().then(() => {
      opts.log('stopped')
      process.exit(0)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return { port, close }
}

/**
 * A quiet copy of one project's app on a free port, for `tour preview` to load pages from while it
 * runs. It answers under the project's base path, as the shared server does, and at the root, so a
 * page and the API calls it makes under its base path both resolve. It sweeps nothing and opens no
 * browser of its own.
 */
export async function startQuietServer(
  ctx: AppContext
): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = createApp(ctx)
  const base = ctx.config.basePath
  const fetch = (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(base)) {
      return app.fetch(request)
    }
    url.pathname = `/${url.pathname.slice(base.length)}`
    return app.fetch(new Request(url, request))
  }
  const server = serve({ fetch, port: 0, hostname: '127.0.0.1' })
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
        server.close(err => (err === undefined ? resolve() : reject(err)))
      }),
  }
}
