// @ts-check
// @vitest-environment node
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { createReviewSession, reviewedId } from './review-session.js'

const artifact = syntheticArtifact()
const BASE = emptyState('2026-09-10T12:00:00.000Z')

/**
 * @param {Partial<import('./review-session.js').SessionApi>} api
 * @param {(state: import('./contract-types.js').PrState) => void} [onState]
 */
function session(api, onState) {
  return createReviewSession({
    prNumber: 42,
    artifact,
    files: artifact.files,
    state: BASE,
    capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
    headSha: artifact.pr.headSha,
    api,
    ...(onState === undefined ? {} : { onState }),
  })
}

/**
 * The server answer: the state it wrote.
 * @param {import('./contract-types.js').PrState} state
 */
function answers(state) {
  return { prNumber: 42, state }
}

describe('reviewedId', () => {
  it('names a layer and one of its files', () => {
    expect(reviewedId('layer-1')).toBe('layer:layer-1')
    expect(reviewedId('layer-1', 'src/app.ts')).toBe('layer:layer-1/file:src_app_ts')
  })
})

describe('createReviewSession', () => {
  it('reads the files by key and answers what is reviewed', () => {
    const s = session({})
    expect(s.pathForKey('src_app_ts')).toBe('src/app.ts')
    expect(s.pathForKey('nope')).toBeUndefined()
    expect(s.isReviewed('layer:layer-1')).toBe(false)
    expect(s.artifact).toBe(artifact)
    expect(s.prNumber).toBe(42)
  })

  it('shows a reviewed change at once and keeps the answer the server sends back', async () => {
    /** @type {Array<import('./contract-types.js').PrState>} */
    const seen = []
    const served = {
      ...BASE,
      reviewed: { 'layer:layer-1': /** @type {const} */ (true) },
      updatedAt: 'server',
    }
    const s = session(
      {
        putReviewed: async () => {
          // By now the page already shows the change.
          expect(s.isReviewed('layer:layer-1')).toBe(true)
          return answers(served)
        },
      },
      state => seen.push(state)
    )
    await s.setReviewed('layer:layer-1', true)
    expect(seen.map(st => st.updatedAt)).toEqual([BASE.updatedAt, 'server'])
    expect(s.state).toBe(served)
  })

  it('puts the state back and passes the failure on when the server refuses', async () => {
    const failure = new Error('403')
    /** @type {Array<import('./contract-types.js').PrState>} */
    const seen = []
    const s = session(
      {
        putReviewed: () => Promise.reject(failure),
      },
      state => seen.push(state)
    )
    await expect(s.setReviewed('layer:layer-1', true)).rejects.toBe(failure)
    expect(s.state).toEqual(BASE)
    expect(seen.map(st => st.reviewed['layer:layer-1'])).toEqual([true, undefined])
  })

  it('unmarks a layer', async () => {
    const s = session({
      putReviewed: async (_pr, _id, reviewed) => answers({ ...BASE, reviewed: reviewed ? { x: true } : {} }),
    })
    await s.setReviewed('layer:layer-1', true)
    const off = await s.setReviewed('layer:layer-1', false)
    expect(off.reviewed).toEqual({})
  })

  it('dismisses and restores a point', async () => {
    /** @type {Array<boolean>} */
    const asked = []
    const s = session({
      putDismissed: async (_pr, fingerprint, dismissed) => {
        asked.push(dismissed)
        return answers({
          ...BASE,
          dismissed: dismissed ? { [fingerprint]: { at: 'server' } } : {},
        })
      },
    })
    expect((await s.setDismissed('fp-1', true)).dismissed).toEqual({ 'fp-1': { at: 'server' } })
    expect((await s.setDismissed('fp-1', false)).dismissed).toEqual({})
    expect(asked).toEqual([true, false])
  })

  it('hides and shows a thread', async () => {
    const s = session({
      putThreadHidden: async (_pr, id, hidden) =>
        answers({ ...BASE, hiddenThreads: hidden ? { [String(id)]: { at: 'server' } } : {} }),
    })
    expect((await s.setThreadHidden(1001, true)).hiddenThreads).toEqual({ 1001: { at: 'server' } })
    expect((await s.setThreadHidden(1001, false)).hiddenThreads).toEqual({})
  })

  it('keeps the state the comment route returns', async () => {
    const posted = { ...BASE, posted: [{ commentId: 5001, at: 'server' }] }
    const s = session({
      postComment: async () => ({
        kind: /** @type {const} */ ('issue'),
        comment: {
          id: 5001,
          author: 'octocat',
          body: 'x',
          createdAt: 'now',
          updatedAt: 'now',
          url: 'https://github.com/x',
        },
        state: posted,
      }),
    })
    const answer = await s.postComment({ kind: 'issue', body: 'x' })
    expect(answer.comment.id).toBe(5001)
    expect(s.state).toBe(posted)
  })

  it('posts a review with and without an edited body', async () => {
    /** @type {unknown[]} */
    const sent = []
    const s = session({
      postReview: async (_pr, input) => {
        sent.push(input)
        return {
          review: { id: 7, state: 'APPROVED', url: 'https://github.com/r', submittedAt: null },
          submitted: 0,
          state: BASE,
        }
      },
    })
    expect((await s.postReview('APPROVE')).review.id).toBe(7)
    await s.postReview('REQUEST_CHANGES', 'edited')
    await s.postReview('COMMENT', 'no verdict', { includePending: false })
    expect(sent).toEqual([
      { event: 'APPROVE', headSha: artifact.pr.headSha },
      { event: 'REQUEST_CHANGES', body: 'edited', headSha: artifact.pr.headSha },
      {
        event: 'COMMENT',
        body: 'no verdict',
        includePending: false,
        headSha: artifact.pr.headSha,
      },
    ])
  })

  it('puts a mark, a dismissal, and a hidden thread back when the server refuses to undo them', async () => {
    const marked = { ...BASE, reviewed: { 'layer:layer-1': /** @type {const} */ (true) } }
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: {
        ...marked,
        dismissed: { 'fp-1': { at: 'earlier' } },
        hiddenThreads: { 1001: { at: 'earlier' } },
      },
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: () => Promise.reject(new Error('offline')),
        putDismissed: () => Promise.reject(new Error('offline')),
        putThreadHidden: () => Promise.reject(new Error('offline')),
      },
    })
    await expect(s.setReviewed('layer:layer-1', false)).rejects.toThrow('offline')
    await expect(s.setDismissed('fp-1', false)).rejects.toThrow('offline')
    await expect(s.setThreadHidden(1001, false)).rejects.toThrow('offline')
    expect(s.state.reviewed).toEqual({ 'layer:layer-1': true })
    expect(Object.keys(s.state.dismissed)).toEqual(['fp-1'])
    expect(Object.keys(s.state.hiddenThreads)).toEqual(['1001'])
  })

  it('lets a listener unsubscribe', async () => {
    /** @type {number[]} */
    const counts = []
    const s = session({ putReviewed: async () => answers(BASE) })
    const off = s.subscribe(() => counts.push(1))
    await s.setReviewed('layer:layer-1', true)
    off()
    await s.setReviewed('layer:layer-1', false)
    expect(counts).toHaveLength(2)
  })

  it('holds the capabilities the probe answered with', () => {
    const s = session({})
    s.setCapabilities({ canComment: false, tokenKind: 'classic', login: 'octocat', reason: 'no scope' })
    expect(s.capabilities.canComment).toBe(false)
  })
})

