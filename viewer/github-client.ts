// The GitHub REST API from the browser, with no token: enough for a public repository. It answers
// through the same HostClient interface the server's gh client does, so the server's mappers
// (pull request, comments) run here unchanged.
import { type CliResponse, type HostClient, HostCliError } from '../src/host/client.js'

export const GITHUB_API = 'https://api.github.com'

/** The raw diff media type: `git diff` output between the two commits of a compare. */
const DIFF_MEDIA_TYPE = 'application/vnd.github.diff'

export interface BrowserGithub extends HostClient {
  /** The `git diff` text from `base` to `head`, three-dot: from their merge base. */
  diff(owner: string, repo: string, base: string, head: string): Promise<string>
  /** Asks GitHub again on the next read of anything kept so far, as the page's refresh does. */
  refresh(): void
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
 * against it too. So every GET keeps its answer for the tab: one younger than FRESH_MS is reused
 * as is, and an older one is asked for again with its ETag.
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
function apiError(path: string, res: Response, body: string): HostCliError {
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
    message = `GitHub's anonymous rate limit of 60 requests an hour is used up; it resets at ${at}`
  }
  return new HostCliError('gh', path, `HTTP ${res.status}: ${message}`, 1)
}

export function createBrowserGithub(
  opts: { fetchImpl?: typeof fetch; storage?: Storage | null; now?: () => number } = {}
) {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const cache = etagCache(opts.storage === undefined ? sessionStore() : opts.storage)

  const now = opts.now ?? (() => Date.now())
  /** Answers kept up to this moment are asked for again. */
  let refreshedAt = -1

  async function get(path: string, accept: string): Promise<{ res: Response | null; body: string }> {
    const url = `${GITHUB_API}/${path.replace(/^\//, '')}`
    const cacheKey = `${accept} ${url}`
    const cached = cache.get(cacheKey)
    if (cached !== null && cached.at > refreshedAt && now() - cached.at < FRESH_MS) {
      return { res: null, body: cached.body }
    }
    const headers: Record<string, string> = { accept, 'x-github-api-version': '2022-11-28' }
    if (cached !== null) headers['if-none-match'] = cached.etag
    const res = await doFetch(url, { headers })
    if (res.status === 304 && cached !== null) {
      cache.set(cacheKey, { ...cached, at: now() })
      return { res, body: cached.body }
    }
    const body = await res.text()
    if (!res.ok) throw apiError(path, res, body)
    const etag = res.headers.get('etag')
    if (etag !== null) cache.set(cacheKey, { etag, body, at: now() })
    return { res, body }
  }

  const withQuery = (path: string, params?: Record<string, string>) =>
    params === undefined ? path : `${path}?${new URLSearchParams(params).toString()}`

  const readOnly = (what: string) => () =>
    Promise.reject(new HostCliError('gh', what, 'the read-only viewer does not write to GitHub', 1))

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
    post: readOnly('post'),
    // GraphQL needs a token even for public data; callers degrade without it.
    graphql: readOnly('graphql'),
    authStatus: () => Promise.resolve({ installed: true, authenticated: false, detail: 'anonymous' }),
    authToken: () => Promise.resolve(null),
    async diff(owner, repo, base, head) {
      const { body } = await get(`repos/${owner}/${repo}/compare/${base}...${head}`, DIFF_MEDIA_TYPE)
      return body
    },
    refresh() {
      refreshedAt = now()
    },
  }
  return client
}
