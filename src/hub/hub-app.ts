// The shared server's front: `/r/<project>/…` goes to that project's own app with the prefix
// taken off, so each project answers exactly as it did on a server of its own. The rest is the
// server's: the project list at `/`, the page's static files, and `/api/hub`, where a command
// registers a checkout with the token from `server.json`.
import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { ConfigError } from '../config.js'
import { AppearanceInputSchema, type AppearanceResponse, appearanceForRequest } from '../contract/settings.js'
import type { VendorRoots } from '../server/context.js'
import type { AppEnv } from '../server/env.js'
import { AppError, logRequestError, toAppError } from '../server/errors.js'
import { errorPage, projectsPage } from '../server/html.js'
import { appearanceQuery } from '../server/routes/pages.js'
import { readBody } from '../server/routes/review-routes.js'
import { staticRoutes } from '../server/routes/static.js'
import {
  applyResponseHeaders,
  createNonce,
  isAllowedHost,
  responseHeaders,
  securityMiddleware,
} from '../server/security.js'
import { readAppearance, writeAppearance } from './home.js'
import { ProjectFlagsSchema } from '../load-context.js'
import type { Hub } from './hub.js'
import { basePathOf, PROJECTS_PREFIX } from './slug.js'

export interface HubAppOptions {
  hub: Hub
  /** The server's own folder, which holds how the project list is painted. */
  home: string
  /** The user's home folder, which the project list writes as `~`. This process's when omitted. */
  homeDir?: string
  /** The secret in `server.json`: only a command that can read that file registers projects. */
  token: string
  version: string
  /** Read per request: the server knows it once it listens. */
  port: () => number
  staticDir: string
  vendorRoots: VendorRoots
  log: (line: string) => void
}

export const RegisterInputSchema = z.object({
  repoRoot: z.string().refine(p => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'an absolute path'),
  env: z.record(z.string(), z.string()).optional(),
  flags: ProjectFlagsSchema.optional(),
})
export type RegisterInput = z.infer<typeof RegisterInputSchema>

const RemoveInputSchema = z.object({ slug: z.string() })

export interface RegisterResponse {
  /** The checkout's name on the server: `<owner>/<repo>`, or `<owner>/<repo>~<worktree>`. */
  slug: string
  basePath: string
  /** True when the project kept its running context, and with it the environment it had. */
  kept: boolean
}

export interface HubHealthResponse {
  ok: true
  version: string
  port: number
  /** Each checkout served, with where its own checks (git, the host login, the agent) answer. */
  projects: { slug: string; repoRoot: string; health: string }[]
}

export interface HubInfoResponse {
  version: string
  pid: number
  port: number
}

/** A path under the home folder written from `~`, as a shell prints it. */
export function shortPath(dir: string, homeDir: string): string {
  return dir === homeDir || dir.startsWith(`${homeDir}${path.sep}`) ? `~${dir.slice(homeDir.length)}` : dir
}

/** Same length or not, the comparison takes the same time, so the token leaks nothing. */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The request headers a project app sees: the original ones, whose Host it checks itself. */
function forwarded(raw: Request, pathname: string): Request {
  const url = new URL(raw.url)
  url.pathname = pathname
  const hasBody = raw.method !== 'GET' && raw.method !== 'HEAD'
  return new Request(url, {
    method: raw.method,
    headers: raw.headers,
    signal: raw.signal,
    ...(hasBody ? { body: raw.body, duplex: 'half' } : {}),
  })
}

