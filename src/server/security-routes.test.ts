// @vitest-environment node
// The security surface of the whole server, checked route by route rather than module by module:
// the Host allowlist, the same-origin rule on every write, the response headers, and the two
// habits the rest of the code has to keep (no shell, no token in a log or a file).
import { readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pr } from '../contract/review-artifact.js'
import { discoverSharedCanvas } from '../host/attachments.js'
import { createFakeGh, makeTempDir, makeTestContext, type TestContext } from '../testing/fakes.js'
import { ghFor42, gitFor42, HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { createApp } from './app.js'
import { PACKAGE_ROOT } from './context.js'
import { contentSecurityPolicy, createNonce } from './security.js'

const LOCAL = { host: 'localhost:3010' }

/** Every route the server answers, with a body where the route needs one. */
const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/review/42' },
  { method: 'GET', path: '/review?n=42' },
  { method: 'GET', path: '/static/styles.css' },
  { method: 'GET', path: '/vendor/marked.js' },
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/prs/42' },
  { method: 'GET', path: '/api/prs/42/patches' },
  { method: 'GET', path: '/api/prs/42/comments' },
  { method: 'GET', path: '/api/prs/42/context?path=src/app.ts&side=new&from=1&to=2' },
  { method: 'GET', path: '/api/prs/42/export' },
  { method: 'GET', path: '/api/prs/42/state' },
  { method: 'GET', path: '/api/prs/42/capabilities' },
  { method: 'GET', path: '/api/prs/42/review/body' },
  { method: 'POST', path: '/api/prs/42/import' },
  { method: 'POST', path: '/api/prs/42/shared-canvas/fetch' },
  { method: 'POST', path: '/api/prs/42/comments', body: { kind: 'issue', body: 'hello' } },
  { method: 'POST', path: '/api/prs/42/review', body: { event: 'REQUEST_CHANGES' } },
  { method: 'PUT', path: '/api/prs/42/reviewed/layer:layer-1', body: { reviewed: true } },
  { method: 'PUT', path: '/api/prs/42/points/abc/dismissed', body: { dismissed: true } },
  { method: 'PUT', path: '/api/prs/42/threads/1001/hidden', body: { hidden: true } },
]

const WRITES = ROUTES.filter(r => r.method !== 'GET')

function request(route: (typeof ROUTES)[number], headers: Record<string, string>): [string, RequestInit] {
  const init: RequestInit = { method: route.method, headers }
  if (route.body !== undefined) {
    init.headers = { ...headers, 'content-type': 'application/json' }
    init.body = JSON.stringify(route.body)
  }
  return [route.path, init]
}

describe('every route', () => {
  let t: TestContext
  beforeEach(async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
  })
  afterEach(async () => {
    await t.cleanup()
  })

  it.each(ROUTES.map(r => [`${r.method} ${r.path}`, r] as const))(
    'refuses %s with a foreign Host',
    async (_n, r) => {
      const app = createApp(t.ctx)
      const res = await app.request(...request(r, { host: 'evil.example' }))
      expect(res.status).toBe(403)
      expect(await res.clone().text()).toContain('FORBIDDEN_HOST')
    }
  )

  it.each(WRITES.map(r => [`${r.method} ${r.path}`, r] as const))(
    'refuses %s from a foreign origin',
    async (_n, r) => {
      const app = createApp(t.ctx)
      const res = await app.request(...request(r, { ...LOCAL, origin: 'https://evil.example' }))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: { code: 'CROSS_ORIGIN', message: 'cross-origin request rejected' },
      })
    }
  )

  it.each(WRITES.map(r => [`${r.method} ${r.path}`, r] as const))(
    'refuses %s from a cross site',
    async (_n, r) => {
      const app = createApp(t.ctx)
      const res = await app.request(...request(r, { ...LOCAL, 'sec-fetch-site': 'cross-site' }))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: { code: 'CROSS_ORIGIN', message: 'cross-site request rejected' },
      })
    }
  )

  it.each(ROUTES.map(r => [`${r.method} ${r.path}`, r] as const))(
    'sends the header set on %s',
    async (_n, r) => {
      const app = createApp(t.ctx)
      const res = await app.request(...request(r, { ...LOCAL, origin: 'http://localhost:3010' }))
      // A route that no longer exists would answer the router's own 404, and every check below
      // would pass on it, so the table would go on testing a route the server dropped.
      expect(await res.clone().text()).not.toContain(`no route for ${r.method} ${r.path.split('?')[0]}`)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      if (r.path.startsWith('/api/')) {
        expect(res.headers.get('cache-control')).toBe('no-store')
      }
      const html = (res.headers.get('content-type') ?? '').startsWith('text/html')
      expect(res.headers.get('content-security-policy')).toBe(
        html ? contentSecurityPolicy(nonceOf(await res.clone().text())) : null
      )
    }
  )
})

