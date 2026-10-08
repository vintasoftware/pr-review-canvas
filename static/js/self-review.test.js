// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { openPoints, pointCardHtml, pointCommandsHtml, pointStatus } from './points.js'
import { createReviewSession } from './review-session.js'
import {
  audiencePillHtml,
  selfReviewActions,
  selfReviewNoteHtml,
  setSelfReview,
  settleButtonHtml,
  reopenButtonHtml,
  settleFormHtml,
  sharingNote,
} from './self-review.js'

const artifact = syntheticArtifact()
const [decide, tests, debt] = artifact.points
if (decide === undefined || tests === undefined || debt === undefined) {
  throw new Error('the synthetic canvas has three points')
}
const state = emptyState('2026-09-10T12:00:00.000Z')
const settlement = { reason: 'Covered by `e2e`.', at: '2026-09-10T12:00:00.000Z' }
const ctx = { paths: new Set(['src/app.ts']) }

afterEach(() => setSelfReview(false, {}))

describe('what a reader sees', () => {
  it('names the audience, as yours for the author', () => {
    expect(audiencePillHtml(tests)).toContain('>author<')
    expect(audiencePillHtml(decide)).toContain('>reviewer<')
    setSelfReview(true, {})
    expect(audiencePillHtml(tests)).toContain('>yours<')
  })

  it('offers settle only to the author, on any unsettled point, a reviewer point too', () => {
    expect(settleButtonHtml(tests)).toBe('')
    expect(settleButtonHtml(decide)).toBe('')
    setSelfReview(true, { [tests.fingerprint]: settlement })
    expect(settleButtonHtml(tests)).toBe('')
    expect(settleButtonHtml(debt)).toContain('data-act="point-settle"')
    expect(settleButtonHtml(decide)).toContain('data-act="point-settle"')
  })

  it('lets the author reopen any settled point, a reviewer point too', () => {
    expect(reopenButtonHtml(decide)).toBe('')
    setSelfReview(true, { [decide.fingerprint]: settlement })
    expect(reopenButtonHtml(tests)).toBe('')
    document.body.innerHTML = `<ol>${pointCardHtml(decide, { ...ctx, state })}</ol>`
    expect(document.querySelector('[data-act="point-unsettle"]')?.getAttribute('data-fingerprint')).toBe(
      decide.fingerprint
    )
  })

  it('keeps a settled point in place, collapsed with its reason, for every reader', () => {
    setSelfReview(false, { [tests.fingerprint]: settlement })
    expect(pointStatus(tests, state)).toBe('resolved')
    // A resolution is the answer for everyone, so it wins over the reader's own dismissal.
    expect(pointStatus(tests, { ...state, dismissed: { [tests.fingerprint]: { at: 'x' } } })).toBe('resolved')
    expect(openPoints(artifact.points, state).map(p => p.id)).toEqual(['p-1', 'p-3'])
    document.body.innerHTML = `<ol>${pointCardHtml(tests, { ...ctx, state })}</ol>`
    const card = document.querySelector('li.finding')
    expect(card?.hasAttribute('hidden')).toBe(false)
    expect(card?.classList.contains('is-handled')).toBe(true)
    expect(card?.querySelector('.pill.status.resolved')?.textContent).toBe('resolved')
    expect(card?.querySelector('.p-summary')?.textContent).toBe('Resolved by the author: Covered by `e2e`.')
    expect(card?.querySelector('.settled-reason code')?.textContent).toBe('e2e')
    // A reader who is not the author can read the reason but not take it back.
    expect(card?.querySelector('[data-act="point-unsettle"]')).toBeNull()
    expect(card?.querySelector('[data-act="point-settle"]')).toBeNull()
  })

  it('keeps dismiss as a personal hide in self-review, which does not resolve the point', () => {
    const dismissed = {
      ...state,
      dismissed: Object.fromEntries(artifact.points.map(p => [p.fingerprint, { at: 'x' }])),
    }
    setSelfReview(true, { [tests.fingerprint]: settlement })
    expect(openPoints(artifact.points, dismissed)).toEqual([])
    expect(artifact.points.map(p => pointStatus(p, dismissed))).toEqual([
      'dismissed',
      'resolved',
      'dismissed',
    ])
    expect(pointCommandsHtml(debt)).toContain('>resolve</button>')
    expect(pointCommandsHtml(debt)).toContain('point-dismiss')
    expect(pointCommandsHtml(decide)).toContain('point-dismiss')
    expect(pointCommandsHtml(decide)).toContain('point-settle')
    // A dismissed point offers restore, and resolve only after it.
    expect(pointCommandsHtml(decide, { status: 'dismissed' })).toContain('point-restore')
    expect(pointCommandsHtml(decide, { status: 'dismissed' })).not.toContain('point-settle')
    // A point waiting in the review or posted can still be answered by the author.
    expect(pointCommandsHtml(decide, { status: 'queued' })).toContain('point-settle')
    expect(pointCommandsHtml(decide, { status: 'posted' })).toContain('point-settle')
    // The note counts what the author has not settled, dismissed or not.
    expect(selfReviewNoteHtml(artifact.points)).toContain('1 point is marked yours')
    expect(selfReviewNoteHtml(artifact.points)).toContain('1 point goes to the reviewer')
  })

  it('hides the note when there is nothing to show', () => {
    expect(selfReviewNoteHtml(artifact.points)).toContain('hidden')
    setSelfReview(true, {})
    expect(selfReviewNoteHtml([decide])).toContain('Self-review done')
    expect(selfReviewNoteHtml([decide])).not.toContain('Resolve what you can')
    expect(selfReviewNoteHtml([decide])).toContain('1 point goes to the reviewer')
    expect(selfReviewNoteHtml([tests, decide, debt])).toContain('2 points are marked yours')
    expect(selfReviewNoteHtml([tests, decide, debt])).toContain('including a reviewer point')
    expect(selfReviewNoteHtml([tests])).toContain('1 point is marked yours')
    expect(selfReviewNoteHtml([tests])).toContain('0 points go to the reviewer')
    expect(selfReviewNoteHtml([tests])).toContain('the canvas comment updates')
    setSelfReview(true, {}, false)
    expect(selfReviewNoteHtml([tests])).toContain('it is written into this canvas')
    expect(selfReviewNoteHtml([tests])).not.toContain('canvas comment')
  })

  it('offers to post the reason only where a comment can go', () => {
    expect(settleFormHtml(tests, { canPost: true })).toContain('settle-comment')
    expect(settleFormHtml(tests, { canPost: false })).not.toContain('settle-comment')
  })

  it('says whether the shared canvas followed', () => {
    expect(sharingNote({ status: 'shared', url: 'u' }, 'point settled')).toBe(
      'point settled; the canvas comment is updated for reviewers'
    )
    expect(sharingNote({ status: 'local' }, 'point reopened')).toBe('point reopened in this canvas')
    expect(sharingNote({ status: 'off' }, 'point settled')).toBe(
      'point settled in this canvas; the canvas comment is off'
    )
    expect(sharingNote({ status: 'failed', warning: 'no network', zipPath: '/z' }, 'point settled')).toBe(
      'point settled here, but the canvas comment was not updated: no network'
    )
  })
})