describe('changes that overlap', () => {
  it('takes back only the change that failed', async () => {
    /** @type {Array<() => void>} */
    const finish = []
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: BASE,
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: () =>
          new Promise((_resolve, reject) => {
            finish.push(() => reject(new Error('offline')))
          }),
        putDismissed: async () => answers({ ...BASE, dismissed: { 'fp-1': { at: 'server' } } }),
      },
    })
    const failing = s.setReviewed('layer:layer-1', true)
    await s.setDismissed('fp-1', true)
    finish[0]?.()
    await expect(failing).rejects.toThrow('offline')
    expect(s.state.reviewed).toEqual({})
    expect(Object.keys(s.state.dismissed)).toEqual(['fp-1'])
  })

  it('keeps the state the server wrote when another change fails, without undoing it', async () => {
    /** @type {Array<() => void>} */
    const finish = []
    // The server clears the file marks with the layer, and answers with what it wrote.
    const cleared = { ...BASE, rev: 9, reviewed: {} }
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: {
        ...BASE,
        rev: 7,
        reviewed: { 'layer:layer-1': true, 'layer:layer-1/file:src_app_ts': true },
      },
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: (_pr, id) =>
          id === 'layer:layer-1'
            ? new Promise((_resolve, reject) => {
                finish.push(() => reject(new Error('offline')))
              })
            : Promise.resolve(answers(cleared)),
      },
    })
    const failing = s.setReviewed('layer:layer-1', false)
    await s.setReviewed('layer:layer-1/file:src_app_ts', false)
    finish[0]?.()
    await expect(failing).rejects.toThrow('offline')
    expect(s.state.reviewed).toEqual({})
  })

  it('keeps what a comment recorded when another change fails at the same time', async () => {
    /** @type {Array<() => void>} */
    const finish = []
    const posted = { ...BASE, posted: [{ commentId: 5001, at: 'server' }] }
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: BASE,
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: () =>
          new Promise((_resolve, reject) => {
            finish.push(() => reject(new Error('offline')))
          }),
        postComment: async () => ({
          kind: /** @type {const} */ ('issue'),
          comment: {
            id: 5001,
            author: 'o',
            body: 'x',
            createdAt: 'n',
            updatedAt: 'n',
            url: 'https://x.test',
          },
          state: posted,
        }),
      },
    })
    const failing = s.setReviewed('layer:layer-1', true)
    await s.postComment({ kind: 'issue', body: 'x' })
    finish[0]?.()
    await expect(failing).rejects.toThrow('offline')
    expect(s.state.posted).toEqual(posted.posted)
    expect(s.state.reviewed).toEqual({})
  })

  it('ignores an answer that describes an older write than the one it already took', async () => {
    /** @type {number[]} */
    const revs = [9, 3]
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: { ...BASE, rev: 8 },
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: async (_pr, id) =>
          answers({ ...BASE, rev: revs.shift() ?? 0, reviewed: { [id]: /** @type {const} */ (true) } }),
      },
    })
    await s.setReviewed('layer:layer-1', true)
    expect(s.state.rev).toBe(9)
    // A second call answers with an older write, which says nothing new about the page.
    await s.setReviewed('layer:layer-2', true)
    expect(s.state.rev).toBe(9)
    expect(s.state.reviewed).toEqual({ 'layer:layer-1': true, 'layer:layer-2': true })
  })

  it('keeps the exact value a failed change replaced, reason and time included', async () => {
    const before = { at: 'earlier', reason: 'the spec says sum' }
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: { ...BASE, dismissed: { 'fp-1': before } },
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: { putDismissed: () => Promise.reject(new Error('offline')) },
    })
    await expect(s.setDismissed('fp-1', false)).rejects.toThrow('offline')
    expect(s.state.dismissed['fp-1']).toEqual(before)
  })

  it('takes the newest write when an older answer arrives after it', async () => {
    /** @type {Array<(state: import('./contract-types.js').PrState) => void>} */
    const finish = []
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: { ...BASE, rev: 4 },
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: () =>
          new Promise(resolve => {
            finish.push(state => resolve(answers(state)))
          }),
      },
    })
    const first = s.setReviewed('layer:layer-1', true)
    const second = s.setReviewed('layer:layer-2', true)
    // The server wrote the first call (rev 5) and then the second (rev 6), but the answer of
    // the second one overtakes the first on the way back.
    finish[1]?.({ ...BASE, rev: 6, reviewed: { 'layer:layer-1': true, 'layer:layer-2': true } })
    finish[0]?.({ ...BASE, rev: 5, reviewed: { 'layer:layer-1': true } })
    await Promise.all([first, second])
    expect(s.state.rev).toBe(6)
    expect(s.state.reviewed).toEqual({ 'layer:layer-1': true, 'layer:layer-2': true })
  })

  it('takes the state of the answer that comes back last when no write count is given', async () => {
    /** @type {Array<(state: import('./contract-types.js').PrState) => void>} */
    const finish = []
    const s = createReviewSession({
      prNumber: 42,
      artifact,
      files: artifact.files,
      state: BASE,
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: () =>
          new Promise(resolve => {
            finish.push(state => resolve(answers(state)))
          }),
      },
    })
    const first = s.setReviewed('layer:layer-1', true)
    const second = s.setReviewed('layer:layer-2', true)
    // The second call reaches the server first, so its answer knows only its own mark. The
    // first call is written after it, and its answer, which comes back last, holds both.
    finish[1]?.({ ...BASE, reviewed: { 'layer:layer-2': true } })
    finish[0]?.({
      ...BASE,
      reviewed: { 'layer:layer-1': true, 'layer:layer-2': true },
      updatedAt: 'from the server',
    })
    await Promise.all([first, second])
    expect(s.state.reviewed).toEqual({ 'layer:layer-1': true, 'layer:layer-2': true })
    expect(s.state.updatedAt).toBe('from the server')
  })
})
