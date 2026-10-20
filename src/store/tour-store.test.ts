// @vitest-environment node
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createFakeGit, makeTempDir } from '../testing/fakes.js'
import { HEAD_SHA } from '../testing/synthetic.js'
import { syntheticTour } from '../testing/synthetic-tour.js'
import { createTourStore } from './tour-store.js'

const OTHER_SHA = 'c'.repeat(40)

let dir: string
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('createTourStore', () => {
  it('writes tour.json under tours/<sha>, indexes it, and reads it back', async () => {
    const store = createTourStore(dir, createFakeGit(), null)
    const tour = syntheticTour()
    expect(await store.exists(HEAD_SHA)).toBe(false)
    await store.write(HEAD_SHA, tour)
    expect(await store.exists(HEAD_SHA)).toBe(true)
    expect(store.tourDir(HEAD_SHA)).toBe(path.join(dir, 'tours', HEAD_SHA))
    expect(store.scenesDir(HEAD_SHA)).toBe(path.join(dir, 'tours', HEAD_SHA, 'scenes'))
    expect(await store.read(HEAD_SHA)).toEqual(tour)
    expect(JSON.parse(await readFile(path.join(dir, 'tours', 'index.json'), 'utf8'))).toEqual({
      tours: { [HEAD_SHA]: { prNumber: 42, generatedAt: tour.generatedAt, source: 'local' } },
    })
    expect(() => store.tourDir('nope')).toThrow('not a commit sha')
  })

  it('revises the record and notes the time; refuses to revise what it never wrote', async () => {
    const store = createTourStore(dir, createFakeGit(), null)
    await store.write(HEAD_SHA, syntheticTour())
    const revised = {
      ...syntheticTour({ record: { touredBy: [{ login: 'octocat', at: '2026-09-11T00:00:00.000Z' }] } }),
      revisedAt: '2026-09-11T00:00:00.000Z',
    }
    await store.revise(HEAD_SHA, revised)
    expect((await store.read(HEAD_SHA))?.record.touredBy).toHaveLength(1)
    expect((await store.readIndex()).tours[HEAD_SHA]?.revisedAt).toBe('2026-09-11T00:00:00.000Z')
    await expect(store.revise(OTHER_SHA, revised)).rejects.toThrow('no tour')
  })

  it('finds the tour for the head, else the newest older one and how far behind it is', async () => {
    const git = createFakeGit({
      ancestors: { [`${HEAD_SHA}..${OTHER_SHA}`]: true },
      counts: { [`${HEAD_SHA}..${OTHER_SHA}`]: 2 },
    })
    const store = createTourStore(dir, git, null)
    expect(await store.findFor(42, HEAD_SHA)).toEqual({ status: 'missing' })
    await store.write(HEAD_SHA, syntheticTour())
    expect(await store.findFor(42, HEAD_SHA)).toEqual({ status: 'ready', headSha: HEAD_SHA })
    expect(await store.findFor(42, OTHER_SHA)).toEqual({
      status: 'stale',
      headSha: HEAD_SHA,
      relation: 'ancestor',
      commitsBehind: 2,
    })
    expect(await store.findFor(42, 'd'.repeat(40))).toEqual({
      status: 'stale',
      headSha: HEAD_SHA,
      relation: 'unrelated',
    })
    // The head's own tour belongs to its commit, as a canvas does; an older one is this review's only.
    expect(await store.findFor(7, HEAD_SHA)).toEqual({ status: 'ready', headSha: HEAD_SHA })
    expect(await store.findFor(7, OTHER_SHA)).toEqual({ status: 'missing' })
  })

  it('keeps a local tour to the checkout that made it, as the canvas store does', async () => {
    const local = syntheticTour({ pr: { ...syntheticTour().pr, number: null } })
    const main = createTourStore(dir, createFakeGit(), null)
    const linked = createTourStore(dir, createFakeGit(), 'feat')
    await linked.write(HEAD_SHA, local)
    expect((await linked.readIndex()).tours[HEAD_SHA]).toMatchObject({ checkout: 'feat' })
    expect(await linked.findFor('branch', OTHER_SHA)).toMatchObject({ status: 'stale', headSha: HEAD_SHA })
    expect(await main.findFor('branch', OTHER_SHA)).toEqual({ status: 'missing' })
    // A pull request's tour is every worktree's, and the head's own tour belongs to its commit.
    await linked.write(OTHER_SHA, syntheticTour({ headSha: OTHER_SHA }))
    expect((await linked.readIndex()).tours[OTHER_SHA]).not.toHaveProperty('checkout')
    expect(await main.findFor(42, OTHER_SHA)).toEqual({ status: 'ready', headSha: OTHER_SHA })
    expect(await main.findFor('branch', HEAD_SHA)).toEqual({ status: 'ready', headSha: HEAD_SHA })
  })
})
