import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { handleAuth } from '../worker/auth-worker.ts'

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
 * The auth Worker inside the dev server, at `/__auth`, so sign-in works with `pnpm viewer:dev` and
 * no Cloudflare account. It reads GITHUB_CLIENT_SECRET from viewer/.env.local, which only this
 * server process sees: names without the VITE_ prefix never reach the page or the build.
 */
function devAuthWorker(env) {
  return {
    name: 'viewer-dev-auth-worker',
    configureServer(server) {
      if (!env.GITHUB_CLIENT_SECRET || !env.VITE_GITHUB_CLIENT_ID) return
      const origin = `http://${server.config.server.host}:${server.config.server.port}`
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
    },
  }
}

export default defineConfig(({ mode }) => ({
  root: here,
  base: '/',
  plugins: [brandIcon(), devAuthWorker(loadEnv(mode, here, ''))],
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
}))
