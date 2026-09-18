// @vitest-environment node
import { createFakeGit } from '../testing/fakes.js'
import { BASE_SHA, gitForLocal, HEAD_SHA } from '../testing/synthetic.js'
import { localAuthor, LocalTargetError, resolveLocalBase, resolveLocalHead } from './local-target.js'

describe('resolveLocalBase', () => {
  it('follows origin/HEAD to the branch it points at', async () => {
    expect(await resolveLocalBase(gitForLocal())).toBe('origin/main')
  })

  it('takes the ref the user named over anything in the clone', async () => {
    const git = gitForLocal()
    expect(await resolveLocalBase(git, 'release/2.0')).toBe('release/2.0')
    expect(git.calls.some(c => c[0] === 'rev-parse')).toBe(false)
  })

  it('treats an empty base as none given', async () => {
    expect(await resolveLocalBase(gitForLocal(), '')).toBe('origin/main')
  })

  it('keeps origin/HEAD when it is a ref of its own rather than a pointer', async () => {
    const git = gitForLocal()
    git.options.symbolicRefs = {}
    expect(await resolveLocalBase(git)).toBe('origin/HEAD')
  })

  it('falls back through the usual names when origin/HEAD is not fetched', async () => {
    const git = createFakeGit({ refs: { master: BASE_SHA } })
    expect(await resolveLocalBase(git)).toBe('master')
  })

  it('says what to do when there is no branch to compare against', async () => {
    await expect(resolveLocalBase(createFakeGit())).rejects.toThrow(LocalTargetError)
    await expect(resolveLocalBase(createFakeGit())).rejects.toThrow(/no default branch/)
  })
})

describe('resolveLocalHead', () => {
  it('snapshots the working tree when it carries edits', async () => {
    expect(await resolveLocalHead(gitForLocal(), 'uncommitted')).toEqual({
      headSha: HEAD_SHA,
      branch: 'feat/b',
      uncommitted: true,
    })
  })

  it('stays on the branch tip when the tree is clean', async () => {
    expect(await resolveLocalHead(gitForLocal({ snapshot: null }), 'uncommitted')).toEqual({
      headSha: BASE_SHA,
      branch: 'feat/b',
      uncommitted: false,
    })
  })

  it('never snapshots for the branch review, however dirty the tree is', async () => {
    const git = gitForLocal()
    expect(await resolveLocalHead(git, 'branch')).toEqual({
      headSha: BASE_SHA,
      branch: 'feat/b',
      uncommitted: false,
    })
    expect(git.calls.some(c => c[0] === 'write-tree')).toBe(false)
  })

  it('reports a detached HEAD as no branch at all', async () => {
    const git = gitForLocal({ snapshot: null })
    git.options.branch = null
    expect((await resolveLocalHead(git, 'uncommitted')).branch).toBeNull()
  })

  it('says what to do in a repository with no commits', async () => {
    const git = createFakeGit({ refs: { 'origin/main': BASE_SHA } })
    await expect(resolveLocalHead(git, 'branch')).rejects.toThrow(/no commits yet/)
  })

  it('lets a failure that is not git speak for itself', async () => {
    const git = gitForLocal()
    const boom = new Error('the disk went away')
    git.revParse = () => Promise.reject(boom)
    await expect(resolveLocalHead(git, 'branch')).rejects.toBe(boom)
  })
})

describe('localAuthor', () => {
  it('credits uncommitted work to the person this clone commits as', async () => {
    expect(await localAuthor(gitForLocal(), true)).toBe('dev')
  })

  it('credits a commit to its own author', async () => {
    expect(await localAuthor(gitForLocal(), false)).toBe('octocat')
  })

  it('falls back to the commit author when no user is configured', async () => {
    const git = gitForLocal()
    git.options.user = null
    expect(await localAuthor(git, true)).toBe('octocat')
  })
})
