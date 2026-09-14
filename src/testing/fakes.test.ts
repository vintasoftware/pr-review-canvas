// @vitest-environment node
// The fakes themselves: a test that asks for something the fake was not told about must fail
// loudly, never quietly answer something wrong.
import { createFakeGh, ghError, ghHandler, ghJson, ghPost, ghPostError, makeTestContext } from './fakes.js'

describe('the fake gh', () => {
  it('answers from a body, from a handler, and by throwing', async () => {
    const gh = createFakeGh({
      routes: {
        a: ghJson({ ok: true }),
        b: ghHandler(params => ({ asked: Object.entries(params) })),
        c: ghError(new Error('boom')),
      },
    })
    expect(await gh.api('a')).toEqual({ ok: true })
    expect(await gh.api('b', { page: '2' })).toEqual({ asked: [['page', '2']] })
    await expect(gh.api('c')).rejects.toThrow('boom')
    await expect(gh.api('d')).rejects.toThrow('HTTP 404')
  })

  it('runs out of GraphQL pages and raises the page it was handed', async () => {
    const gh = createFakeGh({ graphql: [new Error('graphql is down')] })
    await expect(gh.graphql('query', {})).rejects.toThrow('graphql is down')
    await expect(gh.graphql('query', {})).rejects.toThrow('no more pages')
  })

  it('answers a POST from its handler and raises what it was given', async () => {
    const gh = createFakeGh({
      postRoutes: { ok: ghPost(body => body), bad: ghPostError(new Error('refused')) },
    })
    expect(await gh.post('ok', { a: 1 })).toEqual({ a: 1 })
    await expect(gh.post('bad', {})).rejects.toThrow('refused')
    await expect(gh.post('missing', {})).rejects.toThrow('HTTP 404')
  })

  it('reports the login by default and none when the test says so', async () => {
    expect(await createFakeGh().authToken()).toBe('gh-test-token')
    expect(await createFakeGh({ token: null }).authToken()).toBeNull()
  })
})

describe('the test context', () => {
  it('fails a test that reaches the network without saying so', async () => {
    const t = await makeTestContext()
    expect(() => t.ctx.fetch('https://example.test')).toThrow('unexpected fetch')
    await t.cleanup()
  })
})
