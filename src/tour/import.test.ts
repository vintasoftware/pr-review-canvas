// @vitest-environment node
import type { TourArtifact } from '../contract/tour.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { syntheticTour } from '../testing/synthetic-tour.js'
import { importTour, mergedRecord } from './import.js'
import { tourManifest } from './share.js'
import { buildZip } from '../canvas/zip.js'
import { TOUR_ZIP } from './comment.js'

let t: TestContext
afterEach(() => t?.cleanup())

function zipOf(artifact: TourArtifact, over: Partial<ReturnType<typeof tourManifest>> = {}): Uint8Array {
  return buildZip(TOUR_ZIP, { ...tourManifest(artifact, '9.9.9'), ...over }, artifact)
}

describe('importTour', () => {
  it('refuses a tour of another repository unless forced, and says so when forced', async () => {
    t = await makeTestContext()
    const bytes = zipOf(syntheticTour(), { repo: { owner: 'other', name: 'repo' } })
    await expect(importTour(t.ctx, { bytes })).rejects.toMatchObject({ code: 'CANVAS_REPO_MISMATCH' })
    expect(await importTour(t.ctx, { bytes, force: true })).toEqual({
      status: 'imported',
      headSha: HEAD_SHA,
      warnings: ['imported a tour exported from other/repo'],
    })
  })

  it('replaces a stored tour with one generated or revised later, and files a local one under the PR', async () => {
    t = await makeTestContext()
    const local = syntheticTour({ pr: { ...syntheticArtifact().pr, number: null } })
    await t.ctx.tours.write(HEAD_SHA, local)
    expect((await importTour(t.ctx, { bytes: zipOf(local), prNumber: 42 })).status).toBe('exists')
    const revised = { ...local, revisedAt: '2026-09-11T00:00:00.000Z' }
    expect((await importTour(t.ctx, { bytes: zipOf(revised), prNumber: 42 })).status).toBe('imported')
    expect((await t.ctx.tours.read(HEAD_SHA))?.pr.number).toBe(42)
    expect((await t.ctx.tours.readIndex()).tours[HEAD_SHA]).toMatchObject({ prNumber: 42, source: 'import' })
  })

  it('refuses to file a tour under another pull request than its zip names', async () => {
    t = await makeTestContext()
    await expect(importTour(t.ctx, { bytes: zipOf(syntheticTour()), prNumber: 7 })).rejects.toMatchObject({
      code: 'CANVAS_PR_MISMATCH',
    })
    // A zip that names no pull request is filed under the one given.
    const local = syntheticTour({ pr: { ...syntheticArtifact().pr, number: null } })
    expect((await importTour(t.ctx, { bytes: zipOf(local), prNumber: 7 })).status).toBe('imported')
  })

  it('refuses a zip whose manifest and tour name different commits', async () => {
    t = await makeTestContext()
    const bytes = zipOf(syntheticTour(), { headSha: 'c'.repeat(40) })
    await expect(importTour(t.ctx, { bytes })).rejects.toMatchObject({ code: 'CANVAS_INVALID' })
  })

  it('merges the records of two copies of one tour, so no finish or pick is lost to the newer copy', async () => {
    t = await makeTestContext()
    const author = {
      finishedAt: '2026-09-11T00:00:00.000Z',
      picks: { 'sum-over-product': { pick: 'keep' as const } },
      prompt: '# Keep it',
    }
    const octocat = { login: 'octocat', at: '2026-09-11T00:00:00.000Z' }
    const stored = syntheticTour({ record: { touredBy: [octocat], author }, revisedAt: octocat.at })
    await t.ctx.tours.write(HEAD_SHA, stored)
    // A reviewer finished later on their machine: their copy carries them and nothing of the author.
    const hubot = { login: 'hubot', at: '2026-09-12T00:00:00.000Z' }
    const theirs = syntheticTour({ record: { touredBy: [hubot] }, revisedAt: hubot.at })
    expect((await importTour(t.ctx, { bytes: zipOf(theirs) })).status).toBe('imported')
    expect((await t.ctx.tours.read(HEAD_SHA))?.record).toEqual({ touredBy: [octocat, hubot], author })
    // An older copy with a reader the stored one lacks adds them and keeps the stored content.
    const dependabot = { login: 'dependabot', at: '2026-09-10T00:00:00.000Z' }
    const older = syntheticTour({
      record: { touredBy: [dependabot] },
      generatedAt: '2026-09-09T00:00:00.000Z',
    })
    expect((await importTour(t.ctx, { bytes: zipOf(older) })).status).toBe('imported')
    const merged = await t.ctx.tours.read(HEAD_SHA)
    expect(merged?.record.touredBy).toEqual([dependabot, octocat, hubot])
    expect(merged?.generatedAt).toBe(stored.generatedAt)
    expect(merged?.revisedAt).toBe(t.ctx.now().toISOString())
    // The same copy again changes nothing.
    expect((await importTour(t.ctx, { bytes: zipOf(older) })).status).toBe('exists')
  })

  it('takes the author record of whichever copy the author finished last', () => {
    const early = { finishedAt: '2026-09-10T00:00:00.000Z', picks: {}, prompt: 'a' }
    const late = { finishedAt: '2026-09-12T00:00:00.000Z', picks: {}, prompt: 'b' }
    expect(mergedRecord({ touredBy: [], author: late }, { touredBy: [], author: early })).toEqual({
      record: { touredBy: [], author: late },
      changed: false,
    })
    expect(mergedRecord({ touredBy: [], author: early }, { touredBy: [], author: late }).record.author).toBe(
      late
    )
    expect(mergedRecord({ touredBy: [] }, { touredBy: [] })).toEqual({
      record: { touredBy: [] },
      changed: false,
    })
  })
})
