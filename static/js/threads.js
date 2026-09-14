// @ts-check
/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */

/**
 * @typedef {{ root: ReviewComment, replies: ReviewComment[], resolved: boolean, outdated: boolean, path: string, side: 'new' | 'old', line: number | null }} Thread
 */

/**
 * @param {string} path
 * @param {'new' | 'old'} side
 * @param {number} line
 */
export function anchorKey(path, side, line) {
  return `${path}|${side}|${line}`
}

/**
 * Groups review comments into threads by `inReplyToId`. Threads keyed by their anchor line;
 * outdated threads (no current line) go to the `outdated` bucket per path.
 * @param {ReadonlyArray<ReviewComment>} comments
 * @returns {{ byAnchor: Map<string, Thread[]>, outdated: Map<string, Thread[]>, count: number }}
 */
export function buildThreads(comments) {
  /** @type {Map<number, Thread>} */
  const roots = new Map()
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const c of sorted) {
    if (c.inReplyToId === undefined) {
      roots.set(c.id, {
        root: c,
        replies: [],
        resolved: c.resolved,
        outdated: c.outdated,
        path: c.path,
        side: c.side,
        line: c.line,
      })
    }
  }
  for (const c of sorted) {
    if (c.inReplyToId === undefined) {
      continue
    }
    const t = roots.get(c.inReplyToId)
    if (t) {
      t.replies.push(c)
      t.resolved = t.resolved || c.resolved
    } else {
      // A reply whose root was deleted: show it as its own thread.
      roots.set(c.id, {
        root: c,
        replies: [],
        resolved: c.resolved,
        outdated: c.outdated,
        path: c.path,
        side: c.side,
        line: c.line,
      })
    }
  }
  /** @type {Map<string, Thread[]>} */
  const byAnchor = new Map()
  /** @type {Map<string, Thread[]>} */
  const outdated = new Map()
  for (const t of roots.values()) {
    if (t.outdated || t.line === null) {
      const list = outdated.get(t.path) ?? []
      list.push(t)
      outdated.set(t.path, list)
      continue
    }
    const k = anchorKey(t.path, t.side, t.line)
    const list = byAnchor.get(k) ?? []
    list.push(t)
    byAnchor.set(k, list)
  }
  return { byAnchor, outdated, count: roots.size }
}
