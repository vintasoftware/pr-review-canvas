// The GitHub REST API from the browser: anonymous for a public repository, or with the reader's
// GitHub App token once they sign in. It answers through the same HostClient interface the
// server's gh client does, so the server's mappers (pull request, comments) run here unchanged.
import { type CliResponse, type HostClient, HostCliError } from '../src/host/client.js'

export const GITHUB_API = 'https://api.github.com'

/** The raw diff media type: `git diff` output between the two commits of a compare. */
const DIFF_MEDIA_TYPE = 'application/vnd.github.diff'

export interface BrowserGithub extends HostClient {
  /** The `git diff` text from `base` to `head`, three-dot: from their merge base. */
  diff(owner: string, repo: string, base: string, head: string): Promise<string>
  /** Asks GitHub again on the next read of anything kept so far, as the page's refresh does. */
  refresh(): void
  /** Like `api`, but asks GitHub now, however recent the answer kept for `path` is. */
  apiFresh(path: string): Promise<unknown>
}

export interface BrowserGithubOptions {
  fetchImpl?: typeof fetch
  /** Where anonymous answers are kept across reloads; sessionStorage by default. */
  storage?: Storage | null
  now?: () => number
  /** The reader's token, or null to read anonymously. Asked before every request. */
  token?: () => Promise<string | null>
  /** GitHub refused the token: it expired early or was revoked. */
  onUnauthorized?: () => void
}

interface Cached {
  etag: string
  body: string
  /** When GitHub last answered for this URL, in epoch milliseconds. */
  at: number
}

/** How long an answer is reused without asking GitHub. */
export const FRESH_MS = 5 * 60 * 1000

/**
 * The anonymous rate limit is 60 requests an hour per address, and GitHub counts an anonymous 304
 * against it too. So every GET keeps its answer: one younger than FRESH_MS is reused as is, and an
 * older one is asked for again with its ETag. With no storage, answers last as long as the page.
 */
function etagCache(storage: Storage | null) {
  const memory = new Map<string, Cached>()
  const key = (url: string) => `pr-review-viewer:etag:${url}`
  return {
    get(url: string): Cached | null {
      const hit = memory.get(url)
      if (hit !== undefined) return hit
      try {
        const raw = storage?.getItem(key(url))
        return raw ? (JSON.parse(raw) as Cached) : null
      } catch {
        return null
      }
    },
    set(url: string, value: Cached): void {
      memory.set(url, value)
      try {
        storage?.setItem(key(url), JSON.stringify(value))
      } catch {
        // A full or blocked storage only costs the next load a request.
      }
    },
    clear(): void {
      memory.clear()
    },
  }
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/** The error the server's gh client would throw, so `notFound` and friends read the same. */
function apiError(path: string, res: Response, body: string, signedIn: boolean): HostCliError {
  let message = body
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
  } catch {
    // Not JSON: keep the text.
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const at = Number.isFinite(reset) ? new Date(reset * 1000).toLocaleTimeString() : 'within the hour'
    message = signedIn
      ? `GitHub's rate limit for your account is used up; it resets at ${at}`
      : `GitHub's anonymous rate limit of 60 requests an hour is used up; sign in, or wait until ${at}`
  }
  if (res.status === 401 && signedIn) {
    message = 'GitHub no longer accepts your sign-in; sign in again'
  }
  return new HostCliError('gh', path, `HTTP ${res.status}: ${message}`, 1)
}

