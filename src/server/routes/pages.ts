import { Hono } from 'hono'
import { type Appearance, type AppearanceQuery, appearanceForRequest } from '../../contract/settings.js'
import type { AppContext } from '../context.js'
import type { AppEnv } from '../env.js'
import { AppError } from '../errors.js'
import { LOCAL_KEYS, parseReviewKey } from '../../contract/review-key.js'
import { homePage, reviewPage } from '../html.js'

/** How the page is painted, rendered onto the tag so nothing flashes before the app module runs. */
export async function appearanceFor(ctx: AppContext, query: AppearanceQuery): Promise<Appearance> {
  return appearanceForRequest(await ctx.settings.read(), query)
}

/** The `?skin` and `?theme` of one request, which pick an appearance for that load alone. */
export function appearanceQuery(c: {
  req: { query: (name: string) => string | undefined }
}): AppearanceQuery {
  return { skin: c.req.query('skin'), theme: c.req.query('theme') }
}

export function pageRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async c => {
    const [recentPrs, ...localPrs] = await Promise.all([
      ctx.prs.listRecent(10),
      ...LOCAL_KEYS.map(key => ctx.prs.readPr(key)),
    ])
    return c.html(
      homePage(
        {
          recentPrs,
          localReviews: LOCAL_KEYS.filter((_, i) => localPrs[i] !== null && localPrs[i] !== undefined),
          owner: ctx.config.repo.owner,
          repo: ctx.config.repo.name,
          version: ctx.version,
          port: ctx.config.port,
          host: ctx.config.host,
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
    const prNumber = parseReviewKey(raw)
    if (prNumber === null) {
      throw new AppError(
        'BAD_REQUEST',
        `"${raw}" is not a review target`,
        400,
        'use /review/<number>, /review/branch, or /review/uncommitted'
      )
    }
    // One read serves both the appearance and how the canvas shows its layers.
    const settings = await ctx.settings.read()
    return c.html(
      reviewPage(
        {
          prNumber,
          owner: ctx.config.repo.owner,
          repo: ctx.config.repo.name,
          version: ctx.version,
          host: ctx.config.host,
          layerView: settings.layerView,
        },
        c.get('cspNonce'),
        appearanceForRequest(settings, appearanceQuery(c))
      )
    )
  })

  return app
}
