// @ts-check
// @vitest-environment node
import { anchorKey, buildThreads } from './threads.js'

/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */

/**
 * @param {Partial<ReviewComment> & { id: number }} c
 * @returns {ReviewComment}
 */
function comment(c) {
  return {
    author: 'a',
    body: 'b',
    path: 'src/app.ts',
    line: 4,
    originalLine: 4,
    side: 'new',
    outdated: false,
    commitId: 'x',
    createdAt: '2026-09-09T10:00:00Z',
    updatedAt: '2026-09-09T10:00:00Z',
    url: 'u',
    resolved: false,
    ...c,
  }
}

describe('buildThreads', () => {
  it('groups replies under their root, marks resolved from any comment, and buckets outdated threads', () => {
    const { byAnchor, outdated, count } = buildThreads([
      comment({ id: 2, inReplyToId: 1, createdAt: '2026-09-09T10:05:00Z', resolved: true }),
      comment({ id: 1 }),
      comment({ id: 3, line: null, outdated: true, side: 'old' }),
      comment({ id: 4, inReplyToId: 99, line: 7 }),
    ])
    expect(count).toBe(3)
    const main = byAnchor.get(anchorKey('src/app.ts', 'new', 4))
    expect(main?.map(t => [t.root.id, t.replies.map(r => r.id), t.resolved])).toEqual([[1, [2], true]])
    expect(byAnchor.get(anchorKey('src/app.ts', 'new', 7))?.map(t => t.root.id)).toEqual([4])
    expect(outdated.get('src/app.ts')?.map(t => t.root.id)).toEqual([3])
  })

  it('returns empty maps for no comments', () => {
    expect(buildThreads([])).toEqual({ byAnchor: new Map(), outdated: new Map(), count: 0 })
  })
})
