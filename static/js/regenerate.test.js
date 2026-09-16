// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/host/capabilities.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import {
  canvasChanged,
  openRegenerateDialog,
  REGENERATE_DIALOG_ID,
  regenerateDialogHtml,
} from './regenerate.js'

/** @typedef {import('./contract-types.js').PrBundle} PrBundle */

/**
 * @param {'ready' | 'missing'} status
 * @param {{ headSha?: string, generatedAt?: string }} [over]
 * @returns {PrBundle}
 */
function bundle(status, over = {}) {
  const artifact = syntheticArtifact()
  if (over.generatedAt) {
    artifact.generatedAt = over.generatedAt
  }
  /** @type {PrBundle} */
  const base = {
    status,
    pr: artifact.pr,
    files: artifact.files,
    derivable: true,
    skillCommand: '/pr-review-canvas 42 --force',
    comments: { fetchedAt: 'x', headSha: artifact.pr.headSha, reviewComments: [], issueComments: [] },
    state: emptyState('x'),
    capabilities: UNKNOWN_CAPABILITIES,
    chat: { enabled: true, acpx: true },
    largePr: false,
    warnings: [],
  }
  if (status === 'ready') {
    base.artifact = artifact
    base.canvas = { headSha: over.headSha ?? artifact.pr.headSha, source: 'local', manifest: null }
  }
  return base
}

describe('regenerate dialog', () => {
  it('renders the command with a copy command and a close command', () => {
    document.body.innerHTML = regenerateDialogHtml('/pr-review-canvas 42 --force')
    const dialog = document.querySelector(`#${REGENERATE_DIALOG_ID}`)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Regenerate the canvas')
    expect(dialog?.querySelector('code')?.textContent).toBe('/pr-review-canvas 42 --force')
    expect(dialog?.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe(
      '/pr-review-canvas 42 --force'
    )
    expect(dialog?.querySelector('.cmd.fill')?.textContent).toBe('copy')
    expect(dialog?.querySelector('.dialog-actions .cmd')?.textContent).toBe('close')
  })

  it('creates the dialog once, updates the command, and opens it', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const first = openRegenerateDialog(root, '/pr-review-canvas 1 --force')
    expect(first.open).toBe(true)
    expect(first.querySelector('code')?.textContent).toBe('/pr-review-canvas 1 --force')
    first.close()
    const second = openRegenerateDialog(root, '/pr-review-canvas 2 --force')
    expect(second).toBe(first)
    expect(root.querySelectorAll('dialog').length).toBe(1)
    expect(second.querySelector('code')?.textContent).toBe('/pr-review-canvas 2 --force')
    expect(second.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe('/pr-review-canvas 2 --force')
    expect(second.open).toBe(true)
  })

  it('falls back to the open attribute when showModal is missing, and throws when the dialog cannot render', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const dialog = document.createElement('dialog')
    dialog.id = REGENERATE_DIALOG_ID
    dialog.innerHTML = '<code></code><button data-copy=""></button>'
    Object.defineProperty(dialog, 'showModal', { value: undefined })
    root.appendChild(dialog)
    expect(openRegenerateDialog(root, 'cmd').hasAttribute('open')).toBe(true)
    const broken = document.createElement('div')
    const orig = document.createElement
    document.createElement = /** @type {typeof document.createElement} */ (
      (/** @type {string} */ tag) => {
        const el = orig.call(document, tag)
        if (tag === 'template') {
          Object.defineProperty(el, 'content', { value: document.createDocumentFragment() })
        }
        return el
      }
    )
    expect(() => openRegenerateDialog(broken, 'cmd')).toThrow('regenerate dialog did not render')
    document.createElement = orig
  })
})

describe('canvasChanged', () => {
  it('is true for a new head or a newer generatedAt, false for the same canvas or no canvas', () => {
    const current = bundle('ready')
    expect(canvasChanged(current, bundle('ready'))).toBe(false)
    expect(canvasChanged(current, bundle('ready', { headSha: 'f'.repeat(40) }))).toBe(true)
    expect(canvasChanged(current, bundle('ready', { generatedAt: '2030-01-01T00:00:00.000Z' }))).toBe(true)
    expect(canvasChanged(current, bundle('missing'))).toBe(false)
    expect(canvasChanged(bundle('missing'), bundle('ready'))).toBe(true)
  })
})
