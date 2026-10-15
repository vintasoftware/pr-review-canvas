import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { startCheckoutSweep } from '../chat/checkout-sweep.js'
import { createApp } from './app.js'
import type { AppContext } from './context.js'
import { openBrowser } from './open-browser.js'
import { removeServerFile, writeServerFile } from './server-file.js'

/** Binds 127.0.0.1 only. The Host allowlist in security.ts covers the rest. */
export function startServer(ctx: AppContext, log: (line: string) => void): { close: () => void } {
  const app = createApp({ ...ctx, log })
  const server = serve({ fetch: app.fetch, port: ctx.config.port, hostname: '127.0.0.1' }, info => {
    const url = `http://localhost:${info.port}/`
    void writeServerFile(ctx.config.dataDir, info.port).catch(err =>
      log(`warning: could not record the port in ${ctx.config.dataDir}: ${String(err)}`)
    )
    log(`pr-review ${ctx.version} · ${url} · ${ctx.config.repo.owner}/${ctx.config.repo.name}`)
    if (ctx.config.openBrowser) {
      openBrowser(url, log)
    }
    log(`data dir ${ctx.config.dataDir}`)
    if (ctx.fixtureArtifact !== null) {
      log(`fixture canvas ${ctx.config.fixtureCanvasPath ?? ''} (dev only): every PR reports ready`)
    }
    for (const w of ctx.projectConfig.warnings) {
      log(`warning: ${w}`)
    }
  })
  // With chat off nothing creates review checkouts, but old ones are still cleaned up.
  const sweeper = startCheckoutSweep({
    checkouts: ctx.checkouts,
    readSettings: () => ctx.settings.read(),
    log,
    base: {
      checkouts: ctx.baseCheckouts,
      prState: async number => (await ctx.config.host.fetchPrMeta(ctx.gh, ctx.config.repo, number)).state,
    },
  })
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    sweeper.stop()
    void removeServerFile(ctx.config.dataDir).catch(() => undefined)
    // A browser holds its keep-alive socket open, and `close()` alone waits for it, so Ctrl-C
    // would look like a hung process. Dropping the sockets ends the wait. HTTP/2 servers have no
    // such method, and this one never is one.
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    server.close()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  const onSignal = (): void => {
    close()
    log('stopped')
    // The record goes before the exit, so a publish run next does not link to a dead port.
    void removeServerFile(ctx.config.dataDir)
      .catch(() => undefined)
      .finally(() => process.exit(0))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return { close }
}

/**
 * A quiet copy of the server on a free port, for `tour preview` to load pages from while it runs.
 * It sweeps nothing and opens no browser of its own.
 */
export async function startQuietServer(
  ctx: AppContext
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = serve({ fetch: createApp(ctx).fetch, port: 0, hostname: '127.0.0.1' })
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
