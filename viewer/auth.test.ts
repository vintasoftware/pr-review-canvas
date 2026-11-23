import { createHash } from 'node:crypto'
import { type AuthDeps, base64Url, createAuth } from './auth.js'

const config = { clientId: 'Iv1.client', workerUrl: 'https://auth.example.com/' }
const REDIRECT = 'https://viewer.example.com/'

/** sessionStorage in memory. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

/** The Worker, answering each path from a queue and recording each body it was sent. */
function setup(answers: Record<string, Array<{ status: number; body: unknown }>> = {}) {
  let clock = 1_000_000
  let seed = 0
  const sent: Array<{ url: string; body: unknown }> = []
  const storage = memoryStorage()
  const deps: AuthDeps = {
    storage,
    now: () => clock,
    randomBytes: length => Uint8Array.from({ length }, () => seed++ % 256),
    sha256: async data => Uint8Array.from(createHash('sha256').update(data).digest()).buffer,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      sent.push({ url, body: JSON.parse(String(init?.body)) })
      const next = answers[new URL(url).pathname]?.shift()
      if (next === undefined) throw new Error(`no answer for ${url}`)
      return new Response(JSON.stringify(next.body), { status: next.status })
    }) as typeof fetch,
  }
  return {
    auth: createAuth(config, deps),
    deps,
    sent,
    storage,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const TOKENS = {
  accessToken: 'ghu_1',
  expiresIn: 28800,
  refreshToken: 'ghr_1',
  refreshTokenExpiresIn: 15897600,
}

async function signIn(s: ReturnType<typeof setup>) {
  const url = new URL(await s.auth.signInUrl(REDIRECT, '/?pr=acme/widgets/42'))
  const back = new URL(`${REDIRECT}?code=the-code&state=${url.searchParams.get('state')}`)
  return { url, result: await s.auth.completeSignIn(back, REDIRECT) }
}

it('sends the reader to GitHub with a state and an S256 challenge of the verifier', async () => {
  const s = setup({ '/token': [{ status: 200, body: TOKENS }] })
  const { url, result } = await signIn(s)
  expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
  expect(url.searchParams.get('client_id')).toBe('Iv1.client')
  expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')

  const verifier = (s.sent[0]!.body as { codeVerifier: string }).codeVerifier
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  expect(url.searchParams.get('code_challenge')).toBe(challenge)
  expect(s.sent[0]).toEqual({
    url: 'https://auth.example.com/token',
    body: { code: 'the-code', codeVerifier: verifier, redirectUri: REDIRECT },
  })

  expect(result).toEqual({ status: 'signed-in', returnTo: '/?pr=acme/widgets/42' })
  expect(s.auth.signedIn()).toBe(true)
  expect(await s.auth.token()).toBe('ghu_1')
})

it('keeps the session in the tab storage and forgets it on sign-out', async () => {
  const s = setup({ '/token': [{ status: 200, body: TOKENS }] })
  await signIn(s)
  const again = createAuth(config, s.deps)
  expect(await again.token()).toBe('ghu_1')
  let changes = 0
  again.onChange(() => changes++)
  again.signOut()
  expect(changes).toBe(1)
  expect(await createAuth(config, s.deps).token()).toBeNull()
})

it('refreshes a token about to expire once, however many callers ask at the same time', async () => {
  const s = setup({
    '/token': [{ status: 200, body: TOKENS }],
    '/refresh': [{ status: 200, body: { ...TOKENS, accessToken: 'ghu_2', refreshToken: 'ghr_2' } }],
  })
  await signIn(s)
  s.advance(28800 * 1000 - 30_000)
  const tokens = await Promise.all([s.auth.token(), s.auth.token(), s.auth.token()])
  expect(tokens).toEqual(['ghu_2', 'ghu_2', 'ghu_2'])
  expect(s.sent.filter(r => r.url.endsWith('/refresh'))).toEqual([
    { url: 'https://auth.example.com/refresh', body: { refreshToken: 'ghr_1' } },
  ])
})

it('signs out when a refresh fails, since a refresh token works once', async () => {
  const s = setup({
    '/token': [{ status: 200, body: TOKENS }],
    '/refresh': [{ status: 400, body: { error: 'bad_refresh_token' } }],
  })
  await signIn(s)
  s.advance(28800 * 1000)
  expect(await s.auth.token()).toBeNull()
  expect(s.auth.signedIn()).toBe(false)
})

it('refuses a redirect whose state this tab did not start, and a sign-in GitHub cancelled', async () => {
  const s = setup()
  await s.auth.signInUrl(REDIRECT, '/')
  const forged = await s.auth.completeSignIn(new URL(`${REDIRECT}?code=c&state=someone-else`), REDIRECT)
  expect(forged).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/did not start on this tab/),
  })
  expect(s.sent).toEqual([])

  const url = new URL(await s.auth.signInUrl(REDIRECT, '/'))
  const cancelled = await s.auth.completeSignIn(
    new URL(`${REDIRECT}?error=access_denied&state=${url.searchParams.get('state')}`),
    REDIRECT
  )
  expect(cancelled).toMatchObject({ status: 'failed', error: 'GitHub sign-in was cancelled' })
  expect(s.auth.signedIn()).toBe(false)
})

it('drops a sign-in left unfinished too long, and reports what the Worker refused', async () => {
  const s = setup({ '/token': [{ status: 400, body: { error: 'bad_verification_code' } }] })
  const slow = new URL(await s.auth.signInUrl(REDIRECT, '/'))
  s.advance(11 * 60 * 1000)
  expect(
    await s.auth.completeSignIn(
      new URL(`${REDIRECT}?code=c&state=${slow.searchParams.get('state')}`),
      REDIRECT
    )
  ).toMatchObject({ status: 'failed' })

  const { result } = await signIn(s)
  expect(result).toMatchObject({ status: 'failed', error: 'GitHub sign-in failed: bad_verification_code' })
})

it('leaves an ordinary page load alone', async () => {
  const s = setup()
  expect(await s.auth.completeSignIn(new URL(`${REDIRECT}?pr=acme/widgets/42`), REDIRECT)).toEqual({
    status: 'none',
  })
  expect(s.auth.redirectUri({ origin: 'https://viewer.example.com', pathname: '/' })).toBe(REDIRECT)
})