describe('the commands', () => {
  /** @param {import('./contract-types.js').ReviewKey} prNumber @param {Partial<import('./review-session.js').SessionApi>} [api] */
  const sessionFor = (prNumber, api = {}) =>
    createReviewSession({
      prNumber,
      artifact,
      files: artifact.files,
      state,
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api,
    })
  const pointHtml = `<li><div><span class="tbtns"><button class="cmd" data-act="point-settle" data-fingerprint="${tests.fingerprint}">settle</button></span></div></li>`

  it('opens the box without the comment option on local work', () => {
    document.body.innerHTML = pointHtml
    const actions = selfReviewActions(sessionFor('branch'), () => undefined)
    const button = document.querySelector('[data-act="point-settle"]')
    if (!(button instanceof HTMLElement)) throw new Error('no button')
    actions['point-settle']?.(button)
    expect(document.querySelector('.settle-box')).not.toBeNull()
    expect(document.querySelector('input[name="settle-comment"]')).toBeNull()
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })

  it.each([
    ['names no point', '<span class="tbtns"><button data-act="point-settle">settle</button></span>'],
    [
      'sits outside the commands',
      `<button data-act="point-settle" data-fingerprint="${tests.fingerprint}">settle</button>`,
    ],
  ])('opens no box for a command that %s', (_why, html) => {
    document.body.innerHTML = html
    const button = document.querySelector('button')
    if (!(button instanceof HTMLElement)) throw new Error('no button')
    selfReviewActions(sessionFor(42), () => undefined)['point-settle']?.(button)
    expect(document.querySelector('.settle-box')).toBeNull()
  })

  it('sends nothing for a save or a reopen that names no point', async () => {
    const calls = /** @type {unknown[]} */ ([])
    const actions = selfReviewActions(
      sessionFor(42, {
        putSettled: async (...args) => {
          calls.push(args)
          throw new Error('unexpected')
        },
      }),
      () => undefined
    )
    document.body.innerHTML =
      '<button data-act="settle-save">settle</button><button data-act="point-unsettle">reopen</button>'
    const [save, reopen] = Array.from(document.querySelectorAll('button'))
    if (save === undefined || reopen === undefined) throw new Error('no buttons')
    actions['settle-save']?.(save)
    actions['point-unsettle']?.(reopen)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([])
    expect(document.body.textContent).toContain('write the reason first')
  })

  it('keeps the box and shows the error when the server refuses', async () => {
    document.body.innerHTML = pointHtml
    const notes = /** @type {string[]} */ ([])
    const actions = selfReviewActions(
      sessionFor(42, {
        putSettled: async () => {
          throw new Error('only octocat settles')
        },
      }),
      note => notes.push(note)
    )
    const button = document.querySelector('[data-act="point-settle"]')
    if (!(button instanceof HTMLElement)) throw new Error('no button')
    actions['point-settle']?.(button)
    const reason = document.querySelector('.settle-box textarea')
    const save = document.querySelector('[data-act="settle-save"]')
    if (!(reason instanceof HTMLTextAreaElement) || !(save instanceof HTMLElement)) throw new Error('no box')
    reason.value = 'Covered.'
    actions['settle-save']?.(save)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('.settle-box')).not.toBeNull()
    expect(document.body.textContent).toContain('only octocat settles')
    expect(notes).toEqual([])
  })
})
