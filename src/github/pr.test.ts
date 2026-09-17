// @vitest-environment node
import { createFakeGh, ghError, ghJson, TEST_REPO } from '../testing/fakes.js'
import { GH_PULL, HEAD_SHA } from '../testing/synthetic.js'
import { HostCliError } from '../host/client.js'
import { fetchPrMeta, mapPull } from './pr.js'
import { PrNotFoundError } from '../host/pr.js'

describe('mapPull', () => {
  it('maps the GitHub pull object', () => {
    expect(mapPull(GH_PULL)).toEqual({
      number: 42,
      title: 'feat: add b',
      body: GH_PULL.body,
      author: 'octocat',
      url: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      draft: false,
      updatedAt: '2026-09-09T09:00:00Z',
      baseRef: 'main',
      headRef: 'feat/b',
      headSha: HEAD_SHA,
      mergeCommitSha: null,
      mergeable: null,
      additions: 7,
      deletions: 5,
      changedFiles: 7,
    })
  })

  it('reports merged PRs as merged, a deleted author as ghost, and a null body as empty', () => {
    const merge = 'c'.repeat(40)
    const meta = mapPull({
      ...GH_PULL,
      state: 'closed',
      merged: true,
      merge_commit_sha: merge,
      user: null,
      body: null,
      draft: undefined,
    })
    expect(meta.state).toBe('merged')
    expect(meta.mergeCommitSha).toBe(merge)
    // GitHub fills merge_commit_sha for open PRs too (a test merge); only a merged PR uses it.
    expect(mapPull({ ...GH_PULL, merge_commit_sha: merge }).mergeCommitSha).toBeNull()
    expect(mapPull({ ...GH_PULL, merged: true }).mergeCommitSha).toBeNull()
    expect(meta.author).toBe('ghost')
    expect(meta.body).toBe('')
    expect(meta.draft).toBe(false)
  })

  it('reads whether the head merges cleanly, and leaves it open while GitHub is still computing', () => {
    expect(mapPull({ ...GH_PULL, mergeable: true }).mergeable).toBe(true)
    expect(mapPull({ ...GH_PULL, mergeable: false }).mergeable).toBe(false)
    expect(mapPull({ ...GH_PULL, mergeable: null }).mergeable).toBeNull()
    expect(mapPull(GH_PULL).mergeable).toBeNull()
  })

  it('rejects a payload that is not a pull request', () => {
    expect(() => mapPull({ nope: true })).toThrow()
  })
})

describe('fetchPrMeta', () => {
  it('reads the pull through gh', async () => {
    const gh = createFakeGh({ routes: { 'repos/acme/widgets/pulls/42': ghJson(GH_PULL) } })
    expect((await fetchPrMeta(gh, TEST_REPO, 42)).number).toBe(42)
    expect(gh.calls).toEqual([{ kind: 'api', path: 'repos/acme/widgets/pulls/42', params: {} }])
  })

  it('turns a 404 into PrNotFoundError and passes other errors through', async () => {
    const gh = createFakeGh({
      routes: { 'repos/acme/widgets/pulls/7': ghError(new HostCliError('gh', 'x', 'HTTP 500', 1)) },
    })
    await expect(fetchPrMeta(gh, TEST_REPO, 42)).rejects.toBeInstanceOf(PrNotFoundError)
    await expect(fetchPrMeta(gh, TEST_REPO, 42)).rejects.toMatchObject({
      number: 42,
      message: 'pull request #42 not found',
    })
    await expect(fetchPrMeta(gh, TEST_REPO, 7)).rejects.toBeInstanceOf(HostCliError)
  })
})
