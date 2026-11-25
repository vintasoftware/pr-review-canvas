// GitHub sign-in for the viewer: the authorization-code flow with PKCE, finished by the auth Worker
// (worker/auth-worker.ts), which holds the app's client secret. The token and its refresh token
// live in sessionStorage, so they end with the tab (ADR 0005), and are refreshed before they expire.

export interface AuthConfig {
  /** The GitHub App's client ID. */
  clientId: string
  /** Where the auth Worker answers, as `https://auth.example.com`. */
  workerUrl: string
}

export interface AuthSession {
  accessToken: string
  /** Epoch milliseconds; null when GitHub issued a token that does not expire. */
  expiresAt: number | null
  refreshToken: string | null
  refreshExpiresAt: number | null
}

/** A sign-in started on this tab, waiting for GitHub to redirect back. */
interface Pending {
  state: string
  verifier: string
  returnTo: string
  at: number
}

export type CallbackResult =
  | { status: 'none' }
  | { status: 'signed-in'; returnTo: string }
  | { status: 'failed'; error: string; returnTo: string }

const SESSION_KEY = 'pr-review-viewer:auth'
const PENDING_KEY = 'pr-review-viewer:auth-pending'
/** A sign-in not finished within this long is dropped. */
const PENDING_MS = 10 * 60 * 1000
/** A token this close to expiring is refreshed before use. */
const REFRESH_MARGIN_MS = 60 * 1000
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
/**
 * What `token()` throws when the access token has expired and its renewal failed in a way worth
 * retrying. The reader stays signed in, and the request fails instead of going out anonymously,
 * where a private repository would read as not found.
 */
export class RenewalPendingError extends Error {
  constructor() {
    super("GitHub sign-in can't be renewed right now; try again in a moment")
    this.name = 'RenewalPendingError'
  }
}

/**
 * Why the Worker gave no token. `retry` when the code or refresh token was most likely not spent:
 * the request never reached the Worker, or the Worker or GitHub's token endpoint failed (a 5xx,
 * `github_unavailable` among them). A token GitHub did spend fails the retry as a refusal.
 */
interface WorkerFailure {
  error: string
  retry: boolean
}

export interface AuthDeps {
  storage: Storage | null
  fetchImpl: typeof fetch
  now: () => number
  /** Fills a buffer with secure random bytes. */
  randomBytes: (length: number) => Uint8Array
  sha256: (data: Uint8Array) => Promise<ArrayBuffer>
}

