// @ts-check
// Boot and drive the self-review deck: fetch the deck, deal the top card, and turn keys, drags,
// and clicks into picks. A pick animates first and saves in parallel; a failed save puts the card
// back. The finish screen writes the fix list the fix skill reads.
import { ApiError, fetchJson } from './api.js'
import {
  createDeckState,
  deckKeyAction,
  dragLean,
  exitDirection,
  nextRecord,
  RECORD_LABELS,
} from './deck-state.js'
import {
  cardHtml,
  DECK_HELP_ID,
  deckHelpHtml,
  drawerHtml,
  finishHtml,
  pipsHtml,
  stackHtml,
} from './deck-view.js'
import { esc } from './dom.js'
import { errorCardHtml } from './errors.js'

/** @typedef {import('./deck-state.js').DecisionCard} DecisionCard */
/** @typedef {import('./deck-state.js').Pick} Pick */
/** @typedef {import('./deck-state.js').PickChoice} PickChoice */
/** @typedef {import('./deck-state.js').RecordTarget} RecordTarget */
/** @typedef {import('./deck-view.js').CardExcerpt} CardExcerpt */
/** @typedef {import('./deck-view.js').Summary} Summary */
/**
 * @typedef {{ deck: { review: import('./contract-types.js').ReviewKey, headSha: string, headRef: string, baseRef: string,
 *   cards: DecisionCard[], settled: unknown[] }, picks: Record<string, Pick>,
 *   excerpts: Record<string, CardExcerpt>, summary: Summary,
 *   fixes: { path: string, markdown: string } | null }} DeckResponse
 */

/** How far a drag has to travel, in pixels, before letting go picks a side. */
const DRAG_COMMIT = 140

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** @param {string} message */
function toast(message) {
  const el = document.createElement('div')
  el.className = 'deck-toast'
  el.setAttribute('role', 'status')
  el.textContent = message
  document.body.append(el)
  setTimeout(() => el.remove(), 3200)
}

/**
 * Where a card flies to, as a transform.
 * @param {'left' | 'right' | 'down' | 'up'} direction
 */
function offscreen(direction) {
  switch (direction) {
    case 'left':
      return 'translate(-130vw, 8vh) rotate(-28deg)'
    case 'right':
      return 'translate(130vw, 8vh) rotate(28deg)'
    case 'down':
      return 'translate(0, 120vh) rotate(4deg)'
    default:
      return 'translate(0, -120vh) rotate(-3deg)'
  }
}

/**
 * @param {HTMLElement} el
 * @param {Keyframe[]} frames
 * @param {KeyframeAnimationOptions} opts
 */
async function play(el, frames, opts) {
  if (typeof el.animate !== 'function') {
    return
  }
  // No fill: a held end frame would override the inline transform a drag writes.
  const animation = el.animate(frames, opts)
  try {
    await animation.finished
  } catch {
    // A cancelled animation is fine: the next render replaces the element.
  }
}

/**
 * @param {HTMLElement} card
 * @param {'left' | 'right' | 'down' | 'up'} direction
 * @param {string} from the transform the card is at now
 */
function flyOut(card, direction, from) {
  if (reducedMotion()) {
    card.style.opacity = '0'
    return play(card, [{ opacity: 1 }, { opacity: 0 }], { duration: 120 })
  }
  card.style.transform = offscreen(direction)
  card.style.opacity = '0'
  return play(
    card,
    [
      { transform: from, opacity: 1 },
      { transform: offscreen(direction), opacity: 0.4 },
    ],
    {
      duration: 420,
      easing: 'cubic-bezier(.5,-0.1,.9,.6)',
    }
  )
}

/**
 * @param {HTMLElement} card
 * @param {'left' | 'right' | 'down' | 'up' | 'deal'} from
 */
function flyIn(card, from) {
  if (reducedMotion()) {
    return play(card, [{ opacity: 0 }, { opacity: 1 }], { duration: 120 })
  }
  const start = from === 'deal' ? 'translate(0, 24px) scale(.94)' : offscreen(from)
  return play(
    card,
    [
      { transform: start, opacity: from === 'deal' ? 0.6 : 0.4 },
      { transform: 'none', opacity: 1 },
    ],
    {
      duration: from === 'deal' ? 320 : 460,
      easing: 'cubic-bezier(.2,1.3,.4,1)',
    }
  )
}

