import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import type { AppContext, VendorRoots } from '../context.js'
import { AppError } from '../errors.js'

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function under(root: string, full: string): boolean {
  return full === root || full.startsWith(root + path.sep)
}

/**
 * Resolves `rel` under `root`, or null when it escapes the root or is not a plain file. The
 * real path is checked as well as the written one, so a symlink inside the root that points
 * outside it names no file either.
 */
export async function resolveUnder(root: string, rel: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    // A malformed percent escape names no file.
    return null
  }
  if (decoded.includes('\0')) {
    return null
  }
  const full = path.resolve(root, decoded)
  if (!under(root, full)) {
    return null
  }
  try {
    const s = await stat(full)
    if (!s.isFile()) {
      return null
    }
    const real = await realpath(full)
    const realRoot = await realpath(root)
    return under(realRoot, real) ? full : null
  } catch {
    return null
  }
}

/**
 * The browser-side libraries, served from node_modules. Single-file libraries map to one exact
 * file; `diff` and `mermaid` ship many ES modules with relative imports, so their directories are
 * served as a whole (JavaScript files only). Mermaid loads the chunk of a diagram type at render
 * time, which is why its whole `dist/` has to be reachable.
 */
export async function resolveVendor(roots: VendorRoots, rel: string): Promise<string | null> {
  const exact: Record<string, string> = {
    'marked.js': roots.marked,
    'purify.js': roots.dompurify,
    'highlight.js': roots.hljs,
    'p5.js': roots.p5,
  }
  const hit = exact[rel]
  if (hit !== undefined) {
    return resolveUnder(path.dirname(hit), path.basename(hit))
  }
  if (rel.startsWith('diff/') && rel.endsWith('.js')) {
    return resolveUnder(roots.diff, rel.slice('diff/'.length))
  }
  if (rel.startsWith('mermaid/') && rel.endsWith('.mjs')) {
    return resolveUnder(roots.mermaid, rel.slice('mermaid/'.length))
  }
  return null
}

/** The scripts the sandboxed sketch frame loads as modules. */
const SKETCH_MODULES = new Set(['js/sketch-host.js', 'js/sketch-kit.js'])

export function staticRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  async function send(file: string, cache: string, headers: Record<string, string> = {}): Promise<Response> {
    const body = await readFile(file)
    return new Response(new Uint8Array(body), {
      headers: { 'content-type': contentTypeFor(file), 'cache-control': cache, ...headers },
    })
  }

  app.get('/static/*', async c => {
    const rel = c.req.path.slice('/static/'.length)
    const file = await resolveUnder(ctx.staticDir, rel)
    if (file === null) {
      throw new AppError('NOT_FOUND', `no static file ${rel}`, 404)
    }
    // The sketch frame's sandbox gives it an opaque origin, so its module scripts load as
    // cross-origin requests. Only these two public files answer them.
    return send(file, 'no-cache', SKETCH_MODULES.has(rel) ? { 'access-control-allow-origin': '*' } : {})
  })

  app.get('/vendor/*', async c => {
    const rel = c.req.path.slice('/vendor/'.length)
    const file = await resolveVendor(ctx.vendorRoots, rel)
    if (file === null) {
      throw new AppError('NOT_FOUND', `no vendored file ${rel}`, 404)
    }
    return send(file, 'public, max-age=86400')
  })

  return app
}
