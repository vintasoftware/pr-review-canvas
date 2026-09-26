import { type Context, Hono } from 'hono'
import type { AppContext } from './context.js'
import type { AppEnv } from './env.js'
import { AppError, logRequestError, toAppError } from './errors.js'
import { errorPage } from './html.js'
import { apiRoutes } from './routes/api.js'
import { deckRoutes } from './routes/deck-routes.js'
import { appearanceFor, appearanceQuery, pageRoutes } from './routes/pages.js'
import { staticRoutes } from './routes/static.js'
import { applyResponseHeaders, createNonce, responseHeaders, securityMiddleware } from './security.js'

/** Errors under /api and /vendor answer with the JSON envelope; pages render the error page. */
function wantsJson(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/vendor/') || pathname.startsWith('/static/')
}

export function createApp(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', responseHeaders)
  app.use('*', securityMiddleware)

  /**
   * An error skips the code after `await next()` in the middleware above, so the answers built
   * here carry the same headers. A rejected Host never reached the nonce either, hence the
   * fallback.
   */
  const errorResponse = async (c: Context<AppEnv>, err: AppError): Promise<Response> => {
    const envelope = err.toEnvelope()
    const nonce = c.get('cspNonce') ?? createNonce()
    const res = wantsJson(c.req.path)
      ? c.json(envelope, err.status)
      : await c.html(
          errorPage(envelope.error, nonce, await appearanceFor(ctx, appearanceQuery(c))),
          err.status
        )
    applyResponseHeaders(res, c.req.path, nonce)
    return res
  }

  app.onError((err, c) => {
    logRequestError(ctx.log, c.req, err)
    return errorResponse(c, toAppError(err))
  })

  app.notFound(c =>
    errorResponse(c, new AppError('NOT_FOUND', `no route for ${c.req.method} ${c.req.path}`, 404))
  )

  app.route('/api/deck', deckRoutes(ctx))
  app.route('/api', apiRoutes(ctx))
  app.route('/', staticRoutes(ctx))
  app.route('/', pageRoutes(ctx))

  return app
}
