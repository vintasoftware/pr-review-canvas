// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import {
  approveBlockedReason,
  externalLink,
  fillSignoffDialog,
  openSignoffDialog,
  SIGNOFF_DIALOG_ID,
  showSignoffError,
  showSignoffResult,
  signoffBody,
  signoffDialogHtml,
  signoffTitle,
} from './signoff.js'

const artifact = syntheticArtifact()
const BASE = emptyState('2026-09-10T12:00:00.000Z')

describe('approveBlockedReason', () => {
  it('names the one layer that is still open', () => {
    expect(approveBlockedReason(artifact, BASE)).toBe('1 layer is not reviewed yet: Run path')
  })

  it('counts them when more than one is open', () => {
    const two = {
      ...artifact,
      layers: [...artifact.layers, { ...artifact.layers[0], id: 'layer-3', key: 'third', title: 'Third' }],
    }
    expect(approveBlockedReason(/** @type {typeof artifact} */ (two), BASE)).toBe('2 layers are not reviewed yet')
  })

  it('clears once every layer that is not Other is reviewed', () => {
    const done = { ...BASE, reviewed: { 'layer:layer-1': /** @type {const} */ (true) } }
    expect(approveBlockedReason(artifact, done)).toBeNull()
  })
})

describe('the sign-off dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '<pr-app id="root"></pr-app>'
  })

  /** @returns {HTMLElement} */
  function root() {
    const el = document.querySelector('#root')
    if (!(el instanceof HTMLElement)) {
      throw new Error('no root')
    }
    return el
  }

  it('names the event and asks for the body', () => {
    expect([signoffTitle('APPROVE'), signoffTitle('REQUEST_CHANGES')]).toEqual([
      'Approve on GitHub',
      'Request changes on GitHub',
    ])
    expect(signoffDialogHtml({ event: 'APPROVE' })).toContain(SIGNOFF_DIALOG_ID)
  })

  it('opens once, reuses the element, and switches to the other event', () => {
    const first = openSignoffDialog(root(), { event: 'APPROVE' })
    expect(first.getAttribute('data-event')).toBe('APPROVE')
    expect(first.querySelector('#signoff-h')?.textContent).toBe('Approve on GitHub')
    expect(signoffBody(first)).toBe('')
    expect(first.querySelector('[data-act="signoff-post"]')?.hasAttribute('disabled')).toBe(true)
    const second = openSignoffDialog(root(), { event: 'REQUEST_CHANGES' })
    expect(second).toBe(first)
    expect(second.getAttribute('data-event')).toBe('REQUEST_CHANGES')
    expect(document.querySelectorAll('dialog').length).toBe(1)
    expect(second.querySelector('[data-act="signoff-post"]')?.hasAttribute('data-needs-post')).toBe(true)
  })

  it('shows the generated body and the commit it lands on', () => {
    const dialog = openSignoffDialog(root(), { event: 'APPROVE' })
    fillSignoffDialog(dialog, { headSha: 'a'.repeat(40), body: 'Reviewed 1 of 1 layer.', unreviewed: [] })
    expect(signoffBody(dialog)).toBe('Reviewed 1 of 1 layer.')
    expect(dialog.querySelector('textarea')?.hasAttribute('aria-busy')).toBe(false)
    expect(dialog.querySelector('[data-act="signoff-post"]')?.hasAttribute('disabled')).toBe(false)
    expect(dialog.querySelector('.signoff-target')?.textContent).toBe('on commit aaaaaaa')
  })

  it('shows the link to the review it posted, and clears it when reopened', () => {
    const dialog = openSignoffDialog(root(), { event: 'APPROVE' })
    showSignoffResult(dialog, {
      id: 7,
      state: 'APPROVED',
      url: 'https://github.com/acme/widgets/pull/42',
      submittedAt: null,
    })
    expect(dialog.querySelector('.signoff-result a')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42'
    )
    openSignoffDialog(root(), { event: 'APPROVE' })
    expect(dialog.querySelector('.signoff-result')?.textContent).toBe('')
  })

  it('says inside itself when the body could not be read', () => {
    const dialog = openSignoffDialog(root(), { event: 'APPROVE' })
    showSignoffError(dialog, 'the server said no')
    expect(dialog.querySelector('.signoff-result')?.textContent).toBe('the server said no')
    expect(dialog.querySelector('[data-act="signoff-post"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('builds a link only for an http address', () => {
    expect(externalLink('javascript:alert(1)', 'x').hasAttribute('href')).toBe(false)
    const ok = externalLink('https://github.com/x', 'x')
    expect([ok.getAttribute('href'), ok.rel]).toEqual(['https://github.com/x', 'noopener noreferrer'])
  })
})

describe('a dialog the page stripped of its parts', () => {
  it('leaves what is missing alone instead of failing', () => {
    document.body.innerHTML = '<dialog id="signoff-dialog"></dialog>'
    const dialog = document.querySelector('#signoff-dialog')
    if (!(dialog instanceof HTMLDialogElement)) {
      throw new Error('no dialog')
    }
    expect(signoffBody(dialog)).toBe('')
    expect(fillSignoffDialog(dialog, { headSha: 'a'.repeat(40), body: 'x', unreviewed: [] })).toBe(dialog)
    expect(showSignoffResult(dialog, { id: 1, state: 'APPROVED', url: 'https://x.test', submittedAt: null })).toBeNull()
  })

  it('opens an element that has no showModal, and refuses one that is not a dialog', () => {
    document.body.innerHTML = '<div id="root"><dialog id="signoff-dialog"></dialog></div>'
    const root = document.querySelector('#root')
    const dialog = document.querySelector('#signoff-dialog')
    if (!(root instanceof HTMLElement && dialog instanceof HTMLDialogElement)) {
      throw new Error('no root')
    }
    Object.defineProperty(dialog, 'showModal', { value: undefined, configurable: true })
    expect(openSignoffDialog(root, { event: 'APPROVE' }).hasAttribute('open')).toBe(true)
    document.body.innerHTML = '<div id="root2"><p id="signoff-dialog"></p></div>'
    const other = document.querySelector('#root2')
    if (!(other instanceof HTMLElement)) {
      throw new Error('no root')
    }
    expect(() => openSignoffDialog(other, { event: 'APPROVE' })).toThrow('sign-off dialog did not render')
  })
})