function browserDeps(): AuthDeps {
  let storage: Storage | null = null
  try {
    storage = globalThis.sessionStorage ?? null
  } catch {
    storage = null
  }
  return {
    storage,
    fetchImpl: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
    sha256: data => crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>),
  }
}

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function readJson<T>(storage: Storage | null, key: string): T | null {
  try {
    const raw = storage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(storage: Storage | null, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Without storage the session lasts as long as the page.
  }
}

/** The token answer the Worker sends, as a session from `now`. */
function toSession(body: unknown, now: number): AuthSession | null {
  if (body === null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b['accessToken'] !== 'string') return null
  const until = (s: unknown) => (typeof s === 'number' && s > 0 ? now + s * 1000 : null)
  return {
    accessToken: b['accessToken'],
    expiresAt: until(b['expiresIn']),
    refreshToken: typeof b['refreshToken'] === 'string' ? b['refreshToken'] : null,
    refreshExpiresAt: until(b['refreshTokenExpiresIn']),
  }
}

export function createAuth(config: AuthConfig, deps: AuthDeps = browserDeps()) {
  const worker = config.workerUrl.replace(/\/+$/, '')
  let session: AuthSession | null = readJson<AuthSession>(deps.storage, SESSION_KEY)
  let refreshing: Promise<AuthSession | null> | null = null
  const listeners = new Set<() => void>()
  /** Told when the session ends without the reader signing out: GitHub refused to renew it. */
  const lost = new Set<() => void>()

  const save = (next: AuthSession | null) => {
    session = next
    writeJson(deps.storage, SESSION_KEY, next)
    for (const listener of listeners) listener()
  }

  async function postWorker(path: string, body: unknown): Promise<AuthSession | WorkerFailure> {
    let res: Response
    try {
      res = await deps.fetchImpl(`${worker}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      return { error: 'the sign-in service could not be reached', retry: true }
    }
    const answer: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code = (answer as { error?: unknown } | null)?.error
      return {
        error: typeof code === 'string' ? code : `the sign-in service answered ${res.status}`,
        retry: res.status >= 500,
      }
    }
    return toSession(answer, deps.now()) ?? { error: 'the sign-in service sent no token', retry: false }
  }

  async function refresh(): Promise<AuthSession | null> {
    const current = session
    if (current === null || current.refreshToken === null) return null
    const next =
      current.refreshExpiresAt !== null && current.refreshExpiresAt <= deps.now()
        ? { error: 'the refresh token expired', retry: false }
        : await postWorker('/refresh', { refreshToken: current.refreshToken })
    if ('retry' in next && next.retry) {
      // The refresh token most likely still works: keep the session for the next request to
      // retry, and use the access token meanwhile while GitHub still takes it.
      if (current.expiresAt !== null && current.expiresAt > deps.now()) return current
      throw new RenewalPendingError()
    }
    // A refresh token works once: a refresh GitHub refused leaves nothing to retry with.
    const failed = 'retry' in next
    save(failed ? null : next)
    if (failed) {
      for (const listener of lost) listener()
      return null
    }
    return next
  }

  return {
    /** Starts a sign-in: keeps its state and verifier, and returns GitHub's authorize URL. */
    async signInUrl(redirectUri: string, returnTo: string): Promise<string> {
      const state = base64Url(deps.randomBytes(24))
      const verifier = base64Url(deps.randomBytes(32))
      const challenge = base64Url(new Uint8Array(await deps.sha256(new TextEncoder().encode(verifier))))
      const pending: Pending = { state, verifier, returnTo, at: deps.now() }
      writeJson(deps.storage, PENDING_KEY, pending)
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      return `${AUTHORIZE_URL}?${params.toString()}`
    },

    /**
     * Finishes a sign-in when `url` is GitHub's redirect back: checks the state, trades the code
     * through the Worker, and keeps the session. `none` when the URL is no such redirect.
     */
    async completeSignIn(url: URL, redirectUri: string): Promise<CallbackResult> {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const denied = url.searchParams.get('error')
      if (state === null || (code === null && denied === null)) return { status: 'none' }
      const pending = readJson<Pending>(deps.storage, PENDING_KEY)
      writeJson(deps.storage, PENDING_KEY, null)
      const returnTo = pending?.returnTo ?? '/'
      if (pending === null || pending.state !== state || deps.now() - pending.at > PENDING_MS) {
        return {
          status: 'failed',
          error: 'the sign-in did not start on this tab, or took too long; try again',
          returnTo,
        }
      }
      if (denied !== null || code === null) {
        return {
          status: 'failed',
          error:
            denied === 'access_denied' ? 'GitHub sign-in was cancelled' : `GitHub sign-in failed: ${denied}`,
          returnTo,
        }
      }
      const next = await postWorker('/token', { code, codeVerifier: pending.verifier, redirectUri })
      if ('retry' in next)
        return { status: 'failed', error: `GitHub sign-in failed: ${next.error}`, returnTo }
      save(next)
      return { status: 'signed-in', returnTo }
    },

    /**
     * The token to send to GitHub, refreshed first when it is about to expire; null when signed
     * out. Throws `RenewalPendingError` while an expired token's renewal is being retried.
     */
    async token(): Promise<string | null> {
      const current = session
      if (current === null) return null
      if (current.expiresAt === null || current.expiresAt - REFRESH_MARGIN_MS > deps.now()) {
        return current.accessToken
      }
      refreshing ??= refresh().finally(() => {
        refreshing = null
      })
      return (await refreshing)?.accessToken ?? null
    },

    signedIn: (): boolean => session !== null,

    /** Forgets the tokens on this tab. GitHub keeps the app authorized until the user revokes it. */
    signOut(): void {
      save(null)
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * Calls `listener` when the session ends because it could not be renewed, as after the reader
     * revoked the app on GitHub, so the page can say why it reads anonymously now.
     */
    onLost(listener: () => void): () => void {
      lost.add(listener)
      return () => lost.delete(listener)
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
