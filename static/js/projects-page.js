// @ts-check
// The project list's remove commands. Removing takes a project off the server's list; its
// canvases and review state stay in its `.pr-review/`, and `pr-review open` adds it again. The
// list reloads on success; a refusal, such as a project still running a chat turn, shows next to
// its command.
import { fetchJson } from './api.js'

/**
 * @param {Document} doc
 * @param {typeof fetch} [fetchImpl]
 */
export function wireRemove(doc, fetchImpl) {
  for (const button of doc.querySelectorAll('button[data-remove]')) {
    if (!(button instanceof HTMLButtonElement)) {
      continue
    }
    button.addEventListener('click', () => {
      button.disabled = true
      button.parentElement?.querySelector('.project-error')?.remove()
      fetchJson('/api/projects/remove', {
        method: 'POST',
        body: { basePath: button.dataset['remove'] },
        fetchImpl,
      }).then(
        () => doc.defaultView?.location.reload(),
        (/** @type {unknown} */ err) => {
          button.disabled = false
          const note = doc.createElement('span')
          note.className = 'project-error'
          note.setAttribute('role', 'status')
          note.textContent = err instanceof Error ? err.message : String(err)
          button.after(note)
        }
      )
    })
  }
}

if (typeof document !== 'undefined') {
  wireRemove(document)
}
