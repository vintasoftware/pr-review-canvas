import { toggleMarkdownPreview } from './composer.js'
// @ts-check
// Everything the reader can do on the review screen, wired once. One delegated click handler,
// one change handler, one pointer pair for line selection, and one key handler; each command
// carries a `data-act` that names what it does.
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */
/** @typedef {import('./review-session.js').ReviewSession} ReviewSession */
/** @typedef {import('./selection.js').Selection} Selection */
import { cssEscape, drawCardOf, findRow } from './anchors.js'
import { fetchReviewBody } from './api.js'
import { chatContextFromElement, WHOLE_PR } from './chat-context.js'
import { setFoldShown } from './code-folds.js'
import { runCommand, runControl, showCommandError } from './commands.js'
import { replacePostButton } from './comment-link.js'
import {
  applyCapabilityGating,
  closeComposers,
  composerBody,
  composerHtml,
  composerInput,
  composerPendingInput,
  composerRowHtml,
  concealForComposer,
  focusComposer,
  revealConcealed,
  refreshComposerCommands,
} from './composer.js'
import { commentHtml, setThreadCollapsed, threadRowHtml } from './diff-decorations.js'
import { flash, scrollIntoViewSafe } from './dom.js'
import { isFoldLevel, nextFoldLevel } from './fold-levels.js'
import { refreshProgress } from './header.js'
import { keyAction, openHelpDialog } from './keyboard.js'
import { pointAnchorId, reviewedId } from './keys.js'
import {
  canvasHiddenLines,
  cardOf,
  getFoldLevel,
  getRenderContext,
  pathSet,
  refreshCardDecorations,
  refreshFolds,
  setCardCollapsed,
  setCardRenderedHook,
  setFoldLevel,
  setRenderContext,
  updateRenderState,
} from './layers.js'
import { buildNavOrder, layerOf, nextFile, nextLayer, prevFile, prevLayer, readingItem } from './nav.js'
import { issueCommentHtml } from './overview.js'
import { pendingCount, refreshPendingBar } from './pending.js'
import { applyDismissed, pointToMarkdown, postedUrls } from './points.js'
import { layerProgress } from './progress.js'
import { FOLD_LEVEL_SELECT_ID, hiddenLabel, refreshFoldLevel } from './reading-level.js'
import { lineRefFromEvent, markSelection, selectionReducer } from './selection.js'
import {
  fillSignoffDialog,
  openSignoffDialog,
  showSignoffError,
  setSignoffFolds,
  showSignoffResult,
  signoffBody,
} from './signoff.js'

/** @typedef {NonNullable<ReturnType<typeof import('./chat.js').wireChat>>} ChatHandle */
/** @typedef {import('./nav.js').NavItem} NavItem */

const NO_CHAT_NOTE = 'the AI Chat pane is off; press ? for the key map'

/** Pixels left above a card the keys scroll to, so its focus ring shows. */
const FOCUS_GAP = 8
/** How far below the top of the screen a card's top may sit and still be the one being read. */
const READING_SLACK = 16

/**
 * An element's top in viewport pixels, or null when it is not drawn: hidden, or on a page
 * without layout.
 * @param {Element} el
 */
function drawnTop(el) {
  const rect = el.getBoundingClientRect()
  return rect.width === 0 && rect.height === 0 ? null : rect.top
}

/**
 * False for an element inside a collapsed card or a closed details, which a key should not stop at.
 * @param {Element} el
 */
function isShown(el) {
  return (
    el.closest('[hidden]') === null && (el.parentElement?.closest('details:not([open])') ?? null) === null
  )
}

/**
 * Opens every collapsed card and closed details around an element, so a key can show it.
 * @param {Element} el
 */
function revealAround(el) {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement && !node.open) {
      node.open = true
    } else if (node.hidden && node.matches('.file-body, .layer-body')) {
      setCardCollapsed(node, false)
    }
  }
}

/**
 * The event a sign-off dialog is set to. An attribute that names none reads as a comment-only
 * review, the one of the three that claims nothing.
 * @param {string | null} raw
 * @returns {import('./contract-types.js').ReviewEvent}
 */
export function signoffEvent(raw) {
  return raw === 'APPROVE' || raw === 'REQUEST_CHANGES' ? raw : 'COMMENT'
}

/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const toastTimers = new WeakMap()

/**
 * The first element of an HTML string built by this app's renderers.
 * @param {Document} doc
 * @param {string} html
 * @returns {Element | null}
 */
export function nodeFrom(doc, html) {
  const template = doc.createElement('template')
  template.innerHTML = html
  return template.content.firstElementChild
}

/**
 * The row of an HTML string that is a `<tr>`, which needs a table around it to parse.
 * @param {Document} doc
 * @param {string} html
 * @returns {HTMLTableRowElement | null}
 */
export function rowFrom(doc, html) {
  return nodeFrom(doc, `<table><tbody>${html}</tbody></table>`)?.querySelector('tr') ?? null
}

/**
 * The one place the page says what just happened. Screen readers get it through `aria-live`.
 * @param {HTMLElement} root
 * @param {string} message
 */
export function toast(root, message) {
  let box = root.querySelector('.toast')
  if (!(box instanceof HTMLElement)) {
    box = document.createElement('div')
    box.className = 'toast'
    box.setAttribute('role', 'status')
    box.setAttribute('aria-live', 'polite')
    root.appendChild(box)
  }
  clearTimeout(toastTimers.get(box))
  box.textContent = message
  const region = box
  toastTimers.set(
    region,
    setTimeout(() => {
      region.textContent = ''
      toastTimers.delete(region)
    }, 5000)
  )
  return box
}

