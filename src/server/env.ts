/** What the middleware puts on the request context. Hono types every route from this. */
export interface AppEnv {
  Variables: {
    /** The nonce of this response's inline scripts, set by `responseHeaders`. */
    cspNonce: string
  }
}
