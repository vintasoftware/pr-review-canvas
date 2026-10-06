import { Hono } from 'hono'
import { type Appearance, type AppearanceQuery, appearanceForRequest } from '../../contract/settings.js'
import type { AppContext } from '../context.js'
import type { AppEnv } from '../env.js'
import { AppError } from '../errors.js'
import { LOCAL_KEYS, parseReviewKey } from '../../contract/review-key.js'
import { homePage, reviewPage } from '../html.js'
import { startPage } from '../start-page.js'
import type { ProjectLink } from '../../../static/js/header-bar.js'

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

/** What the shared server knows of a project beyond its context. */
export interface Served {
  /** False when the project runs under the server's environment rather than its shell's. */
  shellEnv: boolean
}

/**
 * The project as its pages' header names it. A project running under the server's environment
 * names its folder too, where `pr-review open` gives it the shell's.
 */
export function projectLink(ctx: AppContext, served: Served): ProjectLink {
  return {
    slug: ctx.config.slug,
    home: ctx.config.basePath,
    reopenIn: served.shellEnv ? undefined : ctx.config.repoRoot,
  }
}

export function pageRoutes(ctx: AppContext, project: ProjectLink): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async c => {
    const [acpx, recentPrs, ...localPrs] = await Promise.all([
      ctx.projectConfig.config.chat.enabled ? ctx.preflight.get() : Promise.resolve({ installed: false }),
      ctx.prs.listRecent(10),
      ...LOCAL_KEYS.map(key => ctx.prs.readPr(key)),
    ])
    const canvases = Object.values((await ctx.canvases.readIndex()).canvases)
    return c.html(
      homePage(
        {
          recentPrs: recentPrs.map(p => ({
            ...p,
            hasCanvas: canvases.some(canvas => canvas.prNumber === p.number),
          })),
          localReviews: LOCAL_KEYS.filter((_, i) => localPrs[i] !== null && localPrs[i] !== undefined),
          owner: ctx.config.repo.owner,
          repo: ctx.config.repo.name,
          version: ctx.version,
          project,
          base: ctx.config.basePath,
          host: ctx.config.host,
          canGenerate: acpx.installed,
        },
        c.get('cspNonce'),
        await appearanceFor(ctx, appearanceQuery(c))
      )
    )
  })

  // Where `pr-review open` and `serve` point the browser. The lookup runs here rather than in the
  // command, so the browser opens at once and lands on the branch's open review when it is found.
  app.get('/start', async c => c.redirect(await startPage(ctx, ctx.log), 302))

  // Where the home page's form lands. It is a plain GET form, so the page needs no script of its
  // own and the number arrives as a query parameter.
  app.get('/review', c => {
    const raw = c.req.query('n') ?? ''
    // The form's generate button carries the flag on to the review page, which opens the dialog.
    const generate = c.req.query('generate') === '1' ? '?generate=1' : ''
    return c.redirect(`${ctx.config.basePath}review/${encodeURIComponent(raw)}${generate}`, 303)
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
    // One read serves the appearance, the reading level the canvas opens at, and how it shows its
    // layers.
    const settings = await ctx.settings.read()
    return c.html(
      reviewPage(
        {
          prNumber,
          owner: ctx.config.repo.owner,
          repo: ctx.config.repo.name,
          base: ctx.config.basePath,
          project: ctx.config.slug,
          reopenIn: project.reopenIn,
          version: ctx.version,
          host: ctx.config.host,
          foldLevel: settings.foldLevel,
          layerView: settings.layerView,
        },
        c.get('cspNonce'),
        appearanceForRequest(settings, appearanceQuery(c))
      )
    )
  })

  return app
}
