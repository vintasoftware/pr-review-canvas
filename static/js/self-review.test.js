// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { dismissedListHtml, isSetAside, openPoints } from './points.js'
import { createReviewSession } from './review-session.js'
import {
  audiencePillHtml,
  selfReviewActions,
  selfReviewNoteHtml,
  setSelfReview,
  settleButtonHtml,
  settledListHtml,
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

  it('offers settle only to the author, and only on an unsettled point', () => {
    expect(settleButtonHtml(tests)).toBe('')
    setSelfReview(true, { [tests.fingerprint]: settlement })
    expect(settleButtonHtml(tests)).toBe('')
    expect(settleButtonHtml(debt)).toContain('data-act="point-settle"')
    expect(settleButtonHtml(decide)).toBe('')
  })

  it('sets settled points aside with dismissed ones, and lists each once', () => {
    setSelfReview(false, { [tests.fingerprint]: settlement })
    const dismissed = {
      ...state,
      dismissed: { [tests.fingerprint]: { at: 'x' }, [debt.fingerprint]: { at: 'x' } },
    }
    expect(isSetAside(tests, state)).toBe(true)
    expect(openPoints(artifact.points, state).map(p => p.id)).toEqual(['p-1', 'p-3'])
    document.body.innerHTML = dismissedListHtml(artifact.points, dismissed, ctx)
    expect(document.querySelector('.dismissed-line')?.textContent).toContain('1 dismissed')
    document.body.innerHTML = settledListHtml(artifact.points, ctx, true)
    expect(document.querySelector('.settled-reason code')?.textContent).toBe('e2e')
    expect(document.querySelector('.findings.settled')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('[data-act="point-unsettle"]')).toBeNull()
  })

  it('hides the settled list and the note when there is nothing to show', () => {
    expect(settledListHtml(artifact.points, ctx)).toBe('<div class="settled-list" hidden></div>')
    expect(selfReviewNoteHtml(artifact.points)).toContain('hidden')
    setSelfReview(true, {})
    expect(selfReviewNoteHtml([decide])).toContain('Self-review done')
    expect(selfReviewNoteHtml([decide])).toContain('1 point goes to the reviewer')
    expect(selfReviewNoteHtml([tests, decide, debt])).toContain('2 points are marked yours')
    expect(selfReviewNoteHtml([tests])).toContain('1 point is marked yours')
    expect(selfReviewNoteHtml([tests])).toContain('0 points go to the reviewer')
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