/**
 * @param {HTMLElement} card
 * @param {'a' | 'b' | null} side
 * @param {number} strength 0..1
 */
function showStamp(card, side, strength) {
  for (const s of /** @type {const} */ (['a', 'b'])) {
    const stamp = /** @type {HTMLElement | null} */ (card.querySelector(`.deck-stamp-${s}`))
    if (stamp !== null) {
      const on = s === side ? strength : 0
      stamp.style.opacity = String(on)
      stamp.style.transform = `rotate(${s === 'a' ? -14 : 14}deg) scale(${1.4 - on * 0.4})`
    }
  }
  card.dataset['lean'] = side ?? ''
}

/** @param {HTMLElement} root */
function readBootstrap(root) {
  const el = document.getElementById('bootstrap')
  const data = el?.textContent ? JSON.parse(el.textContent) : {}
  return /** @type {{ review: string, owner: string, repo: string, version: string }} */ ({
    review: root.dataset['review'] ?? data.review,
    owner: data.owner ?? '',
    repo: data.repo ?? '',
    version: data.version ?? '',
  })
}

/**
 * @param {HTMLElement} main
 * @param {unknown} err
 */
function showError(main, err) {
  const error =
    err instanceof ApiError
      ? { code: err.code, message: err.message, ...(err.hint === undefined ? {} : { hint: err.hint }) }
      : { code: /** @type {const} */ ('INTERNAL'), message: String(err) }
  main.outerHTML = errorCardHtml(error)
}

