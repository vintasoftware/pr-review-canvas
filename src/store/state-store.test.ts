// @vitest-environment node
// The local per-PR state: what was reviewed, dismissed, hidden, and posted.
import { emptyState, PrStateSchema } from '../contract/state.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { readJson } from './atomic-json.js'
import { isReviewedId } from './state-store.js'

describe('state store', () => {
  let t: TestContext
  beforeEach(async () => {
    t = await makeTestContext()
  })
  afterEach(async () => {
    await t.cleanup()
  })

  it('answers with an empty state before anything is written', async () => {
    expect(await t.ctx.state.read(42)).toEqual(emptyState('2026-09-10T12:00:00.000Z'))
  })

  it('marks a layer and one of its files reviewed', async () => {
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true)
    const both = await t.ctx.state.setReviewed(42, 'layer:layer-1/file:src_app_ts', true)
    expect(both.reviewed).toEqual({ 'layer:layer-1': true, 'layer:layer-1/file:src_app_ts': true })
  })

  it('reopening a layer reopens its files, and reopening a file reopens its layer', async () => {
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true)
    await t.ctx.state.setReviewed(42, 'layer:layer-1/file:src_app_ts', true)
    await t.ctx.state.setReviewed(42, 'layer:layer-2', true)
    const layerOff = await t.ctx.state.setReviewed(42, 'layer:layer-1', false)
    expect(layerOff.reviewed).toEqual({ 'layer:layer-2': true })
    await t.ctx.state.setReviewed(42, 'layer:layer-2/file:src_new_ts', true)
    const fileOff = await t.ctx.state.setReviewed(42, 'layer:layer-2/file:src_new_ts', false)
    expect(fileOff.reviewed).toEqual({})
  })

  it('drops the marks of another commit the first time the head moves', async () => {
    const head = 'a'.repeat(40)
    const next = 'b'.repeat(40)
    const first = await t.ctx.state.setReviewed(42, 'layer:layer-1', true, head)
    expect(first).toMatchObject({ reviewed: { 'layer:layer-1': true }, reviewedHeadSha: head })
    const moved = await t.ctx.state.setReviewed(42, 'layer:layer-2', true, next)
    expect(moved).toMatchObject({ reviewed: { 'layer:layer-2': true }, reviewedHeadSha: next })
    // A state written before this field existed keeps its marks and adopts the head.
    const same = await t.ctx.state.setReviewed(42, 'layer:layer-3', true, next)
    expect(same.reviewed).toEqual({ 'layer:layer-2': true, 'layer:layer-3': true })
  })

  it('dismisses a point with a reason and restores it', async () => {
    const dismissed = await t.ctx.state.setDismissed(42, 'fp-1', true, 'the spec says sum')
    expect(dismissed.dismissed).toEqual({
      'fp-1': { at: '2026-09-10T12:00:00.000Z', reason: 'the spec says sum' },
    })
    const noReason = await t.ctx.state.setDismissed(42, 'fp-2', true)
    expect(noReason.dismissed['fp-2']).toEqual({ at: '2026-09-10T12:00:00.000Z' })
    const restored = await t.ctx.state.setDismissed(42, 'fp-1', false)
    expect(restored.dismissed).toEqual({ 'fp-2': { at: '2026-09-10T12:00:00.000Z' } })
  })

  it('hides a thread by its root comment id and shows it again', async () => {
    const hidden = await t.ctx.state.setThreadHidden(42, 1001, true)
    expect(hidden.hiddenThreads).toEqual({ '1001': { at: '2026-09-10T12:00:00.000Z' } })
    expect((await t.ctx.state.setThreadHidden(42, 1001, false)).hiddenThreads).toEqual({})
  })

  it('records a posted comment once, with the point it came from', async () => {
    await t.ctx.state.addPosted(42, { commentId: 5, pointFingerprint: 'fp-1' })
    const again = await t.ctx.state.addPosted(42, { commentId: 5 })
    expect(again.posted).toEqual([{ commentId: 5, pointFingerprint: 'fp-1', at: '2026-09-10T12:00:00.000Z' }])
    const second = await t.ctx.state.addPosted(42, { commentId: 6 })
    expect(second.posted.map(p => p.commentId)).toEqual([5, 6])
  })

  it('counts up on every write, so the page can order two answers', async () => {
    expect((await t.ctx.state.read(42)).rev).toBe(0)
    expect((await t.ctx.state.setReviewed(42, 'layer:layer-1', true)).rev).toBe(1)
    expect((await t.ctx.state.setDismissed(42, 'fp-1', true)).rev).toBe(2)
    expect((await t.ctx.state.addPosted(42, { commentId: 5 })).rev).toBe(3)
  })

  it('starts counting from a state file that was written before the counter existed', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(t.ctx.prs.prDir(42), { recursive: true })
    const legacy = { ...emptyState('2026-09-01T00:00:00.000Z'), reviewed: { 'layer:layer-1': true } }
    const { rev: _rev, ...withoutRev } = legacy
    await writeFile(`${t.ctx.prs.prDir(42)}/state.json`, JSON.stringify(withoutRev), 'utf8')
    expect((await t.ctx.state.read(42)).rev).toBeUndefined()
    expect((await t.ctx.state.setDismissed(42, 'fp-1', true)).rev).toBe(1)
  })

  it('keeps both changes when two updates for one PR overlap', async () => {
    const [a, b] = await Promise.all([
      t.ctx.state.setReviewed(42, 'layer:layer-1', true),
      t.ctx.state.setDismissed(42, 'fp-9', true),
    ])
    const merged = a.dismissed['fp-9'] === undefined ? b : a
    expect(merged.reviewed).toEqual({ 'layer:layer-1': true })
    expect(Object.keys(merged.dismissed)).toEqual(['fp-9'])
    const onDisk = await readJson(`${t.ctx.prs.prDir(42)}/state.json`, PrStateSchema)
    expect(onDisk).toEqual(merged)
  })

  it('lets the next update through after one of them fails', async () => {
    const failing = t.ctx.state.update(42, () => {
      throw new Error('mutate failed')
    })
    const after = t.ctx.state.setReviewed(42, 'layer:layer-2', true)
    await expect(failing).rejects.toThrow('mutate failed')
    expect((await after).reviewed).toEqual({ 'layer:layer-2': true })
  })

  it('falls back to an empty state when the file holds something else', async () => {
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${t.ctx.prs.prDir(42)}/state.json`, '{"version":"nope"}', 'utf8')
    expect(await t.ctx.state.read(42)).toEqual(emptyState('2026-09-10T12:00:00.000Z'))
  })

  it('accepts only layer and layer-file reviewed ids', () => {
    expect(['layer:layer-1', 'layer:layer-1/file:src_app_ts'].map(isReviewedId)).toEqual([true, true])
    expect(['layer-1', 'layer:', 'layer:a/file:', 'layer:a/file:b/c', '../../etc'].map(isReviewedId)).toEqual(
      [false, false, false, false, false]
    )
  })
})