/**
 * The layer or file card a reviewed id belongs to.
 * @param {ParentNode} root
 * @param {string} id
 */
export function cardForReviewedId(root, id) {
  const input = root.querySelector(`input[data-reviewed-id="${cssEscape(id)}"]`)
  return input === null ? null : cardOf(input)
}

/**
 * Where the reader goes after marking something reviewed: the first layer or file that is still
 * open, after the one they just finished.
 * @param {ParentNode} root
 * @param {ReviewSession} session
 * @param {string} fromId the anchor id of the card that was just marked
 * @param {'layer' | 'file'} kind
 */
export function nextUnreviewedTarget(root, session, fromId, kind) {
  const order = buildNavOrder(session.artifact)
  const from = order.findIndex(i => i.id === fromId)
  for (let i = from + 1; i < order.length; i++) {
    const item = order[i]
    if (item === undefined || item.kind !== kind || item.other) {
      continue
    }
    const id = item.kind === 'file' ? reviewedId(item.layerKey, item.path) : reviewedId(item.layerKey)
    if (!session.isReviewed(id)) {
      return root.querySelector(`#${cssEscape(item.id)}`)
    }
  }
  return null
}

/**
 * What the `a` key asks about: the selection if there is one, else the attention point in focus,
 * else the card in focus, else the whole pull request.
 * @param {ParentNode} root
 * @param {string | null} focusId
 * @param {string | null} focusPointId
 * @param {Selection | null} selection
 * @returns {import('./chat-context.js').ChatContext}
 */
export function askTargetFor(root, focusId, focusPointId, selection) {
  if (selection !== null) {
    return {
      kind: 'lines',
      path: selection.path,
      side: selection.side,
      start: selection.start,
      end: selection.end,
    }
  }
  if (focusPointId !== null) {
    const el = root.querySelector(`[data-point="${cssEscape(focusPointId)}"] [data-act="ask"]`)
    if (el instanceof HTMLElement) {
      return chatContextFromElement(el)
    }
  }
  if (focusId !== null) {
    const card = root.querySelector(`#${cssEscape(focusId)}`)
    const ask = card?.querySelector('[data-act="ask"]')
    if (ask instanceof HTMLElement) {
      return chatContextFromElement(ask)
    }
  }
  return WHOLE_PR
}

/**
 * Wires the whole review screen. Returns a stop function, so a re-render never leaves two sets
 * of listeners behind.
 * @param {HTMLElement} root
 * @param {ReviewSession} session
 * @param {{
 *   document?: Document,
 *   fetchReviewBody?: typeof fetchReviewBody,
 *   chat?: () => ChatHandle | null,
 *   quickQuestions?: () => { openFor: (el: HTMLElement) => void } | null,
 *   openSettings?: (el: HTMLElement) => void,
 * }} [opts]
 */
