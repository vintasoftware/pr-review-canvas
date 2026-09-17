// @vitest-environment node
import { fetchPrRefs, prBaseRef, prHeadRef } from '../git/pr-refs.js'
import { PrNotFoundError, toPr } from '../host/pr.js'
import { HostCliError } from '../host/client.js'
import { gitlabHost } from '../host/host.js'
import { createFakeGh, createFakeGit, ghError, ghJson, TEST_REPO } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA } from '../testing/synthetic.js'
import { fetchMrDiffRefs, fetchMrMeta, mapMergeRequest, mergeableOf, MR_STATS_QUERY } from './mr.js'

const GL = gitlabHost('gitlab.com')
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
describe('mergeableOf', () => {
  it('turns the conflict flag around, and stays open while GitLab has not decided', () => {
    expect(mergeableOf({ has_conflicts: false, detailed_merge_status: 'mergeable' })).toBe(true)
    expect(mergeableOf({ has_conflicts: false, detailed_merge_status: 'not_approved' })).toBe(true)
    expect(mergeableOf({ has_conflicts: true, detailed_merge_status: 'conflict' })).toBe(false)
    expect(mergeableOf({ has_conflicts: false, detailed_merge_status: 'checking' })).toBeNull()
    expect(mergeableOf({ has_conflicts: false, detailed_merge_status: 'unchecked' })).toBeNull()
    expect(mergeableOf({ has_conflicts: false })).toBe(true)
    expect(mergeableOf({})).toBeNull()
    expect(mapMergeRequest({ ...GL_MR, has_conflicts: true }, STATS_VALUE).mergeable).toBe(false)
  })
})

const STATS_VALUE = { additions: 7, deletions: 5 }
const STATS = {
  project: { mergeRequest: { diffStatsSummary: { additions: 7, deletions: 5 } } },
}

describe('mapMergeRequest', () => {
  it('maps an open MR onto the PrMeta the rest of the tool reads', () => {
    expect(mapMergeRequest(GL_MR, { additions: 7, deletions: 5 })).toEqual({
      number: 42,
      title: 'feat: add b',
      body: 'Adds b()',
      author: 'octocat',
      url: GL_MR.web_url,
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

  it('maps merged, locked, a draft, a missing author and description, and a capped file count', () => {
    const merge = 'c'.repeat(40)
    expect(
      mapMergeRequest(
        {
          ...GL_MR,
          state: 'merged',
          merge_commit_sha: merge,
          author: null,
          description: null,
          changes_count: '1000+',
        },
        { additions: 0, deletions: 0 }
      )
    ).toMatchObject({ state: 'merged', mergeCommitSha: merge, author: 'ghost', body: '', changedFiles: 1000 })
    expect(
      mapMergeRequest(
        { ...GL_MR, state: 'locked', draft: true, diff_refs: null },
        { additions: 0, deletions: 0 }
      )
    ).toMatchObject({ state: 'closed', draft: true, headSha: HEAD_SHA })
  })
})

describe('fetchMrMeta', () => {
  it('reads the MR and its GraphQL line counts together', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson(GL_MR) },
      graphql: [STATS],
    })
    expect(await fetchMrMeta(gh, TEST_REPO, 42)).toMatchObject({
      number: 42,
      additions: 7,
      deletions: 5,
      changedFiles: 7,
    })
    expect(gh.calls.find(c => c.kind === 'graphql')).toMatchObject({
      params: { path: 'acme/widgets', iid: '42' },
    })
    expect(MR_STATS_QUERY).toContain('diffStatsSummary')
  })

  it('turns a 404 into PrNotFoundError', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets/merge_requests/42': ghError(new HostCliError('glab', 'x', 'HTTP 404', 1)),
      },
    })
    await expect(fetchMrMeta(gh, TEST_REPO, 42)).rejects.toBeInstanceOf(PrNotFoundError)
  })

  it('keeps the REST file count and shows +0 −0 when GraphQL refuses or has no summary', async () => {
    const refused = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson({ ...GL_MR, changes_count: '4' }) },
      graphql: [new Error('no graphql')],
    })
    expect(await fetchMrMeta(refused, TEST_REPO, 42)).toMatchObject({
      changedFiles: 4,
      additions: 0,
      deletions: 0,
    })
    const empty = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson(GL_MR) },
      graphql: [{ project: { mergeRequest: { diffStatsSummary: null } } }],
    })
    expect(await fetchMrMeta(empty, TEST_REPO, 42)).toMatchObject({ changedFiles: 7, additions: 0 })
  })
})

describe('fetchMrDiffRefs', () => {
  it('reads the live diff refs, and says so when GitLab has none yet', async () => {
    const gh = createFakeGh({ routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson(GL_MR) } })
    expect(await fetchMrDiffRefs(gh, TEST_REPO, 42)).toEqual({
      base_sha: BASE_SHA,
      start_sha: BASE_SHA,
      head_sha: HEAD_SHA,
    })
    const none = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson({ ...GL_MR, diff_refs: null }) },
    })
    await expect(fetchMrDiffRefs(none, TEST_REPO, 42)).rejects.toThrow(/no diff refs/)
  })
})

describe('fetchPrRefs for a GitLab host', () => {
  it('fetches the merge-request head into the same local refs GitHub uses', async () => {
    const git = createFakeGit({
      refs: { 'merge-requests/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    })
    const meta = mapMergeRequest(GL_MR, { additions: 0, deletions: 0 })
    const shas = await fetchPrRefs(git, GL, meta)
    expect(shas).toEqual({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
    expect(git.calls[0]).toEqual([
      'fetch',
      'origin',
      `+merge-requests/42/head:${prHeadRef(42)}`,
      `+refs/heads/main:${prBaseRef(42)}`,
    ])
    expect(toPr(meta, TEST_REPO, shas)).toMatchObject({ number: 42, headSha: HEAD_SHA, repo: TEST_REPO })
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
      { additions: 0, deletions: 0 }
    )
    expect(await fetchPrRefs(git, GL, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: fork })
  })
})
