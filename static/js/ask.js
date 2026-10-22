// @ts-check
// The `[ ask ]` command that sets the AI Chat context. One builder, so a layer card, a file
// card, an attention point, and the selection toolbar all carry the same attributes and the
// quick-question menu finds them all.
import { chatContextAttrs } from './chat-context.js'
import { esc } from './dom.js'
import { quickQuestionsFor } from './quick-questions.js'

/**
 * Whether the AI Chat pane is on for this screen. The renderers read it rather than threading a
 * flag through every card; `app.js` sets it once per render.
 */
let chatEnabled = false

/** @param {boolean} on */
export function setChatEnabled(on) {
  chatEnabled = on
}

export function isChatEnabled() {
  return chatEnabled
}

/**
 * The command, or nothing at all when the pane is off: a page without a chat shows no way to ask.
 * @param {import('./chat-context.js').ChatContext} context
 * @param {{ label?: string, title?: string, enabled?: boolean }} [opts] `title` is the tooltip, for
 *   a skin that shows the command as an icon
 * @returns {string}
 */
export function askButtonHtml(context, opts = {}) {
  if (!(opts.enabled ?? chatEnabled)) {
    return ''
  }
  const label = opts.label ?? 'ask'
  const title = opts.title === undefined ? '' : ` title="${esc(opts.title)}"`
  // The quick-question menu opens on `data-ask`, for a target that has questions.
  const menu = quickQuestionsFor(context).length > 0 ? ' data-ask' : ''
  return `<button class="cmd" type="button" data-act="ask"${menu}${chatContextAttrs(context)}${title}><span class="ask-label">${esc(label)}</span></button>`
}
