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
  await expect(gh.post('x', {})).rejects.toThrow(/does not write to GitHub/)
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
