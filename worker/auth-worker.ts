// The one step of GitHub sign-in a static page cannot do: trading an authorization code, or a
// refresh token, for a user access token, which GitHub only does with the app's client secret.
// See docs/adr/0005-static-read-only-viewer.md. The Worker keeps the secret and nothing else: it
// stores no token, logs nothing, proxies no API traffic, and answers only the viewer's origins.

export interface AuthEnv {
  /** The GitHub App's client ID. Public: the viewer sends it to GitHub's authorize page too. */
  GITHUB_CLIENT_ID: string
  /** The GitHub App's client secret. A Worker secret, never a plain variable. */
  GITHUB_CLIENT_SECRET: string
  /** The viewer origins allowed to call, comma separated, as `https://viewer.example.com`. */
  ALLOWED_ORIGINS: string
}

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
/** Codes, verifiers and refresh tokens are short; anything larger is not a sign-in. */
const MAX_BODY_BYTES = 4096
const TOKEN_FIELD = /^[A-Za-z0-9._~-]{1,512}$/

/** What the viewer keeps: the token, the refresh token, and how long each lasts, in seconds. */
export interface TokenAnswer {
  accessToken: string
  expiresIn: number | null
  refreshToken: string | null
  refreshTokenExpiresIn: number | null
}

function allowedOrigins(env: AuthEnv): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(',')
      .map(origin => origin.trim())
      .filter(origin => origin !== '')
  )
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

function answer(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(origin === null ? {} : corsHeaders(origin)),
    },
  })
}

const refuse = (status: number, error: string, origin: string | null) => answer(status, { error }, origin)

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) return null
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const field = (body: Record<string, unknown>, name: string): string | null => {
  const value = body[name]
  return typeof value === 'string' && TOKEN_FIELD.test(value) ? value : null
}

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

/** GitHub's token endpoint answers 200 even on failure, with `error` in the body. */
async function exchange(
  params: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<TokenAnswer | string> {
  const res = await fetchImpl(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  // GitHub answers 404 for a client ID it does not know: the Worker's configuration is wrong.
  if (res.status === 404) return 'unknown_client'
  if (!res.ok) return 'github_unavailable'
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (body === null) return 'github_unavailable'
  if (typeof body['error'] === 'string')
    return TOKEN_FIELD.test(body['error']) ? body['error'] : 'github_error'
  if (typeof body['access_token'] !== 'string') return 'github_error'
  return {
    accessToken: body['access_token'],
    expiresIn: seconds(body['expires_in']),
    refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
    refreshTokenExpiresIn: seconds(body['refresh_token_expires_in']),
  }
}

/**
 * `POST /token` with `{ code, codeVerifier, redirectUri }` after GitHub redirects back, and
 * `POST /refresh` with `{ refreshToken }` before the token runs out. Both answer a TokenAnswer, or
 * `{ error }` with GitHub's error code (as `bad_verification_code`) and never its description.
 */
export async function handleAuth(
  request: Request,
  env: AuthEnv,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin === null || !allowedOrigins(env).has(origin)) {
    return refuse(403, 'origin_not_allowed', null)
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  if (request.method !== 'POST' || (!path.endsWith('/token') && !path.endsWith('/refresh'))) {
    return refuse(404, 'not_found', origin)
  }
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return refuse(415, 'json_required', origin)
  }
  const body = await readJson(request)
  if (body === null) return refuse(400, 'bad_request', origin)

  const client = { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET }
  let result: TokenAnswer | string
  if (path.endsWith('/token')) {
    const code = field(body, 'code')
    const codeVerifier = field(body, 'codeVerifier')
    const redirectUri = typeof body['redirectUri'] === 'string' ? body['redirectUri'] : ''
    // GitHub redirects only to the app's callback URLs; this keeps the Worker from exchanging a
    // code for a page outside the origin that asked.
    let redirectOrigin: string | null = null
    try {
      redirectOrigin = new URL(redirectUri).origin
    } catch {
      redirectOrigin = null
    }
    if (code === null || codeVerifier === null || redirectOrigin !== origin) {
      return refuse(400, 'bad_request', origin)
    }
    result = await exchange(
      { ...client, code, code_verifier: codeVerifier, redirect_uri: redirectUri },
      fetchImpl
    )
  } else {
    const refreshToken = field(body, 'refreshToken')
    if (refreshToken === null) return refuse(400, 'bad_request', origin)
    result = await exchange(
      { ...client, grant_type: 'refresh_token', refresh_token: refreshToken },
      fetchImpl
    )
  }
  if (typeof result === 'string') {
    return refuse(result === 'github_unavailable' ? 502 : 400, result, origin)
  }
  return answer(200, result, origin)
}

export default {
  fetch: (request: Request, env: AuthEnv) => handleAuth(request, env),
}
