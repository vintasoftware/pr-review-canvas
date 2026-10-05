import { serve } from '@hono/node-server'
import { startCheckoutSweep } from '../chat/checkout-sweep.js'
import { createApp } from './app.js'
import type { AppContext } from './context.js'
import { openBrowser } from './open-browser.js'
import { startPage } from './start-page.js'

/** Binds 127.0.0.1 only. The Host allowlist in security.ts covers the rest. */
export function startServer(ctx: AppContext, log: (line: string) => void): { close: () => void } {
  const app = createApp({ ...ctx, log })
  const server = serve({ fetch: app.fetch, port: ctx.config.port, hostname: '127.0.0.1' }, info => {
    const url = `http://localhost:${info.port}/`
    log(`pr-review ${ctx.version} · ${url} · ${ctx.config.repo.owner}/${ctx.config.repo.name}`)
    if (ctx.config.openBrowser) {
      void (async () => {
        const start = await startPage(ctx)
        if (start.prNumber !== null) {
          log(`opening ${ctx.config.host.nounShort} #${start.prNumber}, the open review of this branch`)
        }
        openBrowser(new URL(start.path, url).href, log)
      })()
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
  })
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    sweeper.stop()
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
    process.exit(0)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return { close }
}
