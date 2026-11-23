import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { handleAuth } from '../worker/auth-worker.ts'
import { headersFile, viewerHeaders } from './headers.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const brand = fileURLToPath(new URL('../static/brand.svg', import.meta.url))

/** The header links `/static/brand.svg`, which the local server serves; the viewer ships it too. */
function brandIcon() {
  return {
    name: 'viewer-brand-icon',
    configureServer(server) {
      server.middlewares.use('/static/brand.svg', (_req, res) => {
        res.setHeader('content-type', 'image/svg+xml')
        res.end(readFileSync(brand))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'static/brand.svg', source: readFileSync(brand) })
    },
  }
}

/**
 * The response headers Cloudflare Pages sends, written to `_headers` in the build. `pnpm
 * viewer:preview` sends them too, so the built page is tried under its real policy.
 */
function securityHeaders(env) {
  const opts = { workerUrl: env.VITE_AUTH_WORKER_URL }
  return {
    name: 'viewer-security-headers',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile(opts) })
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(viewerHeaders(opts))) {
          // A plain http preview cannot carry HSTS; the hosted page is https.
          if (name !== 'Strict-Transport-Security') res.setHeader(name, value)
        }
        next()
      })
    },
  }
}

/** The commit the build is made from, so the page can say which code is running. */
function buildCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * The auth Worker inside the dev and preview servers, at `/__auth`, so sign-in works with `pnpm
 * viewer:dev` or `pnpm viewer:preview` and no Cloudflare account. It reads GITHUB_CLIENT_SECRET from
 * viewer/.env.local, which only this server process sees: names without the VITE_ prefix never
 * reach the page or the build.
 */
function devAuthWorker(env) {
  const mount = (server, listen) => {
    if (!env.GITHUB_CLIENT_SECRET || !env.VITE_GITHUB_CLIENT_ID) return
    {
      const origin = `http://${listen.host}:${listen.port}`
      const workerEnv = {
        GITHUB_CLIENT_ID: env.VITE_GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
        ALLOWED_ORIGINS: origin,
      }
      const answerAuth = async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }
        const request = new Request(`${origin}/__auth${req.url}`, {
          method: req.method,
          headers,
          ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
        })
        const answer = await handleAuth(request, workerEnv)
        res.statusCode = answer.status
        answer.headers.forEach((value, name) => res.setHeader(name, value))
        res.end(Buffer.from(await answer.arrayBuffer()))
      }
      server.middlewares.use('/__auth', (req, res) => {
        answerAuth(req, res).catch(() => {
          res.statusCode = 500
          res.end()
        })
      })
    }
  }
  return {
    name: 'viewer-dev-auth-worker',
    configureServer: server => mount(server, server.config.server),
    configurePreviewServer: server => mount(server, server.config.preview),
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, '')
  return {
    root: here,
    base: '/',
    plugins: [brandIcon(), securityHeaders(env), devAuthWorker(env)],
    define: { 'import.meta.env.VITE_VIEWER_COMMIT': JSON.stringify(buildCommit()) },
    resolve: {
      alias: {
        // The local server's import map names this file `hljs`.
        hljs: '@highlightjs/cdn-assets/es/highlight.min.js',
        'node:child_process': fileURLToPath(new URL('./node-stub.ts', import.meta.url)),
      },
    },
    build: {
      outDir: '../dist-viewer',
      emptyOutDir: true,
    },
    server: { host: '127.0.0.1', port: 4174, strictPort: true },
    preview: { host: '127.0.0.1', port: 4174, strictPort: true },
  }
})
