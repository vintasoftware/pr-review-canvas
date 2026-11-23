import { type AuthEnv, handleAuth } from './auth-worker.js'

const VIEWER = 'https://viewer.example.com'
const env: AuthEnv = {
  GITHUB_CLIENT_ID: 'Iv1.client',
  GITHUB_CLIENT_SECRET: 'shh-secret',
  ALLOWED_ORIGINS: `${VIEWER}, http://127.0.0.1:4174`,
}

/** GitHub's token endpoint, answering `body` and recording what the Worker sent. */
function github(body: unknown, status = 200) {
  const sent: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, sent }
}

function post(path: string, body: unknown, origin: string | null = VIEWER) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin !== null) headers['origin'] = origin
  return new Request(`https://auth.example.com${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const TOKENS = {
  access_token: 'ghu_access',
  expires_in: 28800,
  refresh_token: 'ghr_refresh',
  refresh_token_expires_in: 15897600,
  token_type: 'bearer',
  scope: '',
}

it('trades a code and its PKCE verifier for a token, adding the secret only on the way to GitHub', async () => {
  const gh = github(TOKENS)
  const res = await handleAuth(
    post('/token', { code: 'abc123', codeVerifier: 'v'.repeat(64), redirectUri: `${VIEWER}/?pr=a/b/1` }),
    env,
    gh.fetchImpl
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe(VIEWER)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.json()).toEqual({
    accessToken: 'ghu_access',
    expiresIn: 28800,
    refreshToken: 'ghr_refresh',
    refreshTokenExpiresIn: 15897600,
  })
  expect(gh.sent).toEqual([
    {
      client_id: 'Iv1.client',
      client_secret: 'shh-secret',
      code: 'abc123',
      code_verifier: 'v'.repeat(64),
      redirect_uri: `${VIEWER}/?pr=a/b/1`,
    },
  ])
})

it('refreshes a token with the refresh token', async () => {
  const gh = github(TOKENS)
  const res = await handleAuth(post('/refresh', { refreshToken: 'ghr_old' }), env, gh.fetchImpl)
  expect(res.status).toBe(200)
  expect(gh.sent[0]).toMatchObject({
    grant_type: 'refresh_token',
    refresh_token: 'ghr_old',
    client_secret: 'shh-secret',
  })
})

it("passes GitHub's error code on, but never its description", async () => {
  const gh = github({
    error: 'bad_verification_code',
    error_description: 'The code passed is incorrect or expired.',
  })
  const res = await handleAuth(
    post('/token', { code: 'x', codeVerifier: 'y', redirectUri: `${VIEWER}/` }),
    env,
    gh.fetchImpl
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'bad_verification_code' })
})

it('answers 502 when GitHub is unavailable', async () => {
  const gh = github({}, 503)
  const res = await handleAuth(post('/refresh', { refreshToken: 'r' }), env, gh.fetchImpl)
  expect(res.status).toBe(502)
})

it.each([
  [
    'another origin',
    post('/token', { code: 'a', codeVerifier: 'b', redirectUri: 'https://evil.test/' }, 'https://evil.test'),
    403,
  ],
  ['no origin', post('/token', { code: 'a', codeVerifier: 'b', redirectUri: `${VIEWER}/` }, null), 403],
  [
    'a redirect to another origin',
    post('/token', { code: 'a', codeVerifier: 'b', redirectUri: 'https://evil.test/' }),
    400,
  ],
  ['a missing verifier', post('/token', { code: 'a', redirectUri: `${VIEWER}/` }), 400],
  ['a field with odd characters', post('/refresh', { refreshToken: 'a b' }), 400],
  ['an unknown path', post('/user', {}), 404],
  [
    'a body too large',
    post('/token', { code: 'a', codeVerifier: 'b', redirectUri: `${VIEWER}/`, pad: 'x'.repeat(5000) }),
    400,
  ],
  [
    'a form body',
    new Request('https://auth.example.com/token', {
      method: 'POST',
      headers: { origin: VIEWER, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=a',
    }),
    415,
  ],
  ['a GET', new Request('https://auth.example.com/token', { headers: { origin: VIEWER } }), 404],
])('refuses %s without calling GitHub', async (_name, request, status) => {
  const gh = github(TOKENS)
  const res = await handleAuth(request, env, gh.fetchImpl)
  expect(res.status).toBe(status)
  expect(gh.sent).toEqual([])
})

it('answers the preflight of an allowed origin only', async () => {
  const preflight = (origin: string) =>
    handleAuth(new Request('https://auth.example.com/token', { method: 'OPTIONS', headers: { origin } }), env)
  const allowed = await preflight('http://127.0.0.1:4174')
  expect(allowed.status).toBe(204)
  expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4174')
  expect((await preflight('https://evil.test')).status).toBe(403)
})

it('says the client ID is unknown when GitHub answers 404', async () => {
  const gh = github({ error: 'Not Found' }, 404)
  const res = await handleAuth(post('/refresh', { refreshToken: 'r' }), env, gh.fetchImpl)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'unknown_client' })
})