/** The nonce the page put on its inline scripts, so the policy can be compared against it. */
function nonceOf(html: string): string {
  return /nonce="([^"]+)"/.exec(html)?.[1] ?? ''
}

describe('content security policy', () => {
  let t: TestContext
  beforeEach(async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
  })
  afterEach(async () => {
    await t.cleanup()
  })

  it('allows only this origin, nonced inline scripts, and inline styles', () => {
    expect(contentSecurityPolicy('abc')).toBe(
      "default-src 'none'; script-src 'self' 'nonce-abc'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; font-src 'self'; connect-src 'self'; form-action 'self'; " +
        "base-uri 'none'; frame-ancestors 'none'; object-src 'none'"
    )
  })

  it('gives each page a fresh nonce and puts it on every inline script', async () => {
    const app = createApp(t.ctx)
    const first = await (await app.request('/review/42', { headers: LOCAL })).text()
    const second = await (await app.request('/review/42', { headers: LOCAL })).text()
    const nonce = nonceOf(first)
    expect(nonce).not.toBe('')
    expect(nonceOf(second)).not.toBe(nonce)
    // Two inline blocks: the import map and the bootstrap JSON. The skin and the theme are
    // rendered onto <html>, so the page runs no inline script of its own.
    expect([...first.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map(m => m[0])).toEqual([
      `<script type="importmap" nonce="${nonce}">`,
      `<script id="bootstrap" type="application/json" nonce="${nonce}">`,
    ])
    expect(first).not.toContain('onsubmit=')
  })

  it('carries no inline event handler on the home page, whose form posts to a redirect', async () => {
    const app = createApp(t.ctx)
    const home = await (await app.request('/', { headers: LOCAL })).text()
    expect(home).toContain('<form class="body home-form" method="get" action="/review">')
    expect(/\son[a-z]+=/.test(home)).toBe(false)
    const redirect = await app.request('/review?n=42', { headers: LOCAL })
    expect(redirect.status).toBe(303)
    expect(redirect.headers.get('location')).toBe('/review/42')
    // An empty form lands on /review/ , which the number check turns into a 400 with the hint.
    const empty = await app.request('/review', { headers: LOCAL })
    expect(empty.headers.get('location')).toBe('/review/')
  })

  it('sends the header set with an error page and an error envelope too', async () => {
    const app = createApp(t.ctx)
    const page = await app.request('/nope', { headers: LOCAL })
    expect(page.status).toBe(404)
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const api = await app.request('/api/nope', { headers: LOCAL })
    expect(api.status).toBe(404)
    expect(api.headers.get('cache-control')).toBe('no-store')
    expect(api.headers.get('content-security-policy')).toBeNull()
    const forbidden = await app.request('/', { headers: { host: 'evil' } })
    expect(forbidden.headers.get('referrer-policy')).toBe('no-referrer')
    expect(forbidden.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-")
  })

  it('makes a different nonce every time', () => {
    expect(createNonce()).not.toBe(createNonce())
  })
})

describe('the static route', () => {
  let t: TestContext
  afterEach(async () => {
    await t.cleanup()
  })

  it('serves no file a symlink inside the root points at outside it', async () => {
    const root = await makeTempDir()
    const outside = path.join(await makeTempDir(), 'secret.txt')
    await writeFile(outside, 'not yours', 'utf8')
    await writeFile(path.join(root, 'real.css'), 'body{}', 'utf8')
    await symlink(outside, path.join(root, 'leak.css'))
    t = await makeTestContext()
    t.ctx.staticDir = root
    const app = createApp(t.ctx)
    const ok = await app.request('/static/real.css', { headers: LOCAL })
    expect(ok.status).toBe(200)
    const leak = await app.request('/static/leak.css', { headers: LOCAL })
    expect(leak.status).toBe(404)
    expect(await leak.text()).not.toContain('not yours')
  })
})

describe('the gh token', () => {
  let t: TestContext
  afterEach(async () => {
    await t.cleanup()
  })

  it('reaches github and nothing else: no log line, no error, no file under the data dir', async () => {
    const secret = 'ghp_SECRET_TOKEN_VALUE_0123456789'
    const seen: string[] = []
    for (const stream of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => {
        seen.push(args.map(String).join(' '))
      })
    }
    const sentAuth: string[] = []
    // github.com answers with a redirect to signed storage, which is where a forwarded token
    // would land. Both hops are recorded so the second one can be checked for it.
    const storage = 'https://objects.githubusercontent.com/signed/abc'
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      sentAuth.push(`${url} ${headers.get('authorization') ?? 'none'}`)
      return url === storage
        ? new Response('not a zip', { status: 200 })
        : new Response('', { status: 302, headers: { location: storage } })
    }) as typeof fetch
    t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42({ token: secret }),
      fetch: fetchImpl,
    })
    const app = createApp(t.ctx)
    const bundle = (await (await app.request('/api/prs/42', { headers: LOCAL })).json()) as { pr: Pr }
    const pr: Pr = {
      ...bundle.pr,
      body: 'canvas: https://github.com/user-attachments/files/1/pr-42-20260910T110000Z-11111111-acme-widgets-canvas.zip',
    }
    const comments = { fetchedAt: '', headSha: HEAD_SHA, reviewComments: [], issueComments: [] }
    const outcome = await discoverSharedCanvas(t.ctx, pr, comments)
    expect(outcome.sharedCanvas?.reason).toBe('not-zip')
    expect(sentAuth).toEqual([
      `https://github.com/user-attachments/files/1/pr-42-20260910T110000Z-11111111-acme-widgets-canvas.zip token ${secret}`,
      `${storage} none`,
    ])
    expect(seen.join('\n')).not.toContain(secret)
    for (const file of await filesUnder(t.dataDir)) {
      expect(await readFile(file, 'utf8')).not.toContain(secret)
    }
    vi.restoreAllMocks()
  })

  it('never lands in a message when the download fails', async () => {
    const secret = 'ghp_ANOTHER_SECRET_0123456789'
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch
    t = await makeTestContext({ git: gitFor42(), gh: createFakeGh({ token: secret }), fetch: fetchImpl })
    const pr: Pr = {
      ...syntheticArtifact().pr,
      body: 'https://github.com/user-attachments/files/9/pr-42-20260910T110000Z-11111111-acme-widgets-canvas.zip',
    }
    const outcome = await discoverSharedCanvas(t.ctx, pr, {
      fetchedAt: '',
      headSha: HEAD_SHA,
      reviewComments: [],
      issueComments: [],
    })
    expect(JSON.stringify(outcome)).not.toContain(secret)
  })
})

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name)
    const s = await stat(full)
    out.push(...(s.isDirectory() ? await filesUnder(full) : [full]))
  }
  return out
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name)
    const s = await stat(full)
    if (s.isDirectory()) {
      out.push(...(await sourceFiles(full)))
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * What each file may import from `child_process`. Types are not runtime behaviour, so only the
 * value bindings are listed. Every other file gets `execFile` and nothing else.
 *
 * The acpx adapter streams a running turn, which execFile cannot do, so it uses `spawn`. The
 * browser opener detaches its child, so a browser it starts outlives Ctrl-C on the server. Both
 * take an argument array and neither starts a shell, so the rule this scan enforces is "no
 * command line", not "one function". A file that may import `spawn` may call it.
 */
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  'src/acpx/acpx.ts': ['execFile', 'spawn'],
  'src/server/open-browser.ts': ['spawn'],
}
const DEFAULT_ALLOWED_IMPORTS = ['execFile']

