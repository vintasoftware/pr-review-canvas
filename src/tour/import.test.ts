// @vitest-environment node
import type { CommentsPayload } from '../contract/comments.js'
import type { TourArtifact } from '../contract/tour.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { syntheticTour } from '../testing/synthetic-tour.js'
import { fetchSharedTour, importTour, mergedRecord, mergeSharedRecords } from './import.js'
import { tourManifest } from './share.js'
import { buildZipName } from '../canvas/name.js'
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

describe('fetchSharedTour', () => {
  const NO_COMMENTS: CommentsPayload = {
    fetchedAt: '2026-09-10T12:00:00.000Z',
    headSha: HEAD_SHA,
    reviewComments: [],
    issueComments: [],
  }

  it('looks for nothing on local work, and passes over a zip that will not download to the next', async () => {
    const tour = syntheticTour()
    const name = buildZipName('tour', {
      repo: tour.repo,
      headSha: HEAD_SHA,
      prNumber: 42,
      generatedAt: tour.generatedAt,
    })
    const bytes = zipOf(tour)
    t = await makeTestContext({
      fetch: async url =>
        String(url).includes('/files/2/')
          ? new Response('', { status: 502 })
          : new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 }),
    })
    // A pull request with no edit time: its body is read all the same.
    const { updatedAt: _updatedAt, ...pr } = syntheticArtifact().pr
    // The link posted last is tried first, and it fails.
    const body = [1, 2].map(n => `https://github.com/user-attachments/files/${n}/${name}`).join('\n')
    expect(await fetchSharedTour(t.ctx, { ...pr, body, number: null }, NO_COMMENTS)).toEqual({
      outcome: 'none',
      warnings: [],
    })
    expect(await fetchSharedTour(t.ctx, { ...pr, body }, NO_COMMENTS)).toEqual({
      outcome: 'imported',
      warnings: [`${name} could not be downloaded`],
    })
    expect((await t.ctx.tours.read(HEAD_SHA))?.source).toBe('import')
  })
})

describe('mergeSharedRecords', () => {
  const NO_COMMENTS: CommentsPayload = {
    fetchedAt: '2026-09-10T12:00:00.000Z',
    headSha: HEAD_SHA,
    reviewComments: [],
    issueComments: [],
  }

  it('folds every readable copy of the commit into the stored record, skips the rest, and leaves the content', async () => {
    const tour = syntheticTour()
    const name = buildZipName('tour', {
      repo: tour.repo,
      headSha: HEAD_SHA,
      prNumber: 42,
      generatedAt: tour.generatedAt,
    })
    const reviewerCopy = zipOf(
      syntheticTour({ record: { touredBy: [{ login: 'reviewer', at: '2026-09-09T00:00:00.000Z' }] } })
    )
    // A commit whose first eight characters are the head's: its zip is named like the head's.
    const twin = syntheticTour({
      headSha: `${HEAD_SHA.slice(0, 8)}${'c'.repeat(32)}`,
      record: { touredBy: [{ login: 'twin', at: '2026-09-09T00:00:00.000Z' }] },
    })
    const twinCopy = zipOf(twin, { headSha: twin.headSha })
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    t = await makeTestContext({
      fetch: async url =>
        String(url).includes('/files/2/')
          ? new Response('', { status: 502 })
          : String(url).includes('/files/3/')
            ? new Response(broken.buffer, { status: 200 })
            : String(url).includes('/files/4/')
              ? new Response(twinCopy.slice().buffer as ArrayBuffer, { status: 200 })
              : new Response(reviewerCopy.slice().buffer as ArrayBuffer, { status: 200 }),
    })
    await t.ctx.tours.write(HEAD_SHA, tour)
    const pr = syntheticArtifact().pr
    // Local work has no pull request to read.
    expect(await mergeSharedRecords(t.ctx, { ...pr, number: null }, NO_COMMENTS, HEAD_SHA)).toEqual({
      record: tour.record,
      merged: 0,
      warnings: [],
    })
    // Three attachments: one downloads, one does not, one is a broken zip. A copy of another
    // commit is passed over, and so is one whose commit only starts like the head.
    const other = syntheticTour({ headSha: 'c'.repeat(40) })
    const otherName = buildZipName('tour', {
      repo: other.repo,
      headSha: other.headSha,
      prNumber: 42,
      generatedAt: other.generatedAt,
    })
    const twinName = buildZipName('tour', {
      repo: twin.repo,
      headSha: twin.headSha,
      prNumber: 42,
      generatedAt: twin.generatedAt,
    })
    const body = [1, 2, 3].map(n => `https://github.com/user-attachments/files/${n}/${name}`).join('\n')
    const link = (id: number, file: number, zip: string) => ({
      id,
      author: 'someone',
      body: `https://github.com/user-attachments/files/${file}/${zip}`,
      createdAt: 'x',
      updatedAt: 'x',
      url: 'u',
    })
    const comments: CommentsPayload = {
      ...NO_COMMENTS,
      issueComments: [link(1, 9, otherName), link(2, 4, twinName)],
    }
    const result = await mergeSharedRecords(t.ctx, { ...pr, body }, comments, HEAD_SHA)
    expect(result.merged).toBe(1)
    expect(result.record.touredBy).toEqual([{ login: 'reviewer', at: '2026-09-09T00:00:00.000Z' }])
    expect(result.warnings).toEqual([`${name} could not be downloaded`, expect.stringContaining(`${name}: `)])
    const stored = await t.ctx.tours.read(HEAD_SHA)
    expect(stored?.record).toEqual(result.record)
    expect(stored?.revisedAt).toBe('2026-09-10T12:00:00.000Z')
    expect(stored?.source).toBe('local')
    // Nothing stored for the commit: nothing to fold into.
    await expect(mergeSharedRecords(t.ctx, pr, NO_COMMENTS, 'd'.repeat(40))).rejects.toThrow(
      'no tour of ddddddd'
    )
  })
})