export function createHubApp(opts: HubAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const appearance = async (c: Context<AppEnv>) =>
    appearanceForRequest(await readAppearance(opts.home), appearanceQuery(c))

  const errorResponse = async (c: Context<AppEnv>, err: AppError): Promise<Response> => {
    const envelope = err.toEnvelope()
    const nonce = c.get('cspNonce') ?? createNonce()
    const res = c.req.path.startsWith('/api/')
      ? c.json(envelope, err.status)
      : await c.html(errorPage(envelope.error, nonce, await appearance(c)), err.status)
    applyResponseHeaders(res, c.req.path, nonce)
    return res
  }

  app.onError((err, c) => {
    logRequestError(opts.log, c.req, err)
    return errorResponse(c, toAppError(err))
  })
  app.notFound(c =>
    errorResponse(c, new AppError('NOT_FOUND', `no route for ${c.req.method} ${c.req.path}`, 404))
  )

  // First, so the server's own headers never land on a project's answer: the project app sets
  // its own, with the nonce of its own page.
  app.all(`${PROJECTS_PREFIX}*`, async c => {
    // A rebinding domain that resolves to this machine never gets a project built for it. A page
    // on another site can still make a plain GET here, which at most builds a saved project from
    // its own checkout; the project app refuses its writes.
    if (!isAllowedHost(c.req.header('host'))) {
      throw new AppError('FORBIDDEN_HOST', 'this server only answers to localhost', 403)
    }
    const resolved = await opts.hub.resolve(c.req.path).catch((err: unknown) => {
      throw new AppError(
        'NOT_FOUND',
        `could not open this project: ${err instanceof Error ? err.message : String(err)}`,
        404,
        "run `pr-review open` in the project's folder"
      )
    })
    if (resolved === null) {
      throw new AppError(
        'NOT_FOUND',
        `no project is served at ${c.req.path}`,
        404,
        "run `pr-review open` in the project's folder to add it"
      )
    }
    if (resolved.kind === 'redirect') {
      return c.redirect(`${resolved.location}${new URL(c.req.url).search}`, 308)
    }
    return resolved.project.app.fetch(forwarded(c.req.raw, resolved.rest))
  })

  app.use('*', responseHeaders)
  app.use('*', securityMiddleware)

  const requireToken: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    if (!header.startsWith('Bearer ') || !sameToken(header.slice('Bearer '.length), opts.token)) {
      throw new AppError('SERVER_TOKEN_INVALID', 'this call needs the token in server.json', 403)
    }
    await next()
  }

  app.get('/api/hub', requireToken, c => {
    const body: HubInfoResponse = { version: opts.version, pid: process.pid, port: opts.port() }
    return c.json(body)
  })

  app.post('/api/hub/projects', requireToken, async c => {
    const input = await readBody(c.req.raw, RegisterInputSchema, '{ "repoRoot": "/path/to/checkout" }')
    const { project, kept } = await opts.hub.register(input).catch((err: unknown) => {
      // A folder that is no repository, or a flag the config refuses, is the command's mistake.
      throw err instanceof ConfigError ? new AppError(err.code, err.message, 400, err.hint) : err
    })
    const { slug, basePath } = project.ctx.config
    const body: RegisterResponse = { slug, basePath, kept }
    return c.json(body)
  })

  // The server's own health, which the project list links to as each project's home page links to
  // its own: the version, the port, and the checkouts served, each with its own health check.
  app.get('/api/health', async c => {
    const projects = await opts.hub.projects()
    const body: HubHealthResponse = {
      ok: true,
      version: opts.version,
      port: opts.port(),
      projects: projects.map(entry => ({
        slug: entry.slug,
        repoRoot: entry.repoRoot,
        health: `${basePathOf(entry.slug)}api/health`,
      })),
    }
    return c.json(body)
  })

  // The project list's own skin and theme. No token: the page calls it, and the same-origin check
  // keeps other sites out, as for a project's appearance.
  app.get('/api/appearance', async c => {
    const body: AppearanceResponse = await readAppearance(opts.home)
    return c.json(body)
  })

  app.put('/api/appearance', async c => {
    const input = await readBody(c.req.raw, AppearanceInputSchema, '{ "skin": "github", "theme": "dark" }')
    const body: AppearanceResponse = await writeAppearance(opts.home, input)
    return c.json(body)
  })

  // The project list's remove command. No token: the page calls it, and the same-origin check
  // keeps other sites out. It takes the project off the list only; its data stays, and
  // `pr-review open` adds it again.
  app.post('/api/projects/remove', async c => {
    const { slug } = await readBody(c.req.raw, RemoveInputSchema, '{ "slug": "owner/repo" }')
    if (!(await opts.hub.remove(slug))) {
      throw new AppError('NOT_FOUND', `no project ${slug} is served here`, 404, 'reload the project list')
    }
    return c.json({ removed: true })
  })

  app.route('/', staticRoutes(opts))

  app.get('/', async c => {
    const projects = await opts.hub.projects()
    return c.html(
      projectsPage(
        {
          version: opts.version,
          port: opts.port(),
          projects: projects.map(entry => ({
            slug: entry.slug,
            repoRoot: entry.repoRoot,
            shownPath: shortPath(entry.repoRoot, opts.homeDir ?? os.homedir()),
          })),
        },
        c.get('cspNonce'),
        await appearance(c)
      )
    )
  })

  return app
}