/** The value bindings of one import statement, with the `type` ones left out. */
function valueBindings(statement: string): string[] {
  const inner = /import\s*\{([^}]*)\}/.exec(statement)?.[1] ?? statement
  return inner
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '' && !part.startsWith('type '))
    .map(part => part.split(/\s+as\s+/)[0] ?? part)
    .sort()
}

describe('child processes', () => {
  it('runs child processes through argument arrays, never through a shell', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles(path.join(PACKAGE_ROOT, 'src'))) {
      const text = await readFile(file, 'utf8')
      const rel = path.relative(PACKAGE_ROOT, file)
      // A command line is what makes injection possible: `exec` and `spawn` take one, and
      // `shell: true` turns execFile into one. The names that do it all come from child_process,
      // so the import list below is the real check and these patterns catch the rest.
      const bads = [
        /(?<![.\w])execSync\s*\(/,
        ...(ALLOWED_IMPORTS[rel]?.includes('spawn') === true ? [] : [/(?<![.\w])spawn\s*\(/]),
        /(?<![.\w])spawnSync\s*\(/,
        /shell\s*:\s*true/,
        /require\(['"](?:node:)?child_process['"]\)/,
        /import\(\s*['"](?:node:)?child_process['"]\s*\)/,
      ]
      for (const bad of bads) {
        if (bad.test(text)) {
          offenders.push(`${rel}: ${bad.source}`)
        }
      }
      // The whole statement, however it is written: the scan walks back from the module name to
      // the `import` that starts its line, so a namespace import or a wrapped one is read too.
      for (const m of text.matchAll(/from '(?:node:)?child_process'/g)) {
        const start = text.lastIndexOf('\nimport', m.index)
        const statement = text
          .slice(start + 1, m.index + m[0].length)
          .replace(/\s+/g, ' ')
          .trim()
        const allowed = [...(ALLOWED_IMPORTS[rel] ?? DEFAULT_ALLOWED_IMPORTS)].sort()
        if (!statement.startsWith('import {') || valueBindings(statement).join(',') !== allowed.join(',')) {
          offenders.push(`${rel}: ${statement}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
