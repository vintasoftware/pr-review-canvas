// @vitest-environment node
import { createFakeGh, createFakeGit, ghError, ghJson, TEST_REPO } from '../testing/fakes.js'
import { BASE_SHA, GH_PULL, HEAD_SHA } from '../testing/synthetic.js'
import { GitHubApiError } from './gh.js'
import { fetchPrMeta, fetchPrRefs, mapPull, PrNotFoundError, prBaseRef, prHeadRef, toPr } from './pr.js'

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
      routes: { 'repos/acme/widgets/pulls/7': ghError(new GitHubApiError('x', 'HTTP 500', 1)) },
    })
    await expect(fetchPrMeta(gh, TEST_REPO, 42)).rejects.toBeInstanceOf(PrNotFoundError)
    await expect(fetchPrMeta(gh, TEST_REPO, 42)).rejects.toMatchObject({
      number: 42,
      message: 'pull request #42 not found',
    })
    await expect(fetchPrMeta(gh, TEST_REPO, 7)).rejects.toBeInstanceOf(GitHubApiError)
  })
})

describe('fetchPrRefs and toPr', () => {
  it('fetches head and base into local refs and resolves the shas', async () => {
    const git = createFakeGit({
      refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    })
    const meta = mapPull(GH_PULL)
    const shas = await fetchPrRefs(git, meta)
    expect(shas).toEqual({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
    expect(git.calls).toEqual([
      ['fetch', 'origin', `+pull/42/head:${prHeadRef(42)}`, `+refs/heads/main:${prBaseRef(42)}`],
      ['rev-parse', 'refs/pr/42/head'],
      ['merge-base', 'refs/pr/42/base', HEAD_SHA],
    ])
    expect(toPr(meta, TEST_REPO, shas)).toEqual({
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
      mergeBaseSha: BASE_SHA,
      additions: 7,
      deletions: 5,
      changedFiles: 7,
      repo: TEST_REPO,
    })
    await git.fetch('origin', ['refs/heads/unknown:refs/pr/9/base', 'not-a-refspec'])
    await expect(git.revParse('refs/pr/9/base')).rejects.toThrow()
  })

  it("diffs a merged PR against the base as it was at merge time, not against today's base tip", async () => {
    const merge = 'c'.repeat(40)
    const forkPoint = 'd'.repeat(40)
    const git = createFakeGit({
      refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': merge },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: HEAD_SHA, [`${merge}^1..${HEAD_SHA}`]: forkPoint },
    })
    const meta = mapPull({ ...GH_PULL, state: 'closed', merged: true, merge_commit_sha: merge })
    expect(await fetchPrRefs(git, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: forkPoint })
    expect(git.calls[2]).toEqual(['merge-base', `${merge}^1`, HEAD_SHA])
  })
})