export function createBrowserGithub(opts: BrowserGithubOptions = {}) {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const tokenOf = opts.token ?? (() => Promise.resolve(null))
  const anonymous = etagCache(opts.storage === undefined ? sessionStore() : opts.storage)
  // A signed-in reader may read private code: those answers stay in this page's memory only.
  const signedIn = etagCache(null)
  let lastToken: string | null = null

  const now = opts.now ?? (() => Date.now())
  /** Answers kept up to this moment are asked for again. */
  let refreshedAt = -1

  /** The headers of one request, and the cache its answers belong to. */
  async function session(accept: string) {
    const token = await tokenOf()
    // Another reader, or the same one signed in again, must not see the last one's answers.
    if (token !== lastToken) {
      signedIn.clear()
      lastToken = token
    }
    const headers: Record<string, string> = { accept, 'x-github-api-version': '2022-11-28' }
    if (token !== null) headers['authorization'] = `Bearer ${token}`
    return { headers, cache: token === null ? anonymous : signedIn, token }
  }

  function failed(path: string, res: Response, body: string, token: string | null): HostCliError {
    if (res.status === 401 && token !== null) opts.onUnauthorized?.()
    return apiError(path, res, body, token !== null)
  }

  async function get(
    path: string,
    accept: string,
    fresh = false
  ): Promise<{ res: Response | null; body: string }> {
    const url = `${GITHUB_API}/${path.replace(/^\//, '')}`
    const cacheKey = `${accept} ${url}`
    const { headers, cache, token } = await session(accept)
    const cached = cache.get(cacheKey)
    if (!fresh && cached !== null && cached.at > refreshedAt && now() - cached.at < FRESH_MS) {
      return { res: null, body: cached.body }
    }
    if (cached !== null) headers['if-none-match'] = cached.etag
    const res = await doFetch(url, { headers })
    if (res.status === 304 && cached !== null) {
      cache.set(cacheKey, { ...cached, at: now() })
      return { res, body: cached.body }
    }
    const body = await res.text()
    if (!res.ok) throw failed(path, res, body, token)
    const etag = res.headers.get('etag')
    if (etag !== null) cache.set(cacheKey, { etag, body, at: now() })
    return { res, body }
  }

  const withQuery = (path: string, params?: Record<string, string>) =>
    params === undefined ? path : `${path}?${new URLSearchParams(params).toString()}`

  const client: BrowserGithub = {
    async api(path, params) {
      const { body } = await get(withQuery(path, params), 'application/vnd.github+json')
      return JSON.parse(body) as unknown
    },
    async apiWithHeaders(path): Promise<CliResponse> {
      const { res, body } = await get(path, 'application/vnd.github+json')
      const headers: Record<string, string> = {}
      res?.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value
      })
      return { status: res?.status ?? 200, headers, body: JSON.parse(body) as unknown }
    },
    /**
     * Writes as the signed-in reader. Everything kept so far is asked for again afterwards, so the
     * page sees what it just posted.
     */
    async post(path, body, method = 'POST') {
      const { headers, token } = await session('application/vnd.github+json')
      if (token === null) {
        throw new HostCliError('gh', path, 'HTTP 401: sign in with GitHub to post', 1)
      }
      const res = await doFetch(`${GITHUB_API}/${path.replace(/^\//, '')}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw failed(path, res, text, token)
      refreshedAt = now()
      return text === '' ? null : (JSON.parse(text) as unknown)
    },
    // GraphQL needs a token even for public data; anonymous callers degrade without it.
    async graphql(query, variables) {
      const { headers, token } = await session('application/json')
      if (token === null) throw new HostCliError('gh', 'graphql', 'GraphQL needs a signed-in reader', 1)
      const res = await doFetch(`${GITHUB_API}/graphql`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      const body = await res.text()
      if (!res.ok) throw failed('graphql', res, body, token)
      const parsed = JSON.parse(body) as { data?: unknown; errors?: Array<{ message?: unknown }> }
      if (parsed.errors?.length) {
        const message = parsed.errors.map(e => String(e.message)).join('; ')
        throw new HostCliError('gh', 'graphql', message, 1)
      }
      return parsed.data
    },
    async authStatus() {
      const token = await tokenOf()
      return {
        installed: true,
        authenticated: token !== null,
        detail: token === null ? 'anonymous' : 'signed in',
      }
    },
    authToken: () => tokenOf(),
    async diff(owner, repo, base, head) {
      const { body } = await get(`repos/${owner}/${repo}/compare/${base}...${head}`, DIFF_MEDIA_TYPE)
      return body
    },
    refresh() {
      refreshedAt = now()
    },
    async apiFresh(path) {
      const { body } = await get(path, 'application/vnd.github+json', true)
      return JSON.parse(body) as unknown
    },
  }
  return client
}
