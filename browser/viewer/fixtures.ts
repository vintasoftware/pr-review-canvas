// The static viewer as a reader gets it: the production build (build.setup.ts) served under the
// headers Cloudflare Pages sends, with GitHub's API, GitHub's sign-in page, and the auth Worker
// answered inside the browser. Nothing leaves the machine: a request to any other host fails the
// test.
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type Page, type Route } from '@playwright/test'
import { buildCanvasComment } from '../../src/canvas/comment.js'
import { buildCanvasZip } from '../../src/canvas/zip.js'
import type { CanvasManifest } from '../../src/contract/canvas-manifest.js'
import { tallyCanvas } from '../../src/review/self-review.js'
import {
  BASE_SHA,
  GH_ISSUE_COMMENTS,
  GH_PULL,
  GH_REVIEW_COMMENTS,
  HEAD_SHA,
  publishedSyntheticArtifact,
  SYNTHETIC_DIFF,
} from '../../src/testing/synthetic.js'
import { viewerHeaders } from '../../viewer/headers.js'

export { expect } from '@playwright/test'

/** Where build.setup.ts writes the viewer, out of the way of `pnpm viewer:build`. */
export const VIEWER_BUILD_DIR = fileURLToPath(
  new URL('../../node_modules/.cache/pr-review-viewer-e2e/', import.meta.url)
)

const AUTH_WORKER = 'https://auth.viewer.test'
export const CLIENT_ID = 'Iv1.viewer-e2e'

