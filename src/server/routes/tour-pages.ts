// The tour page, and the frames its landmarks' scenes and micro-worlds are drawn in.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { type Appearance, appearanceForRequest } from '../../contract/settings.js'
import { parseReviewKey } from '../../contract/review-key.js'
import { lookupTour, tourAt } from '../../tour/lookup.js'
import { inlineIcons } from '../../tour/scene.js'
import { createPrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import type { AppEnv } from '../env.js'
import { AppError } from '../errors.js'
import { sceneFrame, tourPage } from '../html.js'
import { appearanceQuery } from './pages.js'

const SHA_RE = /^[0-9a-f]{40}$/

/** The tour offers the github and olive skins; the base terminal look is drawn as github. */
export function tourAppearance(appearance: Appearance): Appearance {
  return appearance.skin === 'terminal' ? { ...appearance, skin: 'github' } : appearance
}

function parseTourKey(raw: string) {
  const key = parseReviewKey(raw)
  if (key === null) {
    throw new AppError(
      'BAD_REQUEST',
      `"${raw}" is not a tour target`,
      400,
      'use /tour/<number>, /tour/branch, or /tour/uncommitted'
    )
  }
  return key
}

export function tourPageRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const loader = createPrLoader(ctx)

  app.get('/tour/:n', async c => {
    const key = parseTourKey(c.req.param('n'))
    const settings = await ctx.settings.read()
    const landmark = c.req.query('landmark')
    return c.html(
      tourPage(
        {
          key,
          owner: ctx.config.repo.owner,
          repo: ctx.config.repo.name,
          version: ctx.version,
          host: ctx.config.host,
          preview: c.req.query('preview') !== undefined,
          ...(landmark === undefined || landmark === '' ? {} : { landmark }),
        },
        c.get('cspNonce'),
        tourAppearance(appearanceForRequest(settings, appearanceQuery(c)))
      )
    )
  })

  // The scene's frame carries its own policy (see `sceneFramePolicy`): sandboxed, inline only,
  // no network. `headSha` names the tour on the page, which for a stale tour is not the head's.
  app.get('/tour-scene/:n/:landmark/:kind', async c => {
    const key = parseTourKey(c.req.param('n'))
    const id = c.req.param('landmark')
    const kind = c.req.param('kind')
    if (kind !== 'scene' && kind !== 'micro') {
      throw new AppError('BAD_REQUEST', `no such scene kind: ${kind}`, 400, 'use scene or micro')
    }
    const headSha = c.req.query('headSha')
    let artifact
    if (c.req.query('preview') !== undefined) {
      const found = await lookupTour(ctx, loader, key, { preview: true })
      if (found.status === 'missing') throw new AppError('CANVAS_NOT_FOUND', `no tour of ${String(key)}`, 404)
      artifact = found.artifact
    } else {
      if (headSha === undefined || !SHA_RE.test(headSha)) {
        throw new AppError('BAD_REQUEST', 'headSha must name the tour on the page', 400)
      }
      artifact = await tourAt(ctx, key, headSha)
    }
    const landmark = artifact.landmarks.find(l => l.id === id)
    const scene = landmark?.[kind]
    if (typeof scene !== 'string') {
      throw new AppError('NOT_FOUND', `landmark ${id} has no ${kind}`, 404)
    }
    const [kit, runtime] = await Promise.all([
      readFile(path.join(ctx.staticDir, 'styles', 'scene.css'), 'utf8'),
      readFile(path.join(ctx.staticDir, 'js', 'scene-runtime.js'), 'utf8'),
    ])
    const appearance = tourAppearance(appearanceForRequest(await ctx.settings.read(), appearanceQuery(c)))
    const res = c.html(
      sceneFrame({ scene: inlineIcons(scene), skin: appearance.skin, theme: appearance.theme, kit, runtime })
    )
    res.headers.set('cache-control', 'no-store')
    return res
  })

  return app
}
