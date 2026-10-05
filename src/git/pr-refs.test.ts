// @vitest-environment node
import { createFakeGit, TEST_REPO } from '../testing/fakes.js'
import { BASE_SHA, GH_PULL, HEAD_SHA } from '../testing/synthetic.js'
import { GITHUB_HOST } from '../host/host.js'
import { mapPull } from '../github/pr.js'
import { toPr } from '../host/pr.js'
import { GitError } from './git.js'
import { fetchPrRefs, prBaseRef, prHeadRef } from './pr-refs.js'

describe('fetchPrRefs and toPr', () => {
  it('fetches head and base into local refs and resolves the shas', async () => {
    const git = createFakeGit({
      refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    })
    const meta = mapPull(GH_PULL)
    const shas = await fetchPrRefs(git, GITHUB_HOST, meta)
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
    expect(await fetchPrRefs(git, GITHUB_HOST, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: forkPoint })
    expect(git.calls[2]).toEqual(['merge-base', `${merge}^1`, HEAD_SHA])
  })

  describe('when the base branch is gone from the remote', () => {
    const merge = 'c'.repeat(40)
    const missing = new GitError(['fetch'], "fatal: couldn't find remote ref refs/heads/main", 128)

    /** A fake git whose fetch fails while it names the base branch. */
    function gitWithoutBase(failure: Error = missing) {
      const git = createFakeGit({
        refs: { 'pull/42/head': HEAD_SHA },
        mergeBases: { [`${merge}^1..${HEAD_SHA}`]: BASE_SHA },
      })
      const fetches: string[][] = []
      return {
        fetches,
        git: {
          ...git,
          fetch: async (remote: string, refspecs: string[]) => {
            fetches.push(refspecs)
            if (refspecs.some(spec => spec.includes('refs/heads/main'))) {
              throw failure
            }
            await git.fetch(remote, refspecs)
          },
        },
      }
    }

    it('fetches the merge commit of a merged PR by its sha instead', async () => {
      const { git, fetches } = gitWithoutBase()
      const meta = mapPull({ ...GH_PULL, state: 'closed', merged: true, merge_commit_sha: merge })
      expect(await fetchPrRefs(git, GITHUB_HOST, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
      expect(fetches[1]).toEqual([`+pull/42/head:${prHeadRef(42)}`, merge])
    })

    it('fails for an open PR, which has no merge commit to fall back on', async () => {
      const { git } = gitWithoutBase()
      await expect(fetchPrRefs(git, GITHUB_HOST, mapPull(GH_PULL))).rejects.toBe(missing)
    })

    it('fails on any other fetch error of a merged PR', async () => {
      const offline = new GitError(['fetch'], 'fatal: unable to access the remote', 128)
      const { git, fetches } = gitWithoutBase(offline)
      const meta = mapPull({ ...GH_PULL, state: 'closed', merged: true, merge_commit_sha: merge })
      await expect(fetchPrRefs(git, GITHUB_HOST, meta)).rejects.toBe(offline)
      expect(fetches).toHaveLength(1)
    })
  })
})