export async function bootDeck() {
  const main = /** @type {HTMLElement | null} */ (document.querySelector('main.deck-page'))
  if (main === null) {
    return
  }
  const boot = readBootstrap(main)
  const api = `/api/deck/${encodeURIComponent(boot.review)}`
  /** @type {DeckResponse} */
  let data
  try {
    data = await fetchJson(api)
  } catch (err) {
    showError(main, err)
    return
  }
  const { deck, excerpts } = data
  const state = createDeckState(deck.cards, data.picks)
  let summary = data.summary
  let fixes = data.fixes
  let busy = false
  /** @type {'card' | 'note' | 'edit'} */
  let mode = 'card'
  /** How each card left on this page, so an undo brings it back the same way. */
  /** @type {Map<string, PickChoice>} */
  const leftBy = new Map()

  main.innerHTML = `<header class="deck-top">
<a class="deck-brand" href="/"><img src="/static/brand.svg" width="22" height="22" alt="">Self-review</a>
<span class="deck-target mono">${esc(deck.headRef)} → ${esc(deck.baseRef)}</span>
<div class="deck-pips-slot"></div>
<nav class="deck-links"><button class="cmd" type="button" data-act="undo"><kbd>u</kbd> undo</button><a class="cmd" href="/review/${esc(boot.review)}">canvas</a><button class="cmd" type="button" data-act="help"><kbd>?</kbd> keys</button></nav>
</header>
<div class="deck-stage"><div class="deck-table"></div>
<aside class="deck-drawer" aria-label="The code this card is about" hidden></aside></div>
<footer class="deck-hints" aria-hidden="true"><span><kbd>a</kbd> A</span><span><kbd>b</kbd> B</span><span><kbd>n</kbd> neither</span><span><kbd>s</kbd> skip</span><span><kbd>u</kbd> undo</span><span><kbd>e</kbd> edit why</span><span><kbd>o</kbd> code</span><span><kbd>?</kbd> help</span></footer>
${deckHelpHtml()}`

  const table = /** @type {HTMLElement} */ (main.querySelector('.deck-table'))
  const drawer = /** @type {HTMLElement} */ (main.querySelector('.deck-drawer'))
  const pipsSlot = /** @type {HTMLElement} */ (main.querySelector('.deck-pips-slot'))

  const topCard = () => /** @type {HTMLElement | null} */ (table.querySelector('.deck-card'))

  const drawPips = () => {
    pipsSlot.innerHTML =
      deck.cards.length === 0 ? '' : pipsHtml(deck.cards, state.picks(), state.top()?.key ?? null)
  }

  const closeDrawer = () => {
    drawer.hidden = true
    topCard()?.querySelector('[data-act="drawer"]')?.setAttribute('aria-expanded', 'false')
  }

  const finish = async () => {
    try {
      const done = await fetchJson(`${api}/finish?headSha=${deck.headSha}`, { method: 'POST' })
      const result = /** @type {{ path: string, markdown: string, summary: Summary }} */ (done)
      summary = result.summary
      fixes = { path: result.path, markdown: result.markdown }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
    main.classList.add('deck-finished')
    table.innerHTML = finishHtml({
      review: boot.review,
      cards: deck.cards,
      picks: state.picks(),
      summary,
      fixes,
      settled: deck.settled.length,
    })
    const screen = /** @type {HTMLElement} */ (table.firstElementChild)
    if (!reducedMotion()) {
      screen.querySelectorAll('.deck-burst i').forEach((piece, i) => {
        ;/** @type {HTMLElement} */ (piece).style.setProperty('--i', String(i))
      })
      screen.classList.add('deck-celebrate')
      for (const n of screen.querySelectorAll('[data-count]')) {
        countUp(/** @type {HTMLElement} */ (n))
      }
    }
  }

  /**
   * Deals the top card, or the finish screen when none is left.
   * @param {'left' | 'right' | 'down' | 'up' | 'deal'} from
   */
  const deal = async from => {
    closeDrawer()
    mode = 'card'
    main.classList.remove('deck-finished')
    window.scrollTo(0, 0)
    drawPips()
    const top = state.top()
    if (top === null) {
      await finish()
      return
    }
    const index = deck.cards.findIndex(c => c.key === top.key)
    table.innerHTML = `<div class="deck-hand">${stackHtml(state.peek())}${cardHtml(top, { index, total: deck.cards.length })}</div>`
    const card = /** @type {HTMLElement} */ (topCard())
    wireDrag(card)
    card.focus({ preventScroll: true })
    await flyIn(card, from)
  }

  /**
   * The edited justification and record target of a side, when they differ from the card's.
   * @param {HTMLElement} el
   * @param {DecisionCard} card
   * @param {'a' | 'b'} side
   */
  const editsOf = (el, card, side) => {
    const why = /** @type {HTMLTextAreaElement | null} */ (
      el.querySelector(`[data-why="${side}"]`)
    )?.value.trim()
    const record = /** @type {HTMLSelectElement | null} */ (
      el.querySelector(`[data-record-select="${side}"]`)
    )?.value
    /** @type {{ why?: string, record?: RecordTarget }} */
    const out = {}
    if (why !== undefined && why !== '' && why !== card[side].why) out.why = why
    if (record !== undefined && record !== card[side].record)
      out.record = /** @type {RecordTarget} */ (record)
    return out
  }

  /**
   * Picks for the top card: it flies out, the next one deals, and the pick saves meanwhile.
   * @param {PickChoice} choice
   * @param {{ note?: string, from?: string }} [opts]
   */
  const pick = async (choice, opts = {}) => {
    const card = state.top()
    const el = topCard()
    if (busy || card === null || el === null) {
      return
    }
    busy = true
    const edits = choice === 'a' || choice === 'b' ? editsOf(el, card, choice) : {}
    /** @type {Record<string, unknown>} */
    const body = { headSha: deck.headSha, choice, ...edits }
    if (opts.note !== undefined) body['note'] = opts.note
    if (choice === 'a' || choice === 'b') showStamp(el, choice, 1)
    const direction = exitDirection(choice)
    leftBy.set(card.key, choice)
    const saving = fetchJson(`${api}/picks/${encodeURIComponent(card.key)}`, { method: 'PUT', body })
    state.record(card.key, {
      choice,
      pickedAt: new Date().toISOString(),
      ...edits,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    })
    await flyOut(el, direction, opts.from ?? (el.style.transform || 'none'))
    try {
      const saved = /** @type {{ picks: Record<string, Pick>, summary: Summary }} */ (await saving)
      state.replacePicks(saved.picks)
      summary = saved.summary
    } catch (err) {
      state.undo()
      toast(`Not saved: ${err instanceof Error ? err.message : String(err)}`)
      busy = false
      await deal(direction)
      return
    }
    busy = false
    await deal('deal')
  }

  const undo = async () => {
    if (!state.canUndo()) {
      toast('Nothing to undo on this page')
      return
    }
    if (busy) return
    busy = true
    const key = /** @type {string} */ (state.undo())
    try {
      const saved = /** @type {{ picks: Record<string, Pick>, summary: Summary }} */ (
        await fetchJson(`${api}/picks/${encodeURIComponent(key)}?headSha=${deck.headSha}`, {
          method: 'DELETE',
        })
      )
      state.replacePicks(saved.picks)
      summary = saved.summary
    } catch (err) {
      toast(`Not undone: ${err instanceof Error ? err.message : String(err)}`)
    }
    busy = false
    await deal(exitDirection(leftBy.get(key) ?? 'skip'))
  }

  const openNote = () => {
    const el = topCard()
    const form = /** @type {HTMLFormElement | null} */ (el?.querySelector('[data-note]') ?? null)
    if (form === null) return
    mode = 'note'
    form.hidden = false
    form.querySelector('textarea')?.focus()
  }

  /** @param {'why' | 'record'} focus */
  const openEditor = focus => {
    const el = topCard()
    if (el === null) return
    mode = 'edit'
    el.classList.add('deck-editing')
    const target = /** @type {HTMLElement | null} */ (
      el.querySelector(focus === 'why' ? '[data-why="a"]' : '[data-record-select="a"]')
    )
    target?.focus()
  }

  const escape = () => {
    const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById(DECK_HELP_ID))
    if (dialog?.open) {
      dialog.close()
      return
    }
    if (!drawer.hidden) {
      closeDrawer()
      return
    }
    const el = topCard()
    if (el !== null) {
      const form = /** @type {HTMLFormElement | null} */ (el.querySelector('[data-note]'))
      if (form !== null) form.hidden = true
      el.classList.remove('deck-editing')
      el.focus({ preventScroll: true })
    }
    mode = 'card'
  }

  const toggleDrawer = () => {
    const card = state.top()
    if (card === null) return
    if (!drawer.hidden) {
      closeDrawer()
      return
    }
    drawer.innerHTML = drawerHtml(card, excerpts[card.key])
    drawer.hidden = false
    topCard()?.querySelector('[data-act="drawer"]')?.setAttribute('aria-expanded', 'true')
    drawer.querySelector('.deck-diff-here')?.scrollIntoView({ block: 'center' })
  }

  const help = () => {
    const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById(DECK_HELP_ID))
    if (dialog !== null && !dialog.open) dialog.showModal()
  }

  /** @param {string} key */
  const reopen = async key => {
    try {
      const saved = /** @type {{ picks: Record<string, Pick>, summary: Summary }} */ (
        await fetchJson(`${api}/picks/${encodeURIComponent(key)}?headSha=${deck.headSha}`, {
          method: 'DELETE',
        })
      )
      state.reopen(key)
      state.replacePicks(saved.picks)
      summary = saved.summary
      await deal('up')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  /** @param {HTMLElement} card */
  function wireDrag(card) {
    let startX = 0
    let startY = 0
    let dragging = false
    card.addEventListener('pointerdown', event => {
      const target = /** @type {Element} */ (event.target)
      if (
        busy ||
        mode !== 'card' ||
        event.button !== 0 ||
        target.closest('button, textarea, select, input, a, pre')
      ) {
        return
      }
      dragging = true
      startX = event.clientX
      startY = event.clientY
      card.setPointerCapture(event.pointerId)
      card.classList.add('deck-dragging')
    })
    card.addEventListener('pointermove', event => {
      if (!dragging) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      card.style.transform = `translate(${dx}px, ${dy * 0.35}px) rotate(${dx / 18}deg)`
      const lean = dragLean(dx, DRAG_COMMIT)
      showStamp(card, lean.side, lean.strength)
    })
    const release = (/** @type {PointerEvent} */ event) => {
      if (!dragging) return
      dragging = false
      card.classList.remove('deck-dragging')
      const dx = event.clientX - startX
      const lean = dragLean(dx, DRAG_COMMIT)
      if (lean.commit && lean.side !== null) {
        void pick(lean.side, { from: card.style.transform })
        return
      }
      const from = card.style.transform || 'none'
      card.style.transform = ''
      showStamp(card, null, 0)
      void play(card, [{ transform: from }, { transform: 'none' }], {
        duration: reducedMotion() ? 1 : 380,
        easing: 'cubic-bezier(.3,1.6,.5,1)',
      })
    }
    card.addEventListener('pointerup', release)
    card.addEventListener('pointercancel', release)
  }

  main.addEventListener('submit', event => {
    const form = /** @type {HTMLFormElement} */ (event.target)
    if (!form.matches('[data-note]')) return
    event.preventDefault()
    const note = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('note')).value.trim()
    if (note === '') return
    mode = 'card'
    void pick('neither', { note })
  })

  main.addEventListener('keydown', event => {
    const target = /** @type {Element} */ (event.target)
    if (event.key !== 'Enter' || event.shiftKey) return
    if (target.matches('[data-note] textarea')) {
      event.preventDefault()
      target.closest('form')?.requestSubmit()
    } else if (target.matches('[data-why]')) {
      event.preventDefault()
      mode = 'card'
      const side = /** @type {'a' | 'b'} */ (target.getAttribute('data-why'))
      void pick(side)
    }
  })

  main.addEventListener('input', event => {
    const target = /** @type {Element} */ (event.target)
    const side = target.getAttribute('data-record-select')
    if (side !== null) {
      const value = /** @type {RecordTarget} */ (/** @type {HTMLSelectElement} */ (target).value)
      const chip = main.querySelector(`[data-record-chip="${side}"]`)
      if (chip !== null) {
        chip.textContent = RECORD_LABELS[value]
        chip.setAttribute('data-record', value)
      }
    }
    const why = target.getAttribute('data-why')
    if (why !== null) {
      const text = main.querySelector(`.deck-side-${why} [data-why-text]`)
      if (text !== null) text.textContent = /** @type {HTMLTextAreaElement} */ (target).value
    }
  })

  main.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target)
    const pickButton = target.closest('[data-pick]')
    if (pickButton !== null) {
      void pick(/** @type {'a' | 'b'} */ (pickButton.getAttribute('data-pick')))
      return
    }
    const chip = target.closest('[data-record-chip]')
    if (chip !== null) {
      const side = chip.getAttribute('data-record-chip')
      const select = /** @type {HTMLSelectElement | null} */ (
        main.querySelector(`[data-record-select="${side}"]`)
      )
      if (select !== null) {
        select.value = nextRecord(/** @type {RecordTarget} */ (select.value))
        select.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return
    }
    const reopenButton = target.closest('[data-reopen]')
    if (reopenButton !== null) {
      void reopen(/** @type {string} */ (reopenButton.getAttribute('data-reopen')))
      return
    }
    const copy = target.closest('[data-copy]')
    if (copy !== null) {
      event.preventDefault()
      void navigator.clipboard?.writeText(copy.getAttribute('data-copy') ?? '').then(
        () => toast('Copied'),
        () => toast('Copy failed; select the text instead')
      )
      return
    }
    const act = target.closest('[data-act]')?.getAttribute('data-act')
    if (act === 'drawer') toggleDrawer()
    else if (act === 'neither') openNote()
    else if (act === 'skip') void pick('skip')
    else if (act === 'help') help()
    else if (act === 'undo') void undo()
    else if (act === 'edit') openEditor('why')
    else if (act === 'escape') escape()
  })

  document.addEventListener('keydown', event => {
    const action = deckKeyAction(event)
    if (action === null) return
    if (action === 'escape') {
      escape()
      return
    }
    const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById(DECK_HELP_ID))
    if (dialog?.open) return
    event.preventDefault()
    switch (action) {
      case 'pick-a':
        void pick('a')
        break
      case 'pick-b':
        void pick('b')
        break
      case 'neither':
        openNote()
        break
      case 'skip':
        void pick('skip')
        break
      case 'undo':
        void undo()
        break
      case 'edit':
        openEditor('why')
        break
      case 'record':
        openEditor('record')
        break
      case 'drawer':
        toggleDrawer()
        break
      case 'help':
        help()
        break
    }
  })

  await deal('deal')
}

/**
 * Counts a tally up from zero, for the finish screen.
 * @param {HTMLElement} el
 */
function countUp(el) {
  const target = Number(el.dataset['count'] ?? '0')
  if (target === 0) return
  const started = performance.now()
  const step = (/** @type {number} */ now) => {
    const t = Math.min(1, (now - started) / 700)
    el.textContent = String(Math.round(target * (1 - (1 - t) ** 3)))
    if (t < 1) requestAnimationFrame(step)
  }
  el.textContent = '0'
  requestAnimationFrame(step)
}

void bootDeck()
