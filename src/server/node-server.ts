import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import type { AppContext } from './context.js'

/** Binds 127.0.0.1 only. The Host allowlist in security.ts covers the rest. */
export function startServer(ctx: AppContext, log: (line: string) => void): { close: () => void } {
  const app = createApp({ ...ctx, log })
  const server = serve({ fetch: app.fetch, port: ctx.config.port, hostname: '127.0.0.1' }, info => {
    log(
      `pr-review ${ctx.version} · http://localhost:${info.port}/ · ${ctx.config.repo.owner}/${ctx.config.repo.name}`
    )
    log(`data dir ${ctx.config.dataDir}`)
    if (ctx.fixtureArtifact !== null) {
      log(`fixture canvas ${ctx.config.fixtureCanvasPath ?? ''} (dev only): every PR reports ready`)
    }
    for (const w of ctx.projectConfig.warnings) {
      log(`warning: ${w}`)
    }
  })
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
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
