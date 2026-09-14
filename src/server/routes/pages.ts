import { Hono } from 'hono'
import { type Appearance, type AppearanceQuery, appearanceForRequest } from '../../contract/settings.js'
import type { AppContext } from '../context.js'
import type { AppEnv } from '../env.js'
import { AppError } from '../errors.js'
import { homePage, reviewPage } from '../html.js'
import { parsePrNumber } from './api.js'

/** How the page is painted, rendered onto the tag so nothing flashes before the app module runs. */
export async function appearanceFor(ctx: AppContext, query: AppearanceQuery): Promise<Appearance> {
  return appearanceForRequest(await ctx.settings.read(), query)
}

/** The `?skin` and `?theme` of one request, which pick an appearance for that load alone. */
export function appearanceQuery(c: { req: { query: (name: string) => string | undefined } }): AppearanceQuery {
  return { skin: c.req.query('skin'), theme: c.req.query('theme') }
}

export function pageRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async c => {
    const recentPrs = await ctx.prs.listRecent(10)
    return c.html(
      homePage(
        {
          recentPrs,
          owner: ctx.config.repo.owner,
          repo: ctx.config.repo.name,
          version: ctx.version,
          port: ctx.config.port,
        },
        c.get('cspNonce'),
        await appearanceFor(ctx, appearanceQuery(c))
      )
    )
  })

  // Where the home page's form lands. It is a plain GET form, so the page needs no script of its
  // own and the number arrives as a query parameter.
  app.get('/review', c => {
    const raw = c.req.query('n') ?? ''
    return c.redirect(`/review/${encodeURIComponent(raw)}`, 303)
  })

  app.get('/review/:n', async c => {
    const raw = c.req.param('n')
    let prNumber: number
    try {
      prNumber = parsePrNumber(raw)
    } catch {
      throw new AppError('BAD_REQUEST', `"${raw}" is not a pull request number`, 400, 'use /review/<number>')
    }
    return c.html(
      reviewPage(
        { prNumber, owner: ctx.config.repo.owner, repo: ctx.config.repo.name, version: ctx.version },
        c.get('cspNonce'),
        await appearanceFor(ctx, appearanceQuery(c))
      )
    )
  })

  return app
}