/** What the test build is given in place of the real GitHub App and Worker. */
export const VIEWER_TEST_ENV = {
  VITE_GITHUB_CLIENT_ID: CLIENT_ID,
  VITE_GITHUB_APP_SLUG: 'canvas-viewer-e2e',
  VITE_AUTH_WORKER_URL: AUTH_WORKER,
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

/** Serves the build as Pages does: its files, its headers, and index.html at `/`. */
async function serveBuild(): Promise<{ origin: string; close: () => Promise<void> }> {
  const headers = viewerHeaders({ workerUrl: AUTH_WORKER })
  // A plain http server cannot carry HSTS; the hosted page is https.
  delete (headers as Partial<typeof headers>)['Strict-Transport-Security']
  const send = async (path: string): Promise<{ status: number; body: Buffer | null; type: string }> => {
    const file = normalize(join(VIEWER_BUILD_DIR, path === '/' ? 'index.html' : path))
    if (!file.startsWith(VIEWER_BUILD_DIR.replace(/[\\/]$/, '') + sep)) {
      return { status: 404, body: null, type: 'text/plain' }
    }
    try {
      const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream'
      return { status: 200, body: await readFile(file), type }
    } catch {
      return { status: 404, body: null, type: 'text/plain' }
    }
  }
  const server = createServer((req, res) => {
    void send(new URL(req.url ?? '/', 'http://viewer').pathname).then(({ status, body, type }) => {
      res.writeHead(status, { ...headers, 'content-type': type })
      res.end(body ?? '')
      return status
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('viewer server did not bind a port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** One answer of the fake GitHub API: a JSON body, or a status with a body and headers. */
export type GhAnswer = unknown | { status: number; body?: unknown; headers?: Record<string, string> }

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  body,
  headers,
  [ANSWER]: true,
})
const ANSWER = Symbol('answer')
/** GitHub answering `status`, as a refusal or a rate limit. */
export const ghStatus = (status: number, message: string, headers: Record<string, string> = {}) =>
  answer(status, { message }, headers)

export function manifest(over: Partial<CanvasManifest> = {}): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.11.1' },
    repo: { owner: 'acme', name: 'widgets' },
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-11-18T10:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
    ...over,
  }
}

/** The canvas comment `pr-review publish` posts, by `login` with GitHub's `association`. */
export function canvasComment(opts: { login?: string; association?: string; id?: number } = {}) {
  const m = manifest()
  const artifact = publishedSyntheticArtifact()
  const zip = {
    name: 'pr-42-canvas.zip',
    headSha: m.headSha,
    prNumber: 42,
    bytes: buildCanvasZip(m, artifact),
  }
  const id = opts.id ?? 3001
  return {
    id,
    user: { login: opts.login ?? 'octocat' },
    author_association: opts.association ?? 'OWNER',
    body: buildCanvasComment(zip, tallyCanvas(artifact), 1_000_000),
    created_at: '2026-11-18T11:00:00Z',
    html_url: `https://github.com/acme/widgets/pull/42#issuecomment-${id}`,
  }
}

/** One request the page sent to GitHub's API. */
export interface GhRequest {
  method: string
  path: string
  authorization: string | null
}

/**
 * GitHub's API for acme/widgets#42 at HEAD_SHA, with no canvas comment. `routes` replaces answers
 * by path, without the query; `diff:<base>...<head>` names a raw diff.
 */
export class FakeGithub {
  readonly requests: GhRequest[] = []
  readonly routes: Record<string, GhAnswer> = {
    'repos/acme/widgets/pulls/42': GH_PULL,
    [`repos/acme/widgets/compare/main...${HEAD_SHA}`]: { merge_base_commit: { sha: BASE_SHA } },
    [`diff:${BASE_SHA}...${HEAD_SHA}`]: SYNTHETIC_DIFF,
    'repos/acme/widgets/pulls/42/comments': GH_REVIEW_COMMENTS,
    'repos/acme/widgets/pulls/42/reviews': [],
    'repos/acme/widgets/issues/42/comments': GH_ISSUE_COMMENTS,
  }
  /** The login behind any token the page sends. */
  login = 'reviewer'

  /** Adds comments to the pull request's conversation. */
  comment(...comments: unknown[]): this {
    this.routes['repos/acme/widgets/issues/42/comments'] = [...GH_ISSUE_COMMENTS, ...comments]
    return this
  }

  async handle(route: Route): Promise<void> {
    const request = route.request()
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers':
        'authorization, accept, content-type, if-none-match, x-github-api-version',
      'access-control-expose-headers': 'etag, link, x-ratelimit-remaining, x-ratelimit-reset',
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\//, '')
    const authorization = (await request.headerValue('authorization')) ?? null
    this.requests.push({ method: request.method(), path, authorization })
    const wantsDiff = (await request.headerValue('accept'))?.includes('diff') === true
    const compare = /^repos\/acme\/widgets\/compare\/(.+)$/.exec(path)
    const key = wantsDiff && compare !== null ? `diff:${decodeURIComponent(compare[1]!)}` : path
    let found: GhAnswer = path === 'user' && authorization !== null ? { login: this.login } : this.routes[key]
    // A list asked for page by page: one page holds everything.
    if (Array.isArray(found) && Number(url.searchParams.get('page') ?? '1') > 1) found = []
    const reply =
      found === undefined
        ? answer(404, { message: 'Not Found' })
        : typeof found === 'object' && found !== null && ANSWER in found
          ? (found as ReturnType<typeof answer>)
          : answer(200, found)
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    await route.fulfill({
      status: reply.status,
      headers: {
        ...cors,
        'content-type': typeof reply.body === 'string' ? 'text/plain' : 'application/json',
        ...reply.headers,
      },
      body: text,
    })
  }
}

/** The GitHub App sign-in, as GitHub's authorize page and the auth Worker run it. */
export class FakeSignIn {
  /** The PKCE challenge GitHub was sent, and the verifier the Worker received. */
  challenge: string | null = null
  verifier: string | null = null
  token = 'ghu_viewer_e2e'
  /** What GitHub's authorize page does: send a code back, or report the reader declined. */
  outcome: 'approve' | 'deny' = 'approve'

  async authorize(route: Route): Promise<void> {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    this.challenge = url.searchParams.get('code_challenge')
    const back = new URL(url.searchParams.get('redirect_uri')!)
    back.searchParams.set('state', url.searchParams.get('state')!)
    if (this.outcome === 'approve') back.searchParams.set('code', 'code-e2e')
    else back.searchParams.set('error', 'access_denied')
    await route.fulfill({ status: 302, headers: { location: back.href } })
  }

  async worker(route: Route): Promise<void> {
    const request = route.request()
    const cors = {
      'access-control-allow-origin': new URL(request.headers()['origin'] ?? 'http://x').origin,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST',
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    const body = request.postDataJSON() as { code?: string; codeVerifier?: string }
    this.verifier = body.codeVerifier ?? null
    const ok = new URL(request.url()).pathname === '/token' && body.code === 'code-e2e'
    await route.fulfill({
      status: ok ? 200 : 400,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify(
        ok
          ? {
              accessToken: this.token,
              expiresIn: 28_800,
              refreshToken: 'ghr_e2e',
              refreshTokenExpiresIn: 1_000_000,
            }
          : { error: 'bad_verification_code' }
      ),
    })
  }

  /** Whether the verifier the Worker got hashes to the challenge GitHub got, as PKCE requires. */
  verifierMatches(): boolean {
    if (this.challenge === null || this.verifier === null) return false
    const digest = createHash('sha256').update(this.verifier).digest('base64url')
    return digest === this.challenge
  }
}

/** Fails the test on a script error, a CSP violation, or a request to a host the test did not answer. */
async function watch(page: Page): Promise<() => void> {
  const problems: string[] = []
  page.on('pageerror', error => problems.push(`page error: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      problems.push(`CSP: ${message.text()}`)
    }
  })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      console.error(
        `Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`
      )
    })
  })
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, async route => {
    problems.push(`unexpected request: ${route.request().method()} ${route.request().url()}`)
    await route.abort()
  })
  return () => expect(problems).toEqual([])
}

export const test = base.extend<
  { github: FakeGithub; signIn: FakeSignIn; open: (pr?: string) => Promise<void> },
  { viewerOrigin: string }
>({
  viewerOrigin: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function names.
    async ({}, use) => {
      const server = await serveBuild()
      try {
        await use(server.origin)
      } finally {
        await server.close()
      }
    },
    { scope: 'worker' },
  ],
  github: async ({ page }, use) => {
    const check = await watch(page)
    const github = new FakeGithub()
    await page.route('https://api.github.com/**', route => github.handle(route))
    // Avatars and images a comment names: GitHub's hosts, allowed by the CSP, answered empty.
    await page.route(/^https:\/\/([a-z0-9-]+\.)*githubusercontent\.com\//, route =>
      route.fulfill({ status: 404, body: '' })
    )
    await use(github)
    check()
  },
  // After `github`, so these routes win over its catch-all.
  signIn: async ({ page, github: _github }, use) => {
    const signIn = new FakeSignIn()
    await page.route('https://github.com/login/oauth/authorize**', route => signIn.authorize(route))
    await page.route(`${AUTH_WORKER}/**`, route => signIn.worker(route))
    await use(signIn)
  },
  /** Opens the viewer, on `pr` when given. */
  open: async ({ page, viewerOrigin, github: _github }, use) => {
    await use(async pr => {
      await page.goto(pr === undefined ? `${viewerOrigin}/` : `${viewerOrigin}/?pr=${encodeURIComponent(pr)}`)
    })
  },
})
