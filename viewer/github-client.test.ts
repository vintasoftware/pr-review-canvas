import { createBrowserGithub, FRESH_MS } from './github-client.js'
import { parseTarget } from './target.js'

/** A fetch that answers from a queue and records what each request sent. */
function scripted(answers: Array<() => Response>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
    const next = answers.shift()
    if (next === undefined) throw new Error('no answer left')
    return Promise.resolve(next())
  }
  return { fetchImpl: fetchImpl as typeof fetch, requests }
}

const json =
  (body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status: 200, headers: { etag: '"v1"', ...headers } })

it('reuses a fresh answer, revalidates a stale one with its ETag, and asks again after refresh', async () => {
  let clock = 0
  const { fetchImpl, requests } = scripted([
    json({ n: 1 }),
    () => new Response(null, { status: 304 }),
    json({ n: 2 }, { etag: '"v2"' }),
  ])
  const gh = createBrowserGithub({ fetchImpl, storage: null, now: () => clock })
  expect(await gh.api('repos/a/b/pulls/1')).toEqual({ n: 1 })
  expect(await gh.api('repos/a/b/pulls/1')).toEqual({ n: 1 })
  expect(requests).toHaveLength(1)

  clock = FRESH_MS + 1
  expect(await gh.api('repos/a/b/pulls/1')).toEqual({ n: 1 })
  expect(requests[1]?.headers['if-none-match']).toBe('"v1"')

  gh.refresh()
  expect(await gh.api('repos/a/b/pulls/1')).toEqual({ n: 2 })
  expect(requests).toHaveLength(3)
})

it('asks for the raw diff of a three-dot compare', async () => {
  const { fetchImpl, requests } = scripted([() => new Response('diff --git a/x b/x\n', { status: 200 })])
  const gh = createBrowserGithub({ fetchImpl, storage: null })
  expect(await gh.diff('a', 'b', 'base', 'head')).toBe('diff --git a/x b/x\n')
  expect(requests[0]).toMatchObject({
    url: 'https://api.github.com/repos/a/b/compare/base...head',
    headers: { accept: 'application/vnd.github.diff' },
  })
})

it('names the anonymous rate limit when GitHub refuses for it, and a missing pull as not found', async () => {
  const { fetchImpl } = scripted([
    () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      }),
    () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
  ])
  const gh = createBrowserGithub({ fetchImpl, storage: null })
  await expect(gh.api('rate')).rejects.toThrow(/anonymous rate limit of 60 requests an hour/)
  await expect(gh.api('missing')).rejects.toMatchObject({ notFound: true })
  await expect(gh.post('x', {})).rejects.toThrow(/sign in with GitHub to post/)
})

it.each([
  ['acme/widgets/42', { owner: 'acme', repo: 'widgets', number: 42 }],
  ['acme/widgets#42', { owner: 'acme', repo: 'widgets', number: 42 }],
  ['https://github.com/acme/widgets/pull/42', { owner: 'acme', repo: 'widgets', number: 42 }],
  ['https://github.com/acme/widgets/pull/42/files#diff', { owner: 'acme', repo: 'widgets', number: 42 }],
  ['acme/widgets', null],
  ['acme/widgets/0', null],
  ['../../42', null],
  [null, null],
])('reads %s as the pull request to open', (raw, expected) => {
  expect(parseTarget(raw)).toEqual(expected)
})

it('sends the token when signed in, and keeps those answers out of browser storage', async () => {
  const stored = new Map<string, string>()
  const storage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  } as unknown as Storage
  let token: string | null = 'ghu_1'
  const { fetchImpl, requests } = scripted([
    json({ private: true }),
    json({ public: true }),
    json({ again: true }),
  ])
  const gh = createBrowserGithub({ fetchImpl, storage, token: () => Promise.resolve(token) })
  expect(await gh.api('repos/a/private/pulls/1')).toEqual({ private: true })
  expect(requests[0]?.headers['authorization']).toBe('Bearer ghu_1')
  expect(stored.size).toBe(0)
  expect(await gh.authStatus()).toMatchObject({ authenticated: true })

  token = null
  expect(await gh.api('repos/a/public/pulls/1')).toEqual({ public: true })
  expect(requests[1]?.headers['authorization']).toBeUndefined()
  expect(stored.size).toBe(1)

  // Signing in again as anyone starts from an empty cache.
  token = 'ghu_2'
  expect(await gh.api('repos/a/private/pulls/1')).toEqual({ again: true })
})

it('tells the page when GitHub refuses the token', async () => {
  let refused = 0
  const { fetchImpl } = scripted([() => new Response('{"message":"Bad credentials"}', { status: 401 })])
  const gh = createBrowserGithub({
    fetchImpl,
    storage: null,
    token: () => Promise.resolve('ghu_old'),
    onUnauthorized: () => refused++,
  })
  await expect(gh.api('user')).rejects.toThrow(/sign in again/)
  expect(refused).toBe(1)
})

it('asks GraphQL only when signed in, and reports its errors', async () => {
  const { fetchImpl, requests } = scripted([
    json({ data: { viewer: { login: 'octocat' } } }),
    json({ errors: [{ message: 'Could not resolve to a Repository' }] }),
  ])
  const anonymous = createBrowserGithub({ fetchImpl, storage: null })
  await expect(anonymous.graphql('query { viewer { login } }', {})).rejects.toThrow(/signed-in reader/)
  expect(requests).toHaveLength(0)

  const gh = createBrowserGithub({ fetchImpl, storage: null, token: () => Promise.resolve('ghu_1') })
  expect(await gh.graphql('query { viewer { login } }', {})).toEqual({ viewer: { login: 'octocat' } })
  expect(requests[0]).toMatchObject({ url: 'https://api.github.com/graphql' })
  await expect(gh.graphql('query { repository }', {})).rejects.toThrow(/Could not resolve/)
})

it('posts as the signed-in reader, then asks GitHub again for what it kept', async () => {
  let clock = 0
  const { fetchImpl, requests } = scripted([
    json([{ id: 1 }]),
    () => new Response(JSON.stringify({ id: 2 }), { status: 201 }),
    json([{ id: 1 }, { id: 2 }], { etag: '"v2"' }),
  ])
  const gh = createBrowserGithub({
    fetchImpl,
    storage: null,
    now: () => clock,
    token: () => Promise.resolve('ghu_1'),
  })
  await gh.api('repos/a/b/issues/1/comments')
  clock = 1
  expect(await gh.post('repos/a/b/issues/1/comments', { body: 'hi' })).toEqual({ id: 2 })
  expect(requests[1]).toMatchObject({
    url: 'https://api.github.com/repos/a/b/issues/1/comments',
    headers: { authorization: 'Bearer ghu_1', 'content-type': 'application/json' },
  })
  clock = 2
  expect(await gh.api('repos/a/b/issues/1/comments')).toEqual([{ id: 1 }, { id: 2 }])
  expect(requests).toHaveLength(3)
})
