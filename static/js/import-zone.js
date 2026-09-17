// @ts-check
// The drop zone of the empty and stale screens: pick or drop a zip, POST it, and show what
// happened next to the zone instead of in the console.
/** @typedef {import('./contract-types.js').ImportResult} ImportResult */
/** @typedef {import('./empty-state.js').DropState} DropState */
/** @typedef {typeof import('./api.js').importCanvas} ImportCanvas */
import { clearCommandError, showCommandError } from './commands.js'
import { qs } from './dom.js'
import { DROP_ZONE_ID, dropReducer, INITIAL_DROP_STATE, validateCanvasFilename } from './empty-state.js'

/**
 * @param {DropState} state
 * @returns {string}
 */
export function dropStatusText(state) {
  if (state.phase === 'busy') {
    return `importing… ${Math.round(state.progress * 100)}%`
  }
  return state.phase === 'over' ? 'drop to import' : ''
}

/**
 * @typedef {{
 *   prNumber: number,
 *   importImpl: ImportCanvas,
 *   onImported: (result: ImportResult) => void,
 * }} DropZoneOptions
 */

/**
 * @typedef {{ element: HTMLElement, send: (file: File) => Promise<void>, state: () => DropState }} DropZone
 */

/**
 * Wires the zone under `root`. Returns null when the screen has no drop zone.
 * @param {HTMLElement} root
 * @param {DropZoneOptions} opts
 * @returns {DropZone | null}
 */
export function wireDropZone(root, opts) {
  const label = qs('.drop', root)
  const input = qs(`#${DROP_ZONE_ID}`, root)
  const status = qs('.drop-status', root)
  if (!(label instanceof HTMLElement && input instanceof HTMLInputElement && status instanceof HTMLElement)) {
    return null
  }
  let state = INITIAL_DROP_STATE
  const apply = (/** @type {import('./empty-state.js').DropEvent} */ event) => {
    state = dropReducer(state, event)
    label.classList.toggle('over', state.phase === 'over')
    status.textContent = dropStatusText(state)
    if (state.error === null) {
      clearCommandError(status)
    } else {
      showCommandError(status, state.error)
    }
  }
  const send = async (/** @type {File} */ file) => {
    const problem = validateCanvasFilename(file.name, opts.prNumber)
    if (problem !== null) {
      apply({ type: 'fail', message: problem })
      return
    }
    apply({ type: 'start' })
    try {
      const result = await opts.importImpl(opts.prNumber, file, {
        onProgress: fraction => apply({ type: 'progress', fraction }),
      })
      apply({ type: 'done' })
      opts.onImported(result)
    } catch (err) {
      apply({ type: 'fail', message: err instanceof Error ? err.message : String(err) })
    }
  }
  label.addEventListener('dragover', event => {
    event.preventDefault()
    apply({ type: 'enter' })
  })
  label.addEventListener('dragleave', () => apply({ type: 'leave' }))
  label.addEventListener('drop', event => {
    event.preventDefault()
    apply({ type: 'leave' })
    const file = event instanceof DragEvent ? event.dataTransfer?.files[0] : undefined
    if (file) {
      void send(file)
    }
  })
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) {
      void send(file)
    }
  })
  return { element: label, send, state: () => state }
}
