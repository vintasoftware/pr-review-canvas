import { randomBytes } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './env.js'
import { AppError } from './errors.js'

const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The hostname part of a Host header (`localhost:3010` → `localhost`, `[::1]:3010` → `[::1]`). */
export function hostnameOf(host: string): string {
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim())
  return m?.[1]?.toLowerCase() ?? ''
}

export function isAllowedHost(host: string | undefined): host is string {
  return host !== undefined && ALLOWED_HOSTNAMES.has(hostnameOf(host))
}

/** Origin must name this very server. `null` (opaque origin) is rejected too. */
export function isSameOrigin(origin: string | undefined, host: string): boolean {
  if (origin === undefined) {
    return true
  }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return url.host.toLowerCase() === host.toLowerCase() && isAllowedHost(url.host)
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Two checks. The Host allowlist stops DNS rebinding: a page on an attacker's domain that
 * resolves to 127.0.0.1 sends its own hostname. The same-origin check on state-changing methods
 * stops cross-site requests, because this server can post to GitHub as the user.
 */
export const securityMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const host = c.req.header('host')
  if (!isAllowedHost(host)) {
    throw new AppError('FORBIDDEN_HOST', 'this server only answers to localhost', 403)
  }
  if (!SAFE_METHODS.has(c.req.method)) {
    const site = c.req.header('sec-fetch-site')
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new AppError('CROSS_ORIGIN', 'cross-site request rejected', 403)
    }
    if (!isSameOrigin(c.req.header('origin'), host)) {
      throw new AppError('CROSS_ORIGIN', 'cross-origin request rejected', 403)
    }
  }
  await next()
}

/**
 * The page's own scripts and styles, nothing else. Inline styles are allowed because the page
 * sets dynamic values that way (progress width, layer stripe colors) and mermaid injects a style
 * element per drawing; inline scripts are not, except the two the shell carries under its nonce.
 */
export function contentSecurityPolicy(nonce: string, opts: { frames?: boolean } = {}): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    // The deck page frames its card sketches from this server; a sketch frame that navigates
    // anywhere else is blocked by this too.
    ...(opts.frames === true ? ["frame-src 'self'"] : []),
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ')
}

/** The page a card's sketch runs in. */
export const SKETCH_FRAME_PATH = '/deck-sketch'

/**
 * The sketch frame's policy. Sketches are generated code, so the frame is sandboxed by its own
 * header as well as by the iframe attribute (an opaque origin: no cookies, storage, or access to
 * the deck page), may reach no network, and may be framed only by this server's pages. Evaluating
 * the sketch needs 'unsafe-eval', which is why the sketch never runs in the deck page itself.
 */
export function sketchFramePolicy(): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "object-src 'none'",
  ].join('; ')
}

/** A fresh nonce per HTML response, so the shell's inline scripts run and nothing else does. */
export function createNonce(): string {
  return randomBytes(16).toString('base64')
}

/**
 * Headers every answer carries. `no-store` on the API keeps PR text, comments, and canvases out
 * of any cache; HTML pages carry the policy above.
 */
export function applyResponseHeaders(res: Response, path: string, nonce: string): void {
  res.headers.set('x-content-type-options', 'nosniff')
  res.headers.set('referrer-policy', 'no-referrer')
  if (path.startsWith('/api/')) {
    res.headers.set('cache-control', 'no-store')
  }
  if ((res.headers.get('content-type') ?? '').startsWith('text/html')) {
    res.headers.set(
      'content-security-policy',
      path === SKETCH_FRAME_PATH
        ? sketchFramePolicy()
        : contentSecurityPolicy(nonce, { frames: path.startsWith('/deck/') })
    )
  }
}

/**
 * Puts the headers on every answer of the normal path. Errors never reach the code after
 * `next()`, so `createApp` applies the same headers to what its error handlers build.
 */
export const responseHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('cspNonce', createNonce())
  await next()
  applyResponseHeaders(c.res, c.req.path, c.get('cspNonce'))
}