export function wireReview(root, session, opts = {}) {
  const doc = opts.document ?? document
  const readReviewBody = opts.fetchReviewBody ?? fetchReviewBody
  /** @type {Selection | null} */
  let selection = null
  /** @type {string | null} */
  let focusId = null
  /** @type {string | null} */
  let focusPointId = null
  /** The element that holds the ring, which the step keys measure from. */
  /** @type {HTMLElement | null} */
  let focusedEl = null
  let pendingG = false
  let composerSeq = 0
  let signoffOpening = 0

  const paths = () => pathSet(getRenderContext()?.files ?? [])
  /** The diff key of a path, which is what the row ids are built from. */
  const keyForPath = (/** @type {string} */ path) =>
    getRenderContext()?.files.find(f => f.path === path)?.key ?? null
  /** The time the page was drawn, which the comments it adds are timed against. */
  const renderNow = () => getRenderContext()?.now ?? new Date()
  /** @param {import('./contract-types.js').FoldLevel} level */
  const hiddenAt = level =>
    canvasHiddenLines(
      getRenderContext() ?? {
        artifact: session.artifact,
        files: [],
        comments: [],
        state: session.state,
        headSha: session.headSha,
      },
      level
    )

  /**
   * Whether a card counts as reviewed, read the same way the page was first drawn: a layer is
   * reviewed when its own mark is set or when every one of its files is.
   * @param {string} id
   * @param {PrState} state
   */
  const isCardReviewed = (id, state) => {
    if (id.includes('/file:')) {
      return state.reviewed[id] === true
    }
    const layer = session.artifact.layers.find(l => reviewedId(l.key) === id)
    return layer === undefined ? state.reviewed[id] === true : layerProgress(layer, state) === 'done'
  }

  let drawnPending = session.pending
  let drawnComments = session.submittedComments
  /** Draws everything the local state decides, after it changed. */
  const onState = (/** @type {PrState} */ state) => {
    updateRenderState(state)
    const ctx = getRenderContext()
    if (ctx !== null) {
      const changedPaths = new Set()
      const previous = new Map(drawnPending.map(p => [p.id, p]))
      for (const draft of state.pending) {
        const old = previous.get(draft.id)
        if (old === undefined || old.body !== draft.body) changedPaths.add(draft.path)
        previous.delete(draft.id)
      }
      for (const draft of previous.values()) changedPaths.add(draft.path)
      const added = session.submittedComments.filter(c => !drawnComments.some(old => old.id === c.id))
      for (const comment of added) changedPaths.add(comment.path)
      const next = { ...ctx, comments: [...ctx.comments, ...added] }
      setRenderContext(next)
      refreshCardDecorations(root, next, changedPaths, added)
      if (changedPaths.size > 0) {
        // A thread a submitted review adds, or a draft saved or deleted, changes what keeps a
        // card's code open, as a posted comment does.
        refreshFolds(root)
        refreshFoldLevel(root, getFoldLevel(), hiddenAt(getFoldLevel()))
      }
      drawnPending = state.pending
      drawnComments = session.submittedComments
    }
    refreshProgress(root, session.artifact, state)
    applyDismissed(root, session.artifact.points, state, {
      paths: paths(),
      layers: session.artifact.layers,
      posted: postedUrls(state, getRenderContext()?.comments ?? []),
    })
    for (const input of Array.from(root.querySelectorAll('input[data-reviewed-id]'))) {
      const id = input.getAttribute('data-reviewed-id')
      if (!(input instanceof HTMLInputElement) || id === null) {
        continue
      }
      const reviewed = isCardReviewed(id, state)
      input.checked = reviewed
      // A card the server reopened (marking a layer reopens its files) opens here as well.
      const parts = cardOf(input)
      if (parts !== null && parts.card.classList.contains('is-reviewed') !== reviewed) {
        parts.card.classList.toggle('is-reviewed', reviewed)
        setCardCollapsed(parts.card, reviewed)
      }
    }
    refreshPendingBar(root, state, session.headSha)
    refreshComposerCommands(root, state.pending.length > 0)
    applyCapabilityGating(root, session.capabilities)
  }
  const unsubscribe = session.subscribe(onState)

  /** @param {import('./contract-types.js').PostCommentInput} input */
  const postComment = async input => {
    const answer = await session.postComment(input)
    const ctx = getRenderContext()
    if (answer.kind === 'review' && ctx !== null) {
      setRenderContext({
        ...ctx,
        comments: [...ctx.comments.filter(c => c.id !== answer.comment.id), answer.comment],
      })
      // A new thread keeps its card's code open at every level, and the counters say so.
      refreshFolds(root)
      refreshFoldLevel(root, getFoldLevel(), hiddenAt(getFoldLevel()))
      onState(session.state)
    }
    return answer
  }
  // A card drawn later carries posting commands of its own, which the same rules apply to.
  setCardRenderedHook(card => applyCapabilityGating(card, session.capabilities))

  /** The height of the outdated-canvas bar, which sticks to the top of the screen over the cards. */
  const stickyTop = () => {
    const bar = root.querySelector('.stale-bar')
    return bar === null ? 0 : bar.getBoundingClientRect().height
  }

  /**
   * @param {string} id
   * @param {Element | null} [element] where to put the ring when the id names nothing on screen
   * @param {ScrollLogicalPosition} [block] `start` for a card, `center` for a point
   */
  const focusItem = (id, element, block = 'start') => {
    focusId = id
    const el = root.querySelector(`#${cssEscape(id)}`) ?? element
    for (const marked of Array.from(root.querySelectorAll('.is-focused'))) {
      marked.classList.remove('is-focused')
    }
    focusedEl = null
    if (el instanceof HTMLElement) {
      focusedEl = el
      el.classList.add('is-focused')
      // The ring follows the keyboard, so the focus does too: a screen reader reads the card
      // the reader moved to instead of the command they pressed the key on.
      el.tabIndex = -1
      el.focus({ preventScroll: true })
      el.style.scrollMarginTop = `${stickyTop() + FOCUS_GAP}px`
      scrollIntoViewSafe(el, block)
    }
    return el
  }

  /**
   * Where the step keys start from: the element in focus while its top is on screen. Once the
   * reader has scrolled it away, the card at the top of the screen.
   * @param {ReadonlyArray<NavItem>} order
   * @returns {Element | null}
   */
  const here = order => {
    const focused = focusedEl?.isConnected === true ? focusedEl : null
    const top = focused === null ? null : drawnTop(focused)
    // A focused element that is not drawn, such as a point just dismissed, still marks the place.
    if (focused !== null && (top === null || (top > -FOCUS_GAP && top < window.innerHeight))) {
      return focused
    }
    const byId = (/** @type {NavItem} */ item) => root.querySelector(`#${cssEscape(item.id)}`)
    const reading = readingItem(
      order,
      item => {
        const el = byId(item)
        return el === null ? null : drawnTop(el)
      },
      stickyTop() + READING_SLACK
    )
    return reading === null ? focused : byId(reading)
  }

  /**
   * The id of the layer or file card that holds an element, or the element's own id when it is one.
   * @param {ReadonlyArray<NavItem>} order
   * @param {Element | null} el
   */
  const itemAround = (order, el) => {
    for (
      let node = el?.closest('[id]') ?? null;
      node !== null;
      node = node.parentElement?.closest('[id]') ?? null
    ) {
      const id = node.id
      if (order.some(i => i.id === id)) {
        return id
      }
    }
    return null
  }

  /** @param {NavItem} item */
  const isCardShown = item => {
    const el = root.querySelector(`#${cssEscape(item.id)}`)
    return el !== null && isShown(el)
  }

  /**
   * The next or previous attention point in page order, from where the reader is.
   * @param {ReadonlyArray<NavItem>} order
   * @param {ReadonlyArray<Point>} points
   * @param {1 | -1} direction
   */
  const stepPoint = (order, points, direction) => {
    const from = here(order)
    /** @param {Point} point */
    const pointEl = point =>
      root.querySelector(`#${cssEscape(pointAnchorId(point.id))}`) ??
      root.querySelector(`[data-point="${cssEscape(point.id)}"]`)
    const onPage = points
      .map(point => {
        // A point of the Other layer has no card, so the ring lands on its row in the diff, which
        // a closed Other layer has not drawn yet.
        if (pointEl(point) === null && point.layerId !== undefined) {
          drawCardOf(root, point.path, point.layerId)
        }
        return { point, el: pointEl(point) }
      })
      .filter(/** @returns {p is { point: Point, el: Element }} */ p => p.el !== null)
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    const found =
      from === null
        ? direction === 1
          ? onPage[0]
          : onPage.at(-1)
        : direction === 1
          ? onPage.find(p => (from.compareDocumentPosition(p.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
          : onPage.findLast(
              p => (from.compareDocumentPosition(p.el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
            )
    if (found === undefined) {
      return
    }
    focusPointId = found.point.id
    // A point inside a collapsed card or the closed Other layer opens, so the ring is seen.
    revealAround(found.el)
    focusItem(pointAnchorId(found.point.id), found.el, 'center')
  }

  /** @param {Selection | null} next */
  const setSelection = next => {
    selection = next
    markSelection(root, selection)
    applyCapabilityGating(root, session.capabilities)
  }

  /**
   * Opens one composer, closing whatever was open before it.
   * @param {Element} anchor the row or host the composer goes under
   * @param {import('./composer.js').ComposerOptions} options
   * @param {'row' | 'block'} shape
   */
  const openComposer = (anchor, options, shape) => {
    closeComposers(root)
    options = { ...options, pendingActive: pendingCount(session.state) > 0 }
    const node =
      shape === 'row' ? rowFrom(doc, composerRowHtml(options)) : nodeFrom(doc, composerHtml(options))
    if (node === null) {
      return null
    }
    if (shape === 'row') {
      anchor.insertAdjacentElement('afterend', node)
    } else {
      anchor.append(node)
    }
    applyCapabilityGating(root, session.capabilities)
    focusComposer(root, options.id)
    return node
  }

  /**
   * @param {{ key: string, path: string, side: 'new' | 'old', line: number, startLine?: number }} target
   */
  const openLineComposer = target => {
    const row = findRow(root, target.key, target.side, target.line)
    if (row === null) {
      return null
    }
    composerSeq += 1
    /** @type {import('./composer.js').ComposerOptions} */
    const options = {
      id: `composer-${composerSeq}`,
      label: `Comment on ${target.path}:${target.line}`,
      kind: 'inline',
      path: target.path,
      line: target.line,
      side: target.side,
    }
    if (target.startLine !== undefined && target.startLine !== target.line) {
      options.startLine = target.startLine
    }
    return openComposer(row, options, 'row')
  }

  /** The inline comment that a posted review comment becomes on the page. */
  const insertPostedReviewComment = (
    /** @type {Element} */ composerNode,
    /** @type {ReviewComment} */ comment
  ) => {
    const thread = root.querySelector(
      `tr.thread[data-thread="${cssEscape(String(comment.inReplyToId ?? comment.id))}"]`
    )
    const now = getRenderContext()?.now ?? new Date()
    if (comment.inReplyToId !== undefined && thread !== null) {
      const full = thread.querySelector('.thread-full')
      const tbtns = full?.querySelector('.tbtns')
      const template = doc.createElement('template')
      template.innerHTML = commentHtml(comment, now)
      const node = template.content.firstElementChild
      if (node !== null) {
        tbtns?.before(node)
      }
      composerNode.remove()
      return
    }
    const template = doc.createElement('template')
    template.innerHTML = `<table><tbody>${threadRowHtml({ root: comment, replies: [], resolved: false, outdated: comment.outdated, path: comment.path, side: comment.side, line: comment.line }, { now })}</tbody></table>`
    const row = template.content.querySelector('tr')
    const host = composerNode.closest('tr') ?? composerNode
    if (row !== null) {
      host.insertAdjacentElement('afterend', row)
    }
    host.remove()
  }

  /**
   * @param {HTMLElement} button
   * @param {Element} box
   */
  const postFromComposer = (button, box) => {
    const input = composerInput(box)
    if (input === null) {
      showCommandError(button, 'write something first')
      return
    }
    // While it waits for GitHub the box stays, even if the reader opens another one.
    box.setAttribute('data-posting', '1')
    void runCommand(
      button,
      async () => {
        const answer = await postComment(input)
        if (answer.kind === 'issue') {
          const node = nodeFrom(doc, issueCommentHtml(answer.comment, renderNow()))
          if (node !== null) {
            root.querySelector('.conversation .pr-composer-host')?.before(node)
          }
          // Only the box that posted goes away; a draft the reader started meanwhile stays.
          box.remove()
        } else {
          insertPostedReviewComment(box, answer.comment)
        }
        toast(root, 'comment posted to github')
        applyCapabilityGating(root, session.capabilities)
      },
      { pendingLabel: 'posting…' }
    ).finally(() => box.removeAttribute('data-posting'))
  }

  /** @param {string} pointId */
  const pointById = pointId => session.artifact.points.find(p => p.id === pointId)

  /**
   * @param {HTMLElement} button
   * @param {Point} point
   */
  const postPoint = (button, point) => {
    void runCommand(
      button,
      async () => {
        const answer = await postComment({
          kind: 'inline',
          path: point.path,
          line: point.line,
          side: point.side ?? 'new',
          body: pointToMarkdown(point),
          pointFingerprint: point.fingerprint,
        })
        for (const control of Array.from(
          root.querySelectorAll(`[data-act="point-post"][data-point="${cssEscape(point.id)}"]`)
        )) {
          if (control instanceof HTMLElement) {
            replacePostButton(control, answer.comment.url)
          }
        }
        toast(root, 'attention point posted to github')
      },
      { pendingLabel: 'posting…' }
    )
  }

  /**
   * @param {HTMLElement} button
   * @param {string} id
   * @param {boolean} reviewed
   * @param {'layer' | 'file'} kind
   * @param {{ quiet?: boolean }} [reviewOptions] `quiet` keeps a checkbox label intact while it runs
   */
  const markReviewed = (button, id, reviewed, kind, reviewOptions = {}) => {
    const run = async () => {
      await session.setReviewed(id, reviewed)
      const parts = cardForReviewedId(root, id)
      if (parts !== null) {
        setCardCollapsed(parts.card, reviewed)
        parts.card.classList.toggle('is-reviewed', reviewed)
        if (reviewed) {
          const next = nextUnreviewedTarget(root, session, parts.card.id, kind)
          if (next instanceof HTMLElement) {
            focusItem(next.id)
          }
        }
      }
      toast(root, reviewed ? `${kind} marked reviewed` : `${kind} reopened`)
    }
    void (reviewOptions.quiet === true
      ? runControl(button, run)
      : runCommand(button, run, { pendingLabel: reviewed ? 'marking…' : 'unmarking…' }))
  }

  /** @param {HTMLElement} button @param {string} fingerprint @param {boolean} dismissed */
  const setDismissed = (button, fingerprint, dismissed) => {
    void runCommand(
      button,
      async () => {
        await session.setDismissed(fingerprint, dismissed)
        toast(root, dismissed ? 'attention point dismissed' : 'attention point restored')
      },
      { pendingLabel: dismissed ? 'dismissing…' : 'restoring…' }
    )
  }

  /** @param {HTMLElement} button @param {import('./contract-types.js').ReviewEvent} event */
  const openSignoff = (button, event) => {
    const dialog = openSignoffDialog(root, { event })
    const level = getFoldLevel()
    const counts = hiddenAt(level)
    setSignoffFolds(dialog, counts.hidden === 0 ? '' : `Read at the ${level} level · ${hiddenLabel(counts)}`)
    applyCapabilityGating(root, session.capabilities)
    signoffOpening += 1
    const opening = signoffOpening
    void runCommand(
      button,
      async () => {
        try {
          const preview = await readReviewBody(session.prNumber)
          // A body that belongs to an earlier opening is not put in the dialog on screen.
          if (opening === signoffOpening) {
            fillSignoffDialog(dialog, preview)
          }
        } catch (err) {
          // The command that opened the dialog sits behind it, so the reason is shown inside.
          if (opening === signoffOpening) {
            showSignoffError(dialog, err instanceof Error ? err.message : String(err))
          }
          throw err
        }
      },
      { pendingLabel: 'loading…' }
    )
  }

  /** @param {HTMLElement} button */
  const postSignoff = button => {
    const dialog = button.closest('dialog')
    if (!(dialog instanceof HTMLDialogElement)) {
      return
    }
    const event = signoffEvent(dialog.getAttribute('data-event'))
    const body = signoffBody(dialog)
    void runCommand(
      button,
      async () => {
        const { review, submitted, warnings } = await session.postReview(
          event,
          body === '' ? undefined : body
        )
        showSignoffResult(dialog, review)
        for (const warning of warnings) {
          dialog.querySelector('.signoff-result')?.append(document.createTextNode(` ${warning}`))
        }
        const verdict =
          review.state === 'APPROVED'
            ? 'approved'
            : review.state === 'CHANGES_REQUESTED'
              ? 'changes requested'
              : 'review posted'
        toast(
          root,
          `${verdict}${submitted > 0 ? ` with ${submitted} comment${submitted === 1 ? '' : 's'}` : ''}`
        )
      },
      { pendingLabel: 'posting…' }
    )
  }

  /**
   * Switches how much code the page hides, from the control or from the `f` key. The hint under
   * the control says what the new level hides and how much of the diff that is.
   * @param {string} value
   */
  const applyFoldLevel = value => {
    if (!isFoldLevel(value) || value === getFoldLevel()) {
      return
    }
    setFoldLevel(root, value)
    refreshFoldLevel(root, value, hiddenAt(value))
    toast(root, `hiding code: ${value}`)
  }

  /**
   * Adds what a composer holds to the pending review instead of posting it.
   * @param {HTMLElement} button
   * @param {Element} box
   */
  const queueFromComposer = (button, box) => {
    const input = composerPendingInput(box)
    if (input === null) {
      showCommandError(button, 'write something first')
      return
    }
    box.setAttribute('data-posting', '1')
    void runCommand(
      button,
      async () => {
        await session.addPending(input)
        box.closest('tr.composer')?.remove()
        box.remove()
        toast(root, 'comment added to your review')
      },
      { pendingLabel: 'adding…' }
    ).finally(() => box.removeAttribute('data-posting'))
  }

  /**
   * Saves an edit to a draft that is already in the review.
   * @param {HTMLElement} button
   * @param {Element} box
   */
  const savePending = (button, box) => {
    const id = box.getAttribute('data-pending-id')
    const body = composerBody(box)
    if (id === null) {
      return
    }
    if (body === '') {
      showCommandError(button, 'write something first')
      return
    }
    void runCommand(
      button,
      async () => {
        await session.editPending(id, body)
        const host = box.parentElement
        box.remove()
        if (host !== null) revealConcealed(host.parentNode ?? root)
        toast(root, 'draft updated')
      },
      { pendingLabel: 'saving…' }
    )
  }

  /**
   * Puts an attention point's text in the pending review instead of posting it. The point is
   * tagged with its fingerprint, so once the review lands the point shows the comment it became.
   * @param {HTMLElement} button
   * @param {Point} point
   */
  const queuePoint = (button, point) => {
    void runCommand(
      button,
      async () => {
        await session.addPending({
          path: point.path,
          line: point.line,
          side: point.side ?? 'new',
          body: pointToMarkdown(point),
          pointFingerprint: point.fingerprint,
        })
        toast(root, 'attention point added to your review')
      },
      { pendingLabel: 'adding…' }
    )
  }

  /**
   * @param {HTMLElement} button
   * @param {string} id
   */
  const deletePending = (button, id) => {
    void runCommand(
      button,
      async () => {
        await session.deletePending(id)
        toast(root, 'draft deleted')
      },
      { pendingLabel: 'deleting…' }
    )
  }

  /** @type {Record<string, (el: HTMLElement, event: MouseEvent) => void>} */
  const actions = {
    'toggle-card': el => {
      setCardCollapsed(el)
    },
    'mark-layer': el => {
      const id = el.getAttribute('data-reviewed-id') ?? ''
      markReviewed(el, id, !session.isReviewed(id), 'layer')
    },
    'point-dismiss': el => setDismissed(el, el.getAttribute('data-fingerprint') ?? '', true),
    'point-restore': el => setDismissed(el, el.getAttribute('data-fingerprint') ?? '', false),
    'show-dismissed': el => {
      const list = el.closest('.dismissed-list')?.querySelector('ol.findings.dismissed')
      if (list === null || list === undefined) {
        return
      }
      const open = list.hasAttribute('hidden')
      list.toggleAttribute('hidden', !open)
      el.setAttribute('aria-expanded', open ? 'true' : 'false')
      el.textContent = open ? 'hide' : 'show'
    },
    'point-post': el => {
      const point = pointById(el.getAttribute('data-point') ?? '')
      if (point !== undefined) {
        postPoint(el, point)
      }
    },
    'point-queue': el => {
      const point = pointById(el.getAttribute('data-point') ?? '')
      if (point !== undefined) {
        queuePoint(el, point)
      }
    },
    'comment-line': el => {
      const key = el.getAttribute('data-key') ?? ''
      const path = session.pathForKey(key)
      const line = Number(el.getAttribute('data-line'))
      if (path === undefined || !Number.isInteger(line) || line <= 0) {
        return
      }
      openLineComposer({ key, path, side: el.getAttribute('data-side') === 'old' ? 'old' : 'new', line })
    },
    'comment-selection': () => {
      if (selection !== null) {
        openLineComposer({ ...selection, line: selection.end, startLine: selection.start })
      }
    },
    'composer-post': el => {
      const box = el.closest('.composer-box')
      if (box !== null) {
        postFromComposer(el, box)
      }
    },
    'composer-queue': el => {
      const box = el.closest('.composer-box')
      if (box !== null) {
        queueFromComposer(el, box)
      }
    },
    'pending-edit': el => {
      const id = el.getAttribute('data-pending-id')
      const draft = session.pending.find(p => p.id === id)
      const host = el.closest('.pending-cmt')
      if (draft === undefined || host === null) {
        return
      }
      composerSeq += 1
      // The box replaces the draft it edits, so the reader sees one of the two at a time.
      const node = openComposer(
        host,
        {
          id: `composer-${composerSeq}`,
          label: `Edit your comment on ${draft.path}:${draft.line}`,
          kind: 'inline',
          body: draft.body,
          pendingId: draft.id,
        },
        'block'
      )
      if (node !== null) {
        concealForComposer(host)
      }
    },
    'pending-save': el => {
      const box = el.closest('.composer-box')
      if (box !== null) {
        savePending(el, box)
      }
    },
    'pending-delete': el => {
      const id = el.getAttribute('data-pending-id')
      if (id !== null) {
        deletePending(el, id)
      }
    },
    'pending-finish': el => {
      // Finishing a review is the same dialog the sign-off commands open; a review being written
      // usually has something to say, so it opens on the verdict that claims nothing.
      openSignoff(el, 'COMMENT')
    },
    'pending-discard': el => {
      void runCommand(
        el,
        async () => {
          const count = pendingCount(session.state)
          await session.discardPending()
          toast(root, `${count} pending comment${count === 1 ? '' : 's'} discarded`)
        },
        { pendingLabel: 'discarding…' }
      )
    },
    'markdown-toggle': el => toggleMarkdownPreview(el),
    'composer-cancel': () => {
      closeComposers(root)
    },
    'thread-hide': el => {
      const id = Number(el.getAttribute('data-thread'))
      const row = el.closest('tr.thread')
      void runCommand(
        el,
        async () => {
          await session.setThreadHidden(id, true)
          if (row !== null) {
            setThreadCollapsed(row, true)
          }
        },
        { pendingLabel: 'hiding…' }
      )
    },
    'thread-collapse': el => {
      const row = el.closest('tr.thread')
      if (row !== null) {
        setThreadCollapsed(row, true)
      }
    },
    'thread-show': el => {
      const row = el.closest('tr.thread')
      if (row === null) {
        return
      }
      if (!row.classList.contains('hidden-thread')) {
        // A resolved thread is only folded away on screen, so opening it is local.
        setThreadCollapsed(row, false)
        return
      }
      const id = Number(el.getAttribute('data-thread'))
      void runCommand(
        el,
        async () => {
          await session.setThreadHidden(id, false)
          setThreadCollapsed(row, false)
        },
        { pendingLabel: 'showing…' }
      )
    },
    'thread-reply': el => {
      const full = el.closest('.thread-full')
      const id = Number(el.getAttribute('data-thread'))
      if (full === null || !Number.isInteger(id)) {
        return
      }
      composerSeq += 1
      openComposer(
        full,
        { id: `composer-${composerSeq}`, label: 'Reply', kind: 'reply', inReplyToId: id },
        'block'
      )
    },
    'pr-comment': () => {
      const host = root.querySelector('.conversation .pr-composer-host')
      if (host !== null) {
        composerSeq += 1
        openComposer(
          host,
          { id: `composer-${composerSeq}`, label: 'Comment on this pull request', kind: 'issue' },
          'block'
        )
      }
    },
    signoff: el => {
      openSignoff(el, signoffEvent(el.getAttribute('data-event')))
    },
    'signoff-post': el => postSignoff(el),
    'signoff-close': el => {
      el.closest('dialog')?.close()
    },
    ask: el => {
      const chat = opts.chat?.() ?? null
      if (chat === null) {
        toast(root, NO_CHAT_NOTE)
        return
      }
      chat.ask(chatContextFromElement(el))
    },
    'show-fold': el => {
      const summary = el.closest('tr.more.fold')
      if (summary instanceof HTMLTableRowElement) {
        setFoldShown(summary, el.getAttribute('aria-expanded') !== 'true')
      }
    },
    'jump-line': el => {
      const line = Number(el.getAttribute('data-line'))
      if (!Number.isInteger(line) || line <= 0) {
        return
      }
      const side = el.getAttribute('data-side') === 'old' ? 'old' : 'new'
      const row = findRow(root, el.getAttribute('data-key') ?? '', side, line)
      if (row === null) {
        return
      }
      // scrollIntoViewSafe raises `reveal-code` first, so a target inside a fold opens on the way.
      scrollIntoViewSafe(row)
      flash(row)
    },
    settings: el => {
      opts.openSettings?.(el)
    },
    help: () => {
      openHelpDialog(root)
    },
  }

  /** @param {Event} event */
  const onClick = event => {
    const el = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!(el instanceof HTMLElement) || el.hasAttribute('disabled')) {
      return
    }
    const act = actions[el.getAttribute('data-act') ?? '']
    if (act !== undefined) {
      event.preventDefault()
      act(el, /** @type {MouseEvent} */ (event))
    }
  }

  /** @param {Event} event */
  const onChange = event => {
    const input = event.target
    if (input instanceof HTMLSelectElement && input.id === FOLD_LEVEL_SELECT_ID) {
      applyFoldLevel(input.value)
      return
    }
    if (!(input instanceof HTMLInputElement)) {
      return
    }
    const id = input.getAttribute('data-reviewed-id')
    if (id === null) {
      return
    }
    const kind = id.includes('/file:') ? 'file' : 'layer'
    const label = input.closest('label')
    markReviewed(label instanceof HTMLElement ? label : input, id, input.checked, kind, { quiet: true })
  }

  /** @param {PointerEvent} event */
  const onPointerDown = event => {
    const target = lineRefFromEvent(event, key => session.pathForKey(key))
    if (target === null) {
      return
    }
    event.preventDefault()
    setSelection(
      selectionReducer(
        selection,
        event.shiftKey ? { type: 'shift-click', target } : { type: 'click', target }
      )
    )
    if (selection !== null && !event.shiftKey) {
      setSelection(selectionReducer(selection, { type: 'drag-start', target }))
    }
  }

  /** @param {PointerEvent} event */
  const onPointerOver = event => {
    if (selection?.dragging !== true) {
      return
    }
    const target = lineRefFromEvent(event, key => session.pathForKey(key))
    if (target !== null) {
      setSelection(selectionReducer(selection, { type: 'drag-over', target }))
    }
  }

  const onPointerUp = () => {
    if (selection?.dragging === true) {
      setSelection(selectionReducer(selection, { type: 'commit' }))
    }
  }

  /** @param {KeyboardEvent} event */
  const onKeyDown = event => {
    const decided = keyAction(event, { pendingG })
    pendingG = decided.pendingG
    if (decided.action === null) {
      return
    }
    // While a dialog is open it owns the keyboard, Esc included: the browser closes it, and the
    // page behind it keeps its selection and its open composer.
    if (doc.querySelector('dialog[open]') !== null) {
      return
    }
    const order = buildNavOrder(session.artifact)
    const points = session.artifact.points.filter(p => session.state.dismissed[p.fingerprint] === undefined)
    switch (decided.action) {
      case 'next-layer':
      case 'prev-layer':
      case 'next-file':
      case 'prev-file': {
        const step =
          decided.action === 'next-layer'
            ? nextLayer
            : decided.action === 'prev-layer'
              ? prevLayer
              : decided.action === 'next-file'
                ? nextFile
                : prevFile
        const item = step(order, itemAround(order, here(order)), isCardShown)
        if (item !== null) {
          focusPointId = null
          focusItem(item.id)
        }
        break
      }
      case 'next-point':
      case 'prev-point':
        stepPoint(order, points, decided.action === 'next-point' ? 1 : -1)
        break
      case 'toggle':
        // A point in focus stands for the card that holds it, a row of the Other layer included.
        if (focusedEl?.isConnected === true) {
          setCardCollapsed(focusedEl)
        }
        break
      case 'reviewed-file':
      case 'reviewed-layer': {
        // A point in focus stands for the card that holds it.
        const itemId = focusedEl?.isConnected === true ? itemAround(order, focusedEl) : focusId
        const item = order.find(i => i.id === itemId)
        const wanted = decided.action === 'reviewed-file' ? 'file' : 'layer'
        const found =
          item?.kind === wanted ? item : wanted === 'layer' && itemId !== null ? layerOf(order, itemId) : null
        if (found === null || found === undefined || found.kind === 'overview') {
          break
        }
        const id = found.kind === 'file' ? reviewedId(found.layerKey, found.path) : reviewedId(found.layerKey)
        const parts = cardForReviewedId(root, id)
        const box = parts?.card.querySelector('input[data-reviewed-id]')
        if (box instanceof HTMLElement) {
          markReviewed(box, id, !session.isReviewed(id), found.kind, { quiet: true })
        }
        break
      }
      case 'comment': {
        const point = points.find(p => p.id === focusPointId)
        const key = point === undefined ? null : keyForPath(point.path)
        if (selection !== null) {
          openLineComposer({ ...selection, line: selection.end, startLine: selection.start })
        } else if (point !== undefined && key !== null) {
          // With nothing selected, c comments on the line of the attention point in focus.
          openLineComposer({ key, path: point.path, side: point.side ?? 'new', line: point.line })
        }
        break
      }
      case 'dismiss': {
        const point = points.find(p => p.id === focusPointId)
        const button =
          point === undefined
            ? null
            : root.querySelector(`[data-point="${cssEscape(point.id)}"] [data-act="point-dismiss"]`)
        if (button instanceof HTMLElement && point !== undefined) {
          focusPointId = null
          setDismissed(button, point.fingerprint, true)
        }
        break
      }
      case 'fold-level':
        // The key steps through the levels, so the reader can open the code up without the mouse.
        applyFoldLevel(nextFoldLevel(getFoldLevel()))
        break
      case 'overview':
        focusPointId = null
        focusItem('overview')
        break
      case 'help':
        openHelpDialog(root)
        break
      case 'ask': {
        // `a` asks about whatever is in focus: an attention point, a selection, or the card.
        const chat = opts.chat?.() ?? null
        const target = askTargetFor(root, focusId, focusPointId, selection)
        if (chat === null) {
          toast(root, NO_CHAT_NOTE)
          break
        }
        chat.ask(target)
        break
      }
      case 'focus-chat':
        opts.chat?.()?.focusInput()
        break
      case 'escape':
        if (closeComposers(root) === 0) {
          setSelection(selectionReducer(selection, { type: 'clear' }))
        }
        break
    }
  }

  root.addEventListener('click', onClick)
  root.addEventListener('change', onChange)
  root.addEventListener('pointerdown', /** @type {EventListener} */ (onPointerDown))
  root.addEventListener('pointerover', /** @type {EventListener} */ (onPointerOver))
  doc.addEventListener('pointerup', onPointerUp)
  doc.addEventListener('pointercancel', onPointerUp)
  doc.addEventListener('keydown', /** @type {EventListener} */ (onKeyDown))
  applyCapabilityGating(root, session.capabilities)

  return {
    /**
     * What the chat's proposed-comment card does: post it straight away, or open the same
     * composer the rest of the page uses, prefilled.
     * @param {'post' | 'edit'} what
     * @param {import('./proposed-comment.js').ProposedComment} comment
     * @param {HTMLElement} el
     */
    onProposedComment(what, comment, el) {
      const key = keyForPath(comment.path)
      if (what === 'edit') {
        if (key === null) {
          showCommandError(el, `${comment.path} is not a file of this pull request`)
          return
        }
        composerSeq += 1
        /** @type {import('./composer.js').ComposerOptions} */
        const options = {
          id: `composer-${composerSeq}`,
          label: `Comment on ${comment.path}:${comment.line}`,
          kind: 'inline',
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body,
        }
        if (comment.startLine !== undefined && comment.startLine !== comment.line) {
          options.startLine = comment.startLine
        }
        const row = findRow(root, key, comment.side, comment.line)
        if (row === null) {
          showCommandError(el, 'that line is not on screen; open the file card first')
          return
        }
        openComposer(row, options, 'row')
        return
      }
      void runCommand(
        el,
        async () => {
          const input = {
            kind: /** @type {const} */ ('inline'),
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body,
            ...(comment.startLine === undefined || comment.startLine === comment.line
              ? {}
              : { startLine: comment.startLine }),
          }
          const answer = await postComment(input)
          replacePostButton(el, answer.comment.url)
          toast(root, 'comment posted to github')
        },
        { pendingLabel: 'posting…' }
      )
    },
    /** Lets the caller re-apply the gating after the probe answers. */
    refreshCapabilities() {
      applyCapabilityGating(root, session.capabilities)
    },
    stop() {
      unsubscribe()
      setCardRenderedHook(null)
      root.removeEventListener('click', onClick)
      root.removeEventListener('change', onChange)
      root.removeEventListener('pointerdown', /** @type {EventListener} */ (onPointerDown))
      root.removeEventListener('pointerover', /** @type {EventListener} */ (onPointerOver))
      doc.removeEventListener('pointerup', onPointerUp)
      doc.removeEventListener('pointercancel', onPointerUp)
      doc.removeEventListener('keydown', /** @type {EventListener} */ (onKeyDown))
    },
  }
}
