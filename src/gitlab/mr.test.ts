// @vitest-environment node
import { createFakeGh, createFakeGit, ghError, ghJson, TEST_REPO } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA } from '../testing/synthetic.js'
import { GitHubApiError } from '../github/gh.js'
import { PrNotFoundError, prBaseRef, prHeadRef } from '../github/pr.js'
import { fetchMrMeta, fetchMrRefs, mapMergeRequest, MR_STATS_QUERY, toPr } from './mr.js'

const GL_MR = {
  iid: 42,
  title: 'feat: add b',
  description: 'Adds b()',
  web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/42',
  state: 'opened',
  draft: false,
  updated_at: '2026-09-09T09:00:00Z',
  merge_commit_sha: null,
  target_branch: 'main',
  source_branch: 'feat/b',
  sha: HEAD_SHA,
  author: { username: 'octocat' },
  diff_refs: { base_sha: BASE_SHA, head_sha: HEAD_SHA, start_sha: BASE_SHA },
  changes_count: '7',
}

describe('mapMergeRequest', () => {
  it('maps opened, merged, and a missing author', () => {
    expect(mapMergeRequest(GL_MR, { additions: 7, deletions: 5, changedFiles: 7 })).toMatchObject({
      number: 42,
      state: 'open',
      author: 'octocat',
      headSha: HEAD_SHA,
      mergeCommitSha: null,
      diffRefs: { baseSha: BASE_SHA, startSha: BASE_SHA, headSha: HEAD_SHA },
    })
    const merge = 'c'.repeat(40)
    expect(
      mapMergeRequest(
        { ...GL_MR, state: 'merged', merge_commit_sha: merge, author: null, description: null },
        { additions: 0, deletions: 0, changedFiles: 0 }
      )
    ).toMatchObject({ state: 'merged', mergeCommitSha: merge, author: 'ghost', body: '' })
    expect(
      mapMergeRequest(
        { ...GL_MR, state: 'locked', draft: true },
        { additions: 0, deletions: 0, changedFiles: 0 }
      ).state
    ).toBe('closed')
  })

  it('copies shas onto the stored Pr', () => {
    const meta = mapMergeRequest(GL_MR, { additions: 1, deletions: 1, changedFiles: 1 })
    expect(toPr(meta, TEST_REPO, { headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })).toMatchObject({
      number: 42,
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      repo: TEST_REPO,
    })
  })
})

describe('fetchMrMeta', () => {
  it('reads the MR and GraphQL stats', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson(GL_MR) },
      graphql: [
        {
          project: {
            mergeRequest: { diffStatsSummary: { additions: 7, deletions: 5, fileCount: 7 } },
          },
        },
      ],
    })
    const meta = await fetchMrMeta(gh, TEST_REPO, 42)
    expect(meta).toMatchObject({ number: 42, additions: 7, deletions: 5, changedFiles: 7 })
    expect(gh.calls[1]).toMatchObject({ kind: 'graphql', params: { path: 'acme/widgets', iid: '42' } })
    expect(MR_STATS_QUERY).toContain('diffStatsSummary')
  })

  it('turns a 404 into PrNotFoundError', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets/merge_requests/42': ghError(new GitHubApiError('x', 'HTTP 404', 1)),
      },
    })
    await expect(fetchMrMeta(gh, TEST_REPO, 42)).rejects.toBeInstanceOf(PrNotFoundError)
  })

  it('uses changes_count when GraphQL stats are missing', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson({ ...GL_MR, changes_count: 4 }) },
      graphql: [new Error('no graphql')],
    })
    expect(await fetchMrMeta(gh, TEST_REPO, 42)).toMatchObject({ changedFiles: 4, additions: 0 })
  })
})

describe('fetchMrRefs', () => {
  it('fetches GitLab merge-request refs into the same local pr refs', async () => {
    const git = createFakeGit({
      refs: { 'merge-requests/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    })
    const meta = mapMergeRequest(GL_MR, { additions: 0, deletions: 0, changedFiles: 0 })
    expect(await fetchMrRefs(git, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
    expect(git.calls[0]).toEqual([
      'fetch',
      'origin',
      `+merge-requests/42/head:${prHeadRef(42)}`,
      `+refs/heads/main:${prBaseRef(42)}`,
    ])
  })

  it('diffs a merged MR against the merge commit parent', async () => {
    const merge = 'c'.repeat(40)
    const fork = 'd'.repeat(40)
    const git = createFakeGit({
      refs: { 'merge-requests/42/head': HEAD_SHA, 'refs/heads/main': merge },
      mergeBases: { [`${merge}^1..${HEAD_SHA}`]: fork },
    })
    const meta = mapMergeRequest(
      { ...GL_MR, state: 'merged', merge_commit_sha: merge },
      { additions: 0, deletions: 0, changedFiles: 0 }
    )
    expect(await fetchMrRefs(git, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: fork })
  })
})
