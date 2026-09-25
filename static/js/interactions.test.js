// @ts-check
// @vitest-environment happy-dom
// The review screen as the reader works it: collapsing cards, marking them reviewed, dismissing
// attention points, posting comments, hiding threads, and signing off.
import { emptyState } from '../../src/contract/state.js'
import { toPatchMap } from '../../src/git/diff-collector.js'
import { mapIssueComment, mapReviewComment } from '../../src/github/comments.js'
import {
  GH_ISSUE_COMMENTS,
  GH_REVIEW_COMMENTS,
  SYNTHETIC_FILES,
  syntheticArtifact,
} from '../../src/testing/synthetic.js'
import { setChatEnabled } from './ask.js'
import { wireFoldReveal } from './code-folds.js'
import { renderDiff } from './diff-renderer.js'
import { renderHeader } from './header.js'
import { carriedOverBarHtml } from './empty-state.js'
import { askTargetFor, nextUnreviewedTarget, toast, wireReview } from './interactions.js'
import {
  cardOf,
  defineLayerElements,
  hydrateAll,
  getRenderContext,
  hydrateFileCard,
  renderLayers,
  renderRail,
  setCardCollapsed,
  setRenderContext,
} from './layers.js'
import { initOneLayer } from './one-layer.js'
import { renderOverview } from './overview.js'
import { createReviewSession } from './review-session.js'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const artifact = syntheticArtifact()
const files = artifact.files
const patches = toPatchMap(SYNTHETIC_FILES)
const comments = GH_REVIEW_COMMENTS.map(c => mapReviewComment(c, new Set([1001, 1002])))
const issueComments = GH_ISSUE_COMMENTS.map(mapIssueComment)
const BASE = emptyState(NOW.toISOString())
const HEAD = artifact.pr.headSha

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * @param {import('./contract-types.js').PrState} state
 * @param {import('./contract-types.js').ReviewArtifact} [canvas]
 */
function bundleFor(state, canvas = artifact) {
  return /** @type {import('./contract-types.js').PrBundle} */ ({
    status: 'ready',
    pr: artifact.pr,
    files,
    derivable: true,
    artifact: canvas,
    canvas: { headSha: artifact.pr.headSha, source: 'local', manifest: null },
    skillCommand: '/pr-review-canvas 42',
    comments: {
      fetchedAt: NOW.toISOString(),
      headSha: artifact.pr.headSha,
      reviewComments: comments,
      issueComments,
    },
    state,
    capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
    chat: { enabled: false, acpx: true },
    largePr: false,
    warnings: [],
  })
}

/**
 * The whole review screen, hydrated and wired, with a fake API in place of the server.
 * @param {{ state?: import('./contract-types.js').PrState, api?: Partial<import('./review-session.js').SessionApi>, capabilities?: import('./contract-types.js').Capabilities, comments?: ReadonlyArray<import('./contract-types.js').ReviewComment>, fetchReviewBody?: (n: import('./contract-types.js').ReviewKey) => Promise<import('./contract-types.js').ReviewBodyResponse>, chat?: () => ReturnType<typeof import('./chat.js').wireChat>, openSettings?: (el: HTMLElement) => void, artifact?: import('./contract-types.js').ReviewArtifact, drawn?: boolean }} [opts]
 *   `drawn: false` leaves every diff waiting to be seen, as cards below the fold do in a browser.
 */
function setup(opts = {}) {
  const state = opts.state ?? BASE
  const threadComments = opts.comments ?? comments
  const canvas = opts.artifact ?? artifact
  const bundle = bundleFor(state, canvas)
  const ctx = {
    artifact: canvas,
    headSha: artifact.pr.headSha,
    files,
    patches,
    comments: threadComments,
    state,
    now: NOW,
  }
  setRenderContext(ctx)
  if (opts.drawn === false) {
    // An observer that never sees a card, so each <pr-file> waits for a key or a link to draw it.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    defineLayerElements()
  }
  const paths = new Set(files.map(f => f.path))
  document.body.innerHTML =
    `<pr-app id="root">${renderHeader(bundle, { host: 'localhost:3010', theme: 'auto', skin: 'terminal', now: NOW })}` +
    `<div class="layout">${renderRail(artifact, state)}<main id="main">${renderOverview(bundle, { paths, now: NOW })}` +
    `${renderLayers(canvas, files, state, threadComments)}</main></div></pr-app>`
  const root = document.querySelector('#root')
  if (!(root instanceof HTMLElement)) {
    throw new Error('no root')
  }
  if (opts.drawn !== false) {
    hydrateAll(root, ctx)
  }
  /** @type {Array<[string, unknown]>} */
  const calls = []
  // What the server holds, which the page does not get to write directly.
  let stored = state
  let pendingSeq = 0
  /** @type {import('./review-session.js').SessionApi} */
  const api = {
    putReviewed: async (_pr, id, reviewed) => {
      calls.push(['reviewed', { id, reviewed }])
      stored = applyReviewed(stored, id, reviewed)
      return { prNumber: 42, state: stored }
    },
    putDismissed: async (_pr, fingerprint, dismissed) => {
      calls.push(['dismissed', { fingerprint, dismissed }])
      const next = { ...stored.dismissed }
      if (dismissed) {
        next[fingerprint] = { at: NOW.toISOString() }
      } else {
        delete next[fingerprint]
      }
      stored = { ...stored, dismissed: next }
      return { prNumber: 42, state: stored }
    },
    putThreadHidden: async (_pr, id, hidden) => {
      calls.push(['hidden', { id, hidden }])
      const next = { ...stored.hiddenThreads }
      if (hidden) {
        next[String(id)] = { at: NOW.toISOString() }
      } else {
        delete next[String(id)]
      }
      stored = { ...stored, hiddenThreads: next }
      return { prNumber: 42, state: stored }
    },
    postComment: async (_pr, input) => {
      calls.push(['comment', input])
      const comment = input.kind === 'issue' ? postedIssueComment() : postedReviewComment(input)
      stored = {
        ...stored,
        posted: [
          ...stored.posted,
          {
            commentId: comment.id,
            at: NOW.toISOString(),
            ...(input.kind === 'inline' && input.pointFingerprint !== undefined
              ? { pointFingerprint: input.pointFingerprint }
              : {}),
          },
        ],
      }
      return input.kind === 'issue'
        ? { kind: 'issue', comment: postedIssueComment(), state: stored }
        : { kind: 'review', comment: postedReviewComment(input), state: stored }
    },
    postReview: async (_pr, input) => {
      calls.push(['review', input])
      // The route sends back the state with the drafts cleared, and says how many went out.
      const drafts = input.includePending === false ? [] : stored.pending
      const created = drafts.map((p, index) => ({
        ...postedReviewComment({ ...p, kind: 'inline' }),
        id: 8001 + index,
        url: `https://github.com/acme/widgets/pull/42#discussion_r${8001 + index}`,
      }))
      const submitted = drafts.length
      if (submitted > 0) {
        stored = {
          ...stored,
          pending: [],
          posted: [
            ...stored.posted,
            ...drafts.map((p, index) => ({
              commentId: 8001 + index,
              at: NOW.toISOString(),
              ...(p.pointFingerprint === undefined ? {} : { pointFingerprint: p.pointFingerprint }),
            })),
          ],
        }
      }
      return {
        review: {
          id: 7001,
          state:
            input.event === 'APPROVE'
              ? 'APPROVED'
              : input.event === 'REQUEST_CHANGES'
                ? 'CHANGES_REQUESTED'
                : 'COMMENTED',
          url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
          submittedAt: null,
        },
        submitted,
        comments: created,
        warnings: [],
        state: stored,
      }
    },
    addPending: async (_pr, input) => {
      calls.push(['pending-add', input])
      pendingSeq += 1
      stored = {
        ...stored,
        pending: [
          ...stored.pending,
          {
            id: `p${pendingSeq}`,
            path: input.path,
            line: input.line,
            side: input.side,
            ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
            body: input.body,
            ...(input.pointFingerprint === undefined ? {} : { pointFingerprint: input.pointFingerprint }),
            headSha: HEAD,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        ],
      }
      return { prNumber: 42, state: stored }
    },
    editPending: async (_pr, id, body) => {
      calls.push(['pending-edit', { id, body }])
      stored = { ...stored, pending: stored.pending.map(p => (p.id === id ? { ...p, body } : p)) }
      return { prNumber: 42, state: stored }
    },
    deletePending: async (_pr, id) => {
      calls.push(['pending-delete', { id }])
      stored = { ...stored, pending: stored.pending.filter(p => p.id !== id) }
      return { prNumber: 42, state: stored }
    },
    discardPending: async () => {
      calls.push(['pending-discard', {}])
      stored = { ...stored, pending: [] }
      return { prNumber: 42, state: stored }
    },
    ...opts.api,
  }
  const session = createReviewSession({
    prNumber: 42,
    artifact: canvas,
    files,
    state,
    capabilities: opts.capabilities ?? { canComment: true, tokenKind: 'classic', login: 'octocat' },
    headSha: artifact.pr.headSha,
    api,
  })
  const wiring = wireReview(root, session, {
    ...(opts.fetchReviewBody ? { fetchReviewBody: opts.fetchReviewBody } : {}),
    ...(opts.chat ? { chat: opts.chat } : {}),
    ...(opts.openSettings ? { openSettings: opts.openSettings } : {}),
  })
  wirings.push(wiring)
  return { root, session, calls, wiring }
}

/**
 * @param {import('./contract-types.js').PrState} state
 * @param {string} id
 * @param {boolean} reviewed
 */
function applyReviewed(state, id, reviewed) {
  const next = { ...state.reviewed }
  if (reviewed) {
    next[id] = true
  } else {
    delete next[id]
  }
  return { ...state, reviewed: next }
}

/** @param {import('./contract-types.js').PostCommentInput} input */
function postedReviewComment(input) {
  const inReplyToId = input.kind === 'reply' ? input.inReplyToId : undefined
  return /** @type {import('./contract-types.js').ReviewComment} */ ({
    id: 5001,
    author: 'octocat',
    body: input.body,
    path: input.kind === 'inline' ? input.path : 'src/app.ts',
    line: input.kind === 'inline' ? input.line : 4,
    originalLine: 4,
    side: 'new',
    outdated: false,
    commitId: artifact.pr.headSha,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
    resolved: false,
    ...(inReplyToId === undefined ? {} : { inReplyToId }),
  })
}

function postedIssueComment() {
  return /** @type {import('./contract-types.js').IssueComment} */ ({
    id: 6001,
    author: 'octocat',
    body: 'looks fine',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
  })
}

/** @param {ParentNode} root @param {string} selector */
function click(root, selector) {
  const el = root.querySelector(selector)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`no element for ${selector}`)
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return el
}

/**
 * The synthetic canvas with a second semantic layer after Run path. It takes `src/new.ts` out of
 * Other, so each chunk still has one layer, as publish checks.
 */
function withSecondLayer() {
  const [runPath, other] = artifact.layers
  if (runPath === undefined || other === undefined) {
    throw new Error('fixture changed')
  }
  const moved = (/** @type {{ path: string }} */ f) => f.path === 'src/new.ts'
  const second = {
    ...runPath,
    id: 'second',
    key: 'second',
    title: 'Second',
    files: other.files.filter(moved),
  }
  const rest = { ...other, files: other.files.filter(f => !moved(f)) }
  return { ...artifact, layers: [runPath, second, rest] }
}

/** @type {Array<{ stop: () => void }>} */
const wirings = []

afterEach(() => {
  for (const wiring of wirings.splice(0)) {
    wiring.stop()
  }
  setRenderContext(null)
})

describe('card toggles', () => {
  it('collapses and opens a file card without touching anything else', () => {
    const { root } = setup()
    const card = root.querySelector('article.file#file-src_app_ts')
    const checkbox = card?.querySelector('input[data-reviewed-id]')
    const otherCard = root.querySelector('article.file#file-src_new_name_ts')
    click(root, 'article.file#file-src_app_ts .file-h .chev')
    expect(card?.querySelector('.file-body')?.hasAttribute('hidden')).toBe(true)
    expect(card?.querySelector('.chev')?.getAttribute('aria-expanded')).toBe('false')
    expect(checkbox instanceof HTMLInputElement ? checkbox.checked : true).toBe(false)
    expect(otherCard?.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
    click(root, 'article.file#file-src_app_ts .file-h .chev')
    expect(card?.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('collapses a layer section from its own chevron', () => {
    const { root } = setup()
    click(root, 'section.layer .layer-h .chev')
    expect(root.querySelector('section.layer > .layer-body')?.hasAttribute('hidden')).toBe(true)
  })

  it('answers null for an element that is in no card', () => {
    document.body.innerHTML = '<div id="x"></div>'
    const el = document.querySelector('#x')
    expect(el === null ? null : cardOf(el)).toBeNull()
    expect(el === null ? null : setCardCollapsed(el)).toBeNull()
  })
})

describe('reviewed state', () => {
  it('marks a file reviewed, collapses it, and counts it in the rail', async () => {
    const { root, calls } = setup()
    const box = root.querySelector('article.file#file-src_app_ts input[data-reviewed-id]')
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no checkbox')
    }
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path/file:src_app_ts', reviewed: true }]])
    expect(root.querySelector('article.file#file-src_app_ts .file-body')?.hasAttribute('hidden')).toBe(true)
    expect(root.querySelector('.tree .layers .m')?.textContent).toContain('1 of 3 files')
    expect(root.querySelector('.toast')?.textContent).toBe('file marked reviewed')
  })

  it('marks the layer reviewed from the command under its files, and fills the progress line', async () => {
    const { root, calls } = setup()
    click(root, '.layer-end [data-act="mark-layer"]')
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: true }]])
    expect(root.querySelector('.ptext')?.textContent).toBe('1 of 1 layers reviewed')
    expect(root.querySelector('.pline span')?.getAttribute('style')).toContain('100%')
    expect(root.querySelector('section.layer > .layer-body')?.hasAttribute('hidden')).toBe(true)
    expect(root.querySelector('#approve')?.hasAttribute('disabled')).toBe(false)
    const box = root.querySelector('section.layer input[data-reviewed-id]')
    expect(box instanceof HTMLInputElement && box.checked).toBe(true)
  })

  it('takes the mark back and says why when the server refuses', async () => {
    const { root } = setup({ api: { putReviewed: () => Promise.reject(new Error('offline')) } })
    const box = root.querySelector('section.layer input[data-reviewed-id]')
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no checkbox')
    }
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(box.checked).toBe(false)
    expect(root.querySelector('.ptext')?.textContent).toBe('0 of 1 layers reviewed')
    expect(root.querySelector('.cmd-err')?.textContent).toBe('offline')
  })

  it('opens the file cards the server reopened with their layer', async () => {
    const reviewed = {
      ...BASE,
      reviewed: {
        'layer:run-path': /** @type {const} */ (true),
        'layer:run-path/file:src_app_ts': /** @type {const} */ (true),
      },
    }
    const { root } = setup({
      state: reviewed,
      // Reopening a layer reopens its files, which is what the real store does.
      api: {
        putReviewed: async () => ({ prNumber: 42, state: { ...reviewed, reviewed: {} } }),
      },
    })
    const card = root.querySelector('article.file#file-src_app_ts')
    expect(card?.classList.contains('is-reviewed')).toBe(true)
    click(root, '.layer-end [data-act="mark-layer"]')
    await flush()
    expect(card?.classList.contains('is-reviewed')).toBe(false)
    expect(card?.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('leaves a layer that is reviewed through its files alone when something else changes', async () => {
    const byFiles = {
      ...BASE,
      reviewed: {
        'layer:run-path/file:src_app_ts': /** @type {const} */ (true),
        'layer:run-path/file:src_new_name_ts': /** @type {const} */ (true),
        'layer:run-path/file:src_app_test_ts': /** @type {const} */ (true),
      },
    }
    const { root } = setup({ state: byFiles })
    const layer = root.querySelector('section.layer')
    expect(layer?.classList.contains('is-reviewed')).toBe(true)
    // Dismissing a point redraws the state; the layer stays reviewed and folded away.
    click(root, '.findings [data-fingerprint="fp-1"] [data-act="point-dismiss"]')
    await flush()
    expect(layer?.classList.contains('is-reviewed')).toBe(true)
    expect(root.querySelector('section.layer > .layer-body')?.hasAttribute('hidden')).toBe(true)
  })

  it('opens a reviewed card again when it is unmarked', async () => {
    const reviewed = { ...BASE, reviewed: { 'layer:run-path': /** @type {const} */ (true) } }
    const { root } = setup({ state: reviewed })
    expect(root.querySelector('section.layer > .layer-body')?.hasAttribute('hidden')).toBe(true)
    const box = root.querySelector('section.layer input[data-reviewed-id]')
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no checkbox')
    }
    box.checked = false
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(root.querySelector('section.layer > .layer-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('finds the next card that still needs a look', () => {
    const { root, session } = setup()
    expect(nextUnreviewedTarget(root, session, 'file-src_app_ts', 'file')?.id).toBe('file-src_new_name_ts')
    expect(nextUnreviewedTarget(root, session, 'overview', 'layer')?.id).toBe('layer-run-path')
    // The Other layer is skipped, and there is nothing after the last semantic layer.
    expect(nextUnreviewedTarget(root, session, 'layer-run-path', 'layer')).toBeNull()
  })

  describe('the last open file of a layer', () => {
    const lastOpen = {
      ...BASE,
      reviewed: {
        'layer:run-path/file:src_app_ts': /** @type {const} */ (true),
        'layer:run-path/file:src_new_name_ts': /** @type {const} */ (true),
      },
    }
    /** @param {HTMLElement} root */
    const markLast = async root => {
      const box = root.querySelector('#file-src_app_test_ts input[data-reviewed-id]')
      if (!(box instanceof HTMLInputElement)) {
        throw new Error('no checkbox')
      }
      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    }

    it('moves on to the next layer when every layer shows', async () => {
      const { root } = setup({ artifact: withSecondLayer(), state: lastOpen })
      await markLast(root)
      expect(root.querySelector('.is-focused')?.id).toBe('file-src_new_ts')
    })

    it('stays in its layer when one layer shows at a time', async () => {
      const { root, calls } = setup({ artifact: withSecondLayer(), state: lastOpen })
      wirings.push(initOneLayer(root, { view: 'one' }))
      click(root, 'nav.rail a[href="#layer-run-path"]')
      await markLast(root)
      expect(calls).toEqual([['reviewed', { id: 'layer:run-path/file:src_app_test_ts', reviewed: true }]])
      expect(root.querySelector('.is-focused')).toBeNull()
      expect(root.querySelector('#layer-run-path')?.hasAttribute('hidden')).toBe(false)
      expect(root.querySelector('#layer-second')?.hasAttribute('hidden')).toBe(true)
    })
  })

  it('unmarks a layer from the command under its files', async () => {
    const { root, calls } = setup({ state: { ...BASE, reviewed: { 'layer:run-path': true } } })
    click(root, '.layer-end [data-act="mark-layer"]')
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: false }]])
    expect(root.querySelector('section.layer > .layer-body')?.hasAttribute('hidden')).toBe(false)
    expect(root.querySelector('.toast')?.textContent).toBe('layer reopened')
  })

  it('keeps working after the render context is gone', async () => {
    const { root, calls } = setup()
    setRenderContext(null)
    click(root, '.layer-end [data-act="mark-layer"]')
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: true }]])
  })
})

describe('attention points', () => {
  it('dismisses a point everywhere it shows, and counts only the active ones', async () => {
    const { root, calls } = setup()
    expect(root.querySelector('.sevsum')?.textContent).toContain('1')
    click(root, '.findings [data-fingerprint="fp-1"] [data-act="point-dismiss"]')
    await flush()
    expect(calls).toEqual([['dismissed', { fingerprint: 'fp-1', dismissed: true }]])
    expect(
      root.querySelector('section.layer li.finding[data-fingerprint="fp-1"]')?.hasAttribute('hidden')
    ).toBe(true)
    expect(root.querySelector('tr.ifind[data-fingerprint="fp-1"]')?.hasAttribute('hidden')).toBe(true)
    expect(root.querySelector('.point-count')?.textContent).toBe('0')
    expect(root.querySelector('.dismissed-line')?.textContent).toContain('1 dismissed')
  })

  it('closes the dismissed list again on a second click', () => {
    const { root } = setup({ state: { ...BASE, dismissed: { 'fp-1': { at: NOW.toISOString() } } } })
    const show = click(root, '[data-act="show-dismissed"]')
    click(root, '[data-act="show-dismissed"]')
    expect(show.textContent).toBe('show')
    expect(root.querySelector('.findings.dismissed')?.hasAttribute('hidden')).toBe(true)
  })

  it('keeps the link of a point that was posted before it was dismissed', () => {
    const { root } = setup({
      state: {
        ...BASE,
        dismissed: { 'fp-1': { at: NOW.toISOString() } },
        posted: [{ commentId: 1001, pointFingerprint: 'fp-1', at: NOW.toISOString() }],
      },
    })
    click(root, '[data-act="show-dismissed"]')
    expect(root.querySelector('.findings.dismissed .tbtns a')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42#discussion_r1001'
    )
  })

  it('shows the dismissed list and restores a point from it', async () => {
    const { root, calls } = setup({ state: { ...BASE, dismissed: { 'fp-1': { at: NOW.toISOString() } } } })
    expect(root.querySelector('.findings.dismissed')?.hasAttribute('hidden')).toBe(true)
    const show = click(root, '[data-act="show-dismissed"]')
    expect(root.querySelector('.findings.dismissed')?.hasAttribute('hidden')).toBe(false)
    expect(show.textContent).toBe('hide')
    click(root, '.findings.dismissed [data-act="point-restore"]')
    await flush()
    expect(calls).toEqual([['dismissed', { fingerprint: 'fp-1', dismissed: false }]])
    expect(root.querySelector('.dismissed-list')?.hasAttribute('hidden')).toBe(true)
  })

  it('posts a point anchored on the old side', async () => {
    setRenderContext({
      artifact,
      headSha: artifact.pr.headSha,
      files,
      patches,
      comments,
      state: BASE,
      now: NOW,
    })
    document.body.innerHTML =
      '<div id="root"><button data-act="point-post" data-point="p-3">post</button></div>'
    const root = document.querySelector('#root')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    /** @type {Array<unknown>} */
    const sent = []
    const session = createReviewSession({
      prNumber: 42,
      artifact,
      files,
      state: BASE,
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        postComment: async (_pr, input) => {
          sent.push(input)
          return { kind: 'review', comment: postedReviewComment(input), state: BASE }
        },
      },
    })
    wirings.push(wireReview(root, session))
    click(root, '[data-act="point-post"]')
    await flush()
    expect(sent).toEqual([
      {
        kind: 'inline',
        path: 'src/gone.ts',
        line: 1,
        side: 'old',
        body: expect.stringContaining('Deleted file had no owner'),
        pointFingerprint: 'fp-3',
        headSha: artifact.pr.headSha,
      },
    ])
  })

  it('posts a point as an inline comment and marks the card posted', async () => {
    const { root, calls } = setup()
    click(root, '.findings [data-point="p-1"] [data-act="point-post"]')
    await flush()
    expect(calls).toEqual([
      [
        'comment',
        {
          kind: 'inline',
          path: 'src/app.ts',
          line: 4,
          side: 'new',
          body: expect.stringContaining('**Sum instead of product**'),
          pointFingerprint: 'fp-1',
          headSha: artifact.pr.headSha,
        },
      ],
    ])
    expect(root.querySelector('li.finding[data-point="p-1"] .tbtns a')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42#discussion_r5001'
    )
    expect(root.querySelector('li.finding[data-point="p-1"] [data-act="point-post"]')).toBeNull()
    expect(root.querySelector('tr.ifind[data-point="p-1"] .tbtns a')?.textContent).toBe('view comment')
  })

  it('keeps the posting button when GitHub refuses the point', async () => {
    const { root } = setup({
      api: {
        postComment: async () => {
          throw new Error('github is unavailable')
        },
      },
    })
    click(root, '.findings [data-point="p-1"] [data-act="point-post"]')
    await flush()
    expect(root.querySelector('.findings [data-act="point-post"]')?.textContent).toBe('post to github')
    expect(root.querySelector('.findings .cmd-err')?.textContent).toBe('github is unavailable')
    expect(root.querySelector('.findings .tbtns a')).toBeNull()
  })
})

describe('comment composers', () => {
  it('opens a composer from the gutter, posts it, and shows the comment', async () => {
    const { root, calls } = setup()
    click(root, '#L-src_app_ts-new-4 .plus')
    const box = root.querySelector('tr.composer .composer-box')
    expect(box?.getAttribute('data-path')).toBe('src/app.ts')
    const area = box?.querySelector('textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'look here'
    click(root, 'tr.composer [data-act="composer-post"]')
    await flush()
    expect(calls).toEqual([
      [
        'comment',
        { kind: 'inline', path: 'src/app.ts', line: 4, side: 'new', body: 'look here', headSha: HEAD },
      ],
    ])
    expect(root.querySelector('tr.composer')).toBeNull()
    expect(root.querySelector('tr.thread[data-thread="5001"] .cmt .prose')?.textContent).toContain(
      'look here'
    )
    expect(root.querySelector('.toast')?.textContent).toBe('comment posted to github')
  })

  /**
   * The review screen with one moderate fold over the body of the test in src/app.test.ts, and no
   * comments yet, at light.
   */
  function foldedPage() {
    const folded = {
      ...artifact,
      layers: artifact.layers.map(layer => ({
        ...layer,
        files: layer.files.map(f =>
          f.path === 'src/app.test.ts'
            ? {
                ...f,
                folds: [
                  {
                    title: 'runs',
                    side: /** @type {const} */ ('new'),
                    startLine: 3,
                    endLine: 4,
                    level: /** @type {const} */ ('moderate'),
                  },
                ],
              }
            : f
        ),
      })),
    }
    const page = setup({ artifact: folded, comments: [] })
    const select = page.root.querySelector('#fold-level')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no level control')
    }
    return {
      ...page,
      counter: page.root.querySelector('.fold-count'),
      line: () => page.root.querySelector('#L-src_app_test_ts-new-3'),
      pick: (/** @type {string} */ level) => {
        select.value = level
        select.dispatchEvent(new Event('change', { bubbles: true }))
      },
      /** @param {string} body */
      write: body => {
        click(page.root, '#L-src_app_test_ts-new-3 .plus')
        const area = page.root.querySelector('tr.composer textarea')
        if (!(area instanceof HTMLTextAreaElement)) {
          throw new Error('no textarea')
        }
        area.value = body
      },
    }
  }

  it.each([
    ['posted alone', 'composer-post'],
    ['submitted in a review', 'composer-queue'],
  ])('opens the code of a new thread %s at a raised level, and counts it open', async (_how, act) => {
    const { root, session, counter, line, pick, write } = foldedPage()

    // Without a thread the fold hides the test body at moderate, and the counter says so.
    pick('moderate')
    expect(line()?.hasAttribute('hidden')).toBe(true)
    expect(counter?.textContent).toContain('lines hidden')
    pick('light')

    write('why this value?')
    // The level rises while the comment is still in the composer, so only the post can reopen
    // the code.
    pick('moderate')
    expect(line()?.hasAttribute('hidden')).toBe(true)
    click(root, `tr.composer [data-act="${act}"]`)
    await flush()
    if (act === 'composer-queue') {
      await session.postReview('COMMENT', undefined)
    }

    expect(line()?.hasAttribute('hidden')).toBe(false)
    expect(root.querySelector('#file-src_app_test_ts .code-fold:not([hidden])')).toBeNull()
    expect(counter?.textContent).toBe('')
  })

  it('keeps a pending draft and its code open at a raised level, and after the card redraws', async () => {
    const { root, counter, line, pick, write } = foldedPage()
    write('needs a guard')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    const draft = () => root.querySelector('#file-src_app_test_ts tr.pending-row')

    pick('moderate')
    expect([line()?.hasAttribute('hidden'), draft()?.hasAttribute('hidden')]).toEqual([false, false])
    expect(counter?.textContent).toBe('')

    const card = root.querySelector('#file-src_app_test_ts')
    const ctx = getRenderContext()
    if (!(card instanceof HTMLElement) || ctx === null) {
      throw new Error('no card')
    }
    hydrateFileCard(card, ctx, { force: true })
    expect([line()?.hasAttribute('hidden'), draft()?.hasAttribute('hidden')]).toEqual([false, false])
    expect(card.querySelector('.code-fold:not([hidden])')).toBeNull()
  })

  it('refuses to post an empty box and keeps it open', async () => {
    const { root, calls } = setup()
    click(root, '#L-src_app_ts-new-4 .plus')
    click(root, 'tr.composer [data-act="composer-post"]')
    await flush()
    expect(calls).toEqual([])
    expect(root.querySelector('tr.composer')).not.toBeNull()
    expect(root.querySelector('.cmd-err')?.textContent).toBe('write something first')
  })

  it('keeps the draft and shows the error when GitHub refuses', async () => {
    const { root } = setup({ api: { postComment: () => Promise.reject(new Error('422 line not in diff')) } })
    click(root, '#L-src_app_ts-new-4 .plus')
    const area = root.querySelector('tr.composer textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'look here'
    click(root, 'tr.composer [data-act="composer-post"]')
    await flush()
    expect(root.querySelector('tr.composer textarea')).toBe(area)
    expect(area.value).toBe('look here')
    expect(root.querySelector('.cmd-err')?.textContent).toBe('422 line not in diff')
  })

  it('cancels a composer, and opens only one at a time', () => {
    const { root } = setup()
    click(root, '#L-src_app_ts-new-4 .plus')
    click(root, '#L-src_app_ts-new-2 .plus')
    expect(root.querySelectorAll('tr.composer').length).toBe(1)
    click(root, 'tr.composer [data-act="composer-cancel"]')
    expect(root.querySelector('tr.composer')).toBeNull()
  })

  it('comments on a deleted line, on the old side', async () => {
    const { root, calls } = setup()
    click(root, '#L-src_app_ts-old-3 .plus')
    const area = root.querySelector('tr.composer textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'why'
    click(root, 'tr.composer [data-act="composer-post"]')
    await flush()
    expect(calls).toEqual([
      ['comment', { kind: 'inline', path: 'src/app.ts', line: 3, side: 'old', body: 'why', headSha: HEAD }],
    ])
  })

  it('adds the comment even after the render context is gone', async () => {
    const { root } = setup()
    click(root, '[data-act="pr-comment"]')
    const area = root.querySelector('.pr-composer-host textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'looks fine'
    setRenderContext(null)
    click(root, '.pr-composer-host [data-act="composer-post"]')
    await flush()
    expect([...root.querySelectorAll('.conversation > .cmt .prose')].at(-1)?.textContent).toContain(
      'looks fine'
    )
  })

  it('replies under a thread', async () => {
    const { root, calls } = setup({ comments: comments.map(c => ({ ...c, resolved: false })) })
    click(root, 'tr.thread[data-thread="1001"] [data-act="thread-reply"]')
    const area = root.querySelector('.thread-full .composer-box textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'agreed'
    click(root, '.thread-full [data-act="composer-post"]')
    await flush()
    expect(calls).toEqual([['comment', { kind: 'reply', inReplyToId: 1001, body: 'agreed', headSha: HEAD }]])
    expect(root.querySelector('.thread-full .composer-box')).toBeNull()
    expect(
      [...root.querySelectorAll('tr.thread[data-thread="1001"] .cmt .prose')].at(-1)?.textContent
    ).toContain('agreed')
  })

  it('comments on the pull request itself', async () => {
    const { root, calls } = setup()
    click(root, '[data-act="pr-comment"]')
    const area = root.querySelector('.pr-composer-host textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'looks fine'
    click(root, '.pr-composer-host [data-act="composer-post"]')
    await flush()
    expect(calls).toEqual([['comment', { kind: 'issue', body: 'looks fine', headSha: HEAD }]])
    expect([...root.querySelectorAll('.conversation > .cmt .prose')].at(-1)?.textContent).toContain(
      'looks fine'
    )
    expect(root.querySelector('.pr-composer-host .composer-box')).toBeNull()
  })
})

describe('what the page remembers after a reload', () => {
  it('shows the point as posted, with the link, from the state', () => {
    const posted = {
      ...BASE,
      posted: [{ commentId: 1001, pointFingerprint: 'fp-1', at: NOW.toISOString() }],
    }
    const { root } = setup({ state: posted })
    const card = root.querySelector('li.finding[data-fingerprint="fp-1"] .tbtns a')
    expect(card?.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42#discussion_r1001')
    expect(root.querySelector('tr.ifind[data-fingerprint="fp-1"] .tbtns a')?.textContent).toBe('view comment')
  })

  it('disables the posting commands of a card that draws after the page was wired', () => {
    const { root, session } = setup({
      capabilities: { canComment: false, tokenKind: 'classic', login: 'octocat', reason: 'no repo scope' },
    })
    const ctx = { artifact, headSha: artifact.pr.headSha, files, patches, comments, state: BASE, now: NOW }
    const card = root.querySelector('article.file#file-src_new_name_ts')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    // A card the reader scrolls to later draws its diff then, with its own gutter commands.
    card.querySelector('.diff-host')?.replaceChildren()
    hydrateFileCard(card, ctx)
    expect(session.capabilities.canComment).toBe(false)
    const plus = [...card.querySelectorAll('.plus')]
    expect(plus.length).toBeGreaterThan(0)
    expect(plus.filter(b => b.hasAttribute('disabled')).length).toBe(plus.length)
    expect(plus[0]?.getAttribute('title')).toBe('no repo scope')
    expect(root.querySelector('.capability-note')?.textContent).toContain('no repo scope')
  })
})

describe('threads', () => {
  it('opens and folds a resolved thread on the page without asking the server', async () => {
    const { root, calls } = setup()
    const row = root.querySelector('tr.thread.resolved')
    click(root, 'tr.thread.resolved [data-act="thread-show"]')
    await flush()
    expect(calls).toEqual([])
    expect(row?.querySelector('.thread-full')?.hasAttribute('hidden')).toBe(false)
    click(root, 'tr.thread.resolved [data-act="thread-collapse"]')
    await flush()
    expect(calls).toEqual([])
    expect(row?.querySelector('.thread-collapsed')?.hasAttribute('hidden')).toBe(false)
  })

  it('hides an open thread and shows it again through the server', async () => {
    const { root, calls } = setup({ comments: comments.map(c => ({ ...c, resolved: false })) })
    const row = root.querySelector('tr.thread[data-thread="1001"]')
    click(root, 'tr.thread[data-thread="1001"] [data-act="thread-hide"]')
    await flush()
    expect(calls).toEqual([['hidden', { id: 1001, hidden: true }]])
    expect(row?.querySelector('.thread-collapsed')?.hasAttribute('hidden')).toBe(false)
    expect(row?.classList.contains('hidden-thread')).toBe(true)
    click(root, 'tr.thread[data-thread="1001"] [data-act="thread-show"]')
    await flush()
    expect(calls).toEqual([
      ['hidden', { id: 1001, hidden: true }],
      ['hidden', { id: 1001, hidden: false }],
    ])
    expect(row?.querySelector('.thread-full')?.hasAttribute('hidden')).toBe(false)
  })
})

describe('line selection', () => {
  /** @param {ParentNode} root @param {string} selector @param {{ shiftKey?: boolean }} [opts] */
  function pointerDown(root, selector, opts = {}) {
    const cell = root.querySelector(selector)
    if (!(cell instanceof HTMLElement)) {
      throw new Error(`no cell for ${selector}`)
    }
    cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, shiftKey: opts.shiftKey ?? false }))
    return cell
  }

  it('selects a line, extends by dragging, and offers to comment on the range', () => {
    const { root } = setup()
    pointerDown(root, '#L-src_app_ts-new-2 td.ln:nth-child(2)')
    const over = root.querySelector('#L-src_app_ts-new-4 td.ln:nth-child(2)')
    over?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(root.querySelectorAll('tr.is-selected').length).toBe(3)
    expect(root.querySelector('tr.sel-bar .lbl')?.textContent).toBe('src/app.ts lines 2–4')
    click(root, '[data-act="comment-selection"]')
    const box = root.querySelector('.composer-box')
    expect(box?.getAttribute('data-start-line')).toBe('2')
    expect(box?.getAttribute('data-line')).toBe('4')
  })

  it('takes the side from the column that was clicked', () => {
    const { root } = setup()
    // The left column of a context row is the old file.
    pointerDown(root, '#L-src_app_ts-new-5 td.ln:nth-child(1)')
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    click(root, '[data-act="comment-selection"]')
    expect(root.querySelector('.composer-box')?.getAttribute('data-side')).toBe('old')
  })

  it('keeps the range while the pointer travels over something that is not a line', () => {
    const { root } = setup()
    pointerDown(root, '#L-src_app_ts-new-2 td.ln:nth-child(2)')
    root
      .querySelector('#L-src_app_ts-new-2 td.code')
      ?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(root.querySelectorAll('tr.is-selected').length).toBe(1)
  })

  it('leaves the page alone when Esc closes a dialog', () => {
    const { root } = setup()
    click(root, '#L-src_app_ts-new-4 .plus')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
    expect(root.querySelector('#help-dialog')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // The browser closes the dialog; the draft behind it is still there.
    expect(root.querySelector('.composer-box')).not.toBeNull()
  })

  it('clears the selection on Esc, after closing an open composer first', () => {
    const { root } = setup()
    pointerDown(root, '#L-src_app_ts-new-4 td.ln:nth-child(2)')
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    click(root, '[data-act="comment-selection"]')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelector('.composer-box')).toBeNull()
    expect(root.querySelectorAll('tr.is-selected').length).toBe(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelectorAll('tr.is-selected').length).toBe(0)
  })
})

describe('keyboard', () => {
  /** @param {string} name */
  function key(name) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  }

  it('walks the layers and files and toggles the card in focus', () => {
    const { root } = setup()
    key('j')
    expect(root.querySelector('.is-focused')?.id).toBe('layer-run-path')
    key('n')
    expect(root.querySelector('.is-focused')?.id).toBe('file-src_app_ts')
    key('o')
    expect(root.querySelector('#file-src_app_ts .file-body')?.hasAttribute('hidden')).toBe(true)
    // There is no file before the first one, so the focus stays where it is.
    key('p')
    expect(root.querySelector('.is-focused')?.id).toBe('file-src_app_ts')
    // k from a file card steps back to the layer that holds it.
    key('k')
    expect(root.querySelector('.is-focused')?.id).toBe('layer-run-path')
    key('g')
    key('o')
    expect(root.querySelector('.is-focused')?.id).toBe('overview')
  })

  it('dismisses the point in focus, not the one the last press left behind', async () => {
    const { root, calls } = setup()
    key(']')
    key('n')
    key('d')
    await flush()
    // The focus moved to a file, so there is no point to dismiss any more.
    expect(calls).toEqual([])
    expect(root.querySelector('.is-focused')?.id).toBe('file-src_app_ts')
  })

  it('moves the keyboard focus with the ring', () => {
    setup()
    key('j')
    expect(document.activeElement?.id).toBe('layer-run-path')
    key('n')
    expect(document.activeElement?.id).toBe('file-src_app_ts')
  })

  it('starts from the last point when the first key is the backward one', () => {
    const { root } = setup()
    key('[')
    expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-3')
  })

  it('does nothing for point keys when every point is dismissed', async () => {
    const { root, calls } = setup({
      state: {
        ...BASE,
        dismissed: {
          'fp-1': { at: NOW.toISOString() },
          'fp-2': { at: NOW.toISOString() },
          'fp-3': { at: NOW.toISOString() },
        },
      },
    })
    key(']')
    key('d')
    await flush()
    expect(calls).toEqual([])
    expect(root.querySelector('.is-focused')).toBeNull()
  })

  it('extends the selection with a shift-click and comments on it with c', () => {
    const { root } = setup()
    const first = root.querySelector('#L-src_app_ts-new-2 td.ln:nth-child(2)')
    first?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    const second = root.querySelector('#L-src_app_ts-new-4 td.ln:nth-child(2)')
    second?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, shiftKey: true }))
    expect(root.querySelectorAll('tr.is-selected').length).toBe(3)
    key('c')
    expect(root.querySelector('.composer-box')?.getAttribute('data-start-line')).toBe('2')
    // With nothing selected, c opens nothing.
    key('Escape')
    key('Escape')
    key('c')
    expect(root.querySelector('.composer-box')).toBeNull()
  })

  it('walks the attention points and dismisses the one in focus with d', async () => {
    const { root, calls } = setup()
    key(']')
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
    // The second point belongs to the Other layer, which has no cards: its row takes the ring.
    key(']')
    expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-2')
    key('[')
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
    key('d')
    await flush()
    expect(calls).toEqual([['dismissed', { fingerprint: 'fp-1', dismissed: true }]])
  })

  it('marks the file and the layer in focus reviewed with r and R', async () => {
    const { root, calls } = setup()
    key('n')
    key('r')
    await flush()
    key('R')
    await flush()
    expect(calls).toEqual([
      ['reviewed', { id: 'layer:run-path/file:src_app_ts', reviewed: true }],
      ['reviewed', { id: 'layer:run-path', reviewed: true }],
    ])
    expect(root.querySelector('.ptext')?.textContent).toBe('1 of 1 layers reviewed')
  })

  it('says the pane is off when a is pressed without it, and hands the keyboard to an open dialog', () => {
    const { root } = setup()
    key('a')
    expect(root.querySelector('.toast')?.textContent).toContain('the AI Chat pane is off')
    key('?')
    const dialog = root.querySelector('#help-dialog')
    expect(dialog).not.toBeNull()
    // The dialog is open, so a key of the page behind it does nothing.
    key('j')
    expect(root.querySelector('.is-focused')).toBeNull()
    if (dialog instanceof HTMLDialogElement) {
      dialog.close()
    }
    key('j')
    expect(root.querySelector('.is-focused')?.id).toBe('layer-run-path')
  })

  it('steps to the layer after the one that holds the point in focus', () => {
    const { root } = setup()
    key(']')
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
    key('j')
    expect(root.querySelector('.is-focused')?.id).toBe('layer-other')
    key(']')
    key('k')
    // The ring was on a row of the Other layer's diff, so k lands on that layer.
    expect(root.querySelector('.is-focused')?.id).toBe('layer-other')
  })

  it('steps to the points around the card in focus, in page order', () => {
    const { root } = setup({ artifact: { ...artifact, points: [...artifact.points].reverse() } })
    key(']')
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
    key('n')
    // The layer lists its points above its files, so [ from its first file goes back to them.
    key('[')
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
    key('j')
    key(']')
    expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-2')
  })

  it('goes on to the next point after dismissing one, not back to the first', async () => {
    const { root, calls } = setup()
    key(']')
    key(']')
    key('d')
    await flush()
    expect(calls).toEqual([['dismissed', { fingerprint: 'fp-2', dismissed: true }]])
    key(']')
    expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-3')
  })

  it('opens the closed Other layer to show a point in it, and n passes over its hidden files', () => {
    const { root } = setup()
    key('n')
    key('n')
    key('n')
    expect(root.querySelector('.is-focused')?.id).toBe('file-src_app_test_ts')
    key('n')
    expect(root.querySelector('.is-focused')?.id).toBe('file-src_app_test_ts')
    // The first point after the last file of the layer is in the Other layer.
    key(']')
    expect(root.querySelector('#layer-other details')?.hasAttribute('open')).toBe(true)
    expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-2')
  })

  it('opens a reviewed layer to show a point in it', () => {
    const { root } = setup({ state: { ...BASE, reviewed: { 'layer:run-path': true } } })
    expect(root.querySelector('#layer-run-path .layer-body')?.hasAttribute('hidden')).toBe(true)
    key(']')
    expect(root.querySelector('#layer-run-path .layer-body')?.hasAttribute('hidden')).toBe(false)
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
  })

  it('comments on the line of the point in focus with c, collapses its file card with o, and marks its layer with R', async () => {
    const { root, calls } = setup()
    key(']')
    key('c')
    const box = root.querySelector('.composer-box')
    expect(box?.closest('tr')?.previousElementSibling?.id).toBe('L-src_app_ts-new-4')
    key('Escape')
    // o collapses the file card of the point's line, and leaves the layer it is listed in open.
    key('o')
    expect(root.querySelector('#file-src_app_ts .file-body')?.hasAttribute('hidden')).toBe(true)
    expect(root.querySelector('#layer-run-path .layer-body')?.hasAttribute('hidden')).toBe(false)
    key('R')
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: true }]])
  })

  it('steps from the card at the top of the screen once the focused one is scrolled away', () => {
    const { root } = setup()
    root
      .querySelector('#main')
      ?.insertAdjacentHTML('afterbegin', '<div class="stale-bar outdated-bar">outdated</div>')
    /** Viewport tops by id, as if the reader had scrolled; everything else is not drawn. */
    /** @type {Record<string, number>} */
    let tops = {
      overview: -1500,
      'layer-run-path': -900,
      'file-src_app_ts': 30,
      'file-src_new_name_ts': 400,
      'file-src_app_test_ts': 600,
      'layer-other': 900,
    }
    /** @this {Element} */
    function fakeRect() {
      const bar = this.classList.contains('outdated-bar')
      const top = bar ? 0 : tops[this.id]
      return top === undefined ? new DOMRect() : new DOMRect(0, top, 100, bar ? 40 : 100)
    }
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(fakeRect)
    try {
      // Nothing has the ring yet: the file just under the outdated bar is where the reader is.
      key('n')
      const focused = root.querySelector('.is-focused')
      expect(focused?.id).toBe('file-src_new_name_ts')
      // The card scrolls to just under the bar, which would cover its heading otherwise.
      expect(focused instanceof HTMLElement ? focused.style.scrollMarginTop : '').toBe('48px')
      // The focused card is on screen, so p steps from it.
      key('p')
      expect(root.querySelector('.is-focused')?.id).toBe('file-src_app_ts')
      tops = { ...tops, 'file-src_app_ts': -700, 'file-src_new_name_ts': -400, 'file-src_app_test_ts': 20 }
      key('j')
      expect(root.querySelector('.is-focused')?.id).toBe('layer-other')
    } finally {
      rect.mockRestore()
    }
  })

  it('scrolls a card to the top of the screen under a note, which does not stick', () => {
    const { root } = setup()
    root
      .querySelector('#main')
      ?.insertAdjacentHTML(
        'afterbegin',
        carriedOverBarHtml({ canvasHeadSha: 'c'.repeat(40), currentHeadSha: 'a'.repeat(40) })
      )
    /** @type {Record<string, number>} */
    const tops = {
      overview: -1500,
      'layer-run-path': -900,
      'file-src_app_ts': 30,
      'file-src_new_name_ts': 400,
    }
    /** @this {Element} */
    function fakeRect() {
      const bar = this.classList.contains('stale-bar')
      const top = bar ? 0 : tops[this.id]
      return top === undefined ? new DOMRect() : new DOMRect(0, top, 100, bar ? 40 : 100)
    }
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(fakeRect)
    try {
      // The file 30px down is the next card: the note covers nothing, so it takes no room.
      key('n')
      const focused = root.querySelector('.is-focused')
      expect(focused?.id).toBe('file-src_app_ts')
      expect(focused instanceof HTMLElement ? focused.style.scrollMarginTop : '').toBe('8px')
    } finally {
      rect.mockRestore()
    }
  })

  it('comments on the new side of a point that names no side, and o collapses its card', () => {
    const { root } = setup()
    key(']')
    key(']')
    expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-2')
    key('c')
    expect(root.querySelector('.composer-box')?.closest('tr')?.previousElementSibling?.id).toBe(
      'L-src_app_ts-new-13'
    )
    key('Escape')
    // o collapses the Other layer's card that holds the point's row.
    key('o')
    expect(root.querySelector('#file-src_app_ts-other .file-body')?.hasAttribute('hidden')).toBe(true)
  })

  it('leaves the point alone once R moves the ring to the next layer', async () => {
    const { root, calls } = setup({ artifact: withSecondLayer() })
    key(']')
    expect(root.querySelector('.is-focused')?.id).toBe('point-p-1')
    key('R')
    await flush()
    expect(root.querySelector('.is-focused')?.id).toBe('layer-second')
    key('c')
    key('d')
    await flush()
    expect(root.querySelector('.composer-box')).toBeNull()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: true }]])
  })

  it('opens the collapsed card of a point to comment on its line with c', () => {
    const { root } = setup({ state: { ...BASE, reviewed: { 'layer:run-path/file:src_app_ts': true } } })
    expect(root.querySelector('#file-src_app_ts .file-body')?.hasAttribute('hidden')).toBe(true)
    key(']')
    key('c')
    const box = root.querySelector('.composer-box')
    expect(box?.closest('tr')?.previousElementSibling?.id).toBe('L-src_app_ts-new-4')
    expect(box?.closest('[hidden]')).toBeNull()
  })

  it('draws the diff of a point that is waiting to be seen, to comment on its line with c', () => {
    const { root } = setup({ drawn: false })
    try {
      expect(root.querySelector('#file-src_app_ts .loading')).not.toBeNull()
      key(']')
      key('c')
      expect(root.querySelector('.composer-box')?.closest('tr')?.previousElementSibling?.id).toBe(
        'L-src_app_ts-new-4'
      )
      key('Escape')
      // ] draws only the diff that holds the next point, so the other Other file still waits.
      key(']')
      expect(root.querySelector('.is-focused')?.getAttribute('data-point')).toBe('p-2')
      expect(root.querySelector('#file-src_gone_ts .loading')).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stops listening once the screen is torn down', () => {
    const { root, wiring } = setup()
    wiring.stop()
    key('j')
    expect(root.querySelector('.is-focused')).toBeNull()
  })
})

describe('capability gating and sign-off', () => {
  it('disables everything that posts when the token may not', () => {
    const { root } = setup({
      capabilities: { canComment: false, tokenKind: 'classic', login: 'octocat', reason: 'no repo scope' },
    })
    const plus = root.querySelector('.plus')
    expect(plus?.hasAttribute('disabled')).toBe(true)
    expect(plus?.getAttribute('title')).toBe('no repo scope')
    expect(root.querySelector('#request-changes')?.hasAttribute('disabled')).toBe(true)
    plus?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(root.querySelector('.composer-box')).toBeNull()
  })

  it('shows the generated body and posts the review', async () => {
    const preview = {
      headSha: artifact.pr.headSha,
      body: 'Reviewed 1 of 1 layer.',
      unreviewed: [],
      pending: 0,
    }
    const { root, calls } = setup({
      state: { ...BASE, reviewed: { 'layer:run-path': true } },
      fetchReviewBody: async () => preview,
    })
    click(root, '#approve')
    await flush()
    const dialog = root.querySelector('#signoff-dialog')
    expect(dialog?.querySelector('textarea')?.value).toBe('Reviewed 1 of 1 layer.')
    expect(dialog?.querySelector('.signoff-target')?.textContent).toContain('on commit aaaaaaa')
    click(root, '[data-act="signoff-post"]')
    await flush()
    expect(calls).toEqual([['review', { event: 'APPROVE', body: 'Reviewed 1 of 1 layer.', headSha: HEAD }]])
    expect(dialog?.querySelector('.signoff-result a')?.getAttribute('href')).toContain(
      'pullrequestreview-7001'
    )
    click(root, '[data-act="signoff-close"]')
    expect(dialog instanceof HTMLDialogElement && dialog.open).toBe(false)
  })

  it('announces the returned outcome when comments publish but approval fails', async () => {
    const warning = 'Comments published, but approval failed. Approve the merge request in GitLab.'
    const { root } = setup({
      state: { ...BASE, reviewed: { 'layer:run-path': true } },
      fetchReviewBody: async () => ({ headSha: HEAD, body: 'ship it', unreviewed: [], pending: 1 }),
      api: {
        postReview: async (_pr, input) => {
          expect(input.event).toBe('APPROVE')
          return {
            review: {
              id: 42,
              state: 'COMMENTED',
              url: 'https://gitlab.com/acme/widgets/-/merge_requests/42',
              submittedAt: null,
            },
            submitted: 1,
            comments: [],
            warnings: [warning],
            state: BASE,
          }
        },
      },
    })
    click(root, '#approve')
    await flush()
    click(root, '[data-act="signoff-post"]')
    await flush()
    expect(root.querySelector('.toast')?.textContent).toBe('review posted with 1 comment')
    expect(root.querySelector('.signoff-result')?.textContent).toContain(warning)
  })

  it('sends no body when the reader emptied the box, and says that changes were asked for', async () => {
    const { root, calls } = setup({
      fetchReviewBody: async () => ({
        headSha: artifact.pr.headSha,
        body: 'body',
        unreviewed: ['Run path'],
        pending: 0,
      }),
    })
    click(root, '#request-changes')
    await flush()
    const area = root.querySelector('#signoff-dialog textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = '   '
    click(root, '[data-act="signoff-post"]')
    await flush()
    expect(calls).toEqual([['review', { event: 'REQUEST_CHANGES', headSha: HEAD }]])
    expect(root.querySelector('.toast')?.textContent).toBe('changes requested')
  })

  it('says inside the dialog when the body could not be read', async () => {
    const { root } = setup({
      fetchReviewBody: () => Promise.reject(new Error('the canvas is for another commit')),
    })
    click(root, '#request-changes')
    await flush()
    expect(root.querySelector('#signoff-dialog .signoff-result')?.textContent).toBe(
      'the canvas is for another commit'
    )
    expect(root.querySelector('[data-act="signoff-post"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('asks for changes at any time and shows what the server said when it fails', async () => {
    const { root } = setup({
      api: { postReview: () => Promise.reject(new Error('502 github is down')) },
      fetchReviewBody: async () => ({
        headSha: artifact.pr.headSha,
        body: 'body',
        unreviewed: ['Run path'],
        pending: 0,
      }),
    })
    click(root, '#request-changes')
    await flush()
    click(root, '[data-act="signoff-post"]')
    await flush()
    expect(root.querySelector('#signoff-dialog .cmd-err')?.textContent).toBe('502 github is down')
  })
})

describe('toast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('clears the dismissal notification after five seconds', () => {
    const root = document.createElement('div')
    const box = toast(root, 'attention point dismissed')

    vi.advanceTimersByTime(4999)
    expect(box.textContent).toBe('attention point dismissed')
    vi.advanceTimersByTime(1)
    expect(box.textContent).toBe('')
  })

  it('gives a replacement notification its own five seconds', () => {
    const root = document.createElement('div')
    const box = toast(root, 'attention point dismissed')
    vi.advanceTimersByTime(3000)
    toast(root, 'attention point restored')

    vi.advanceTimersByTime(2000)
    expect(box.textContent).toBe('attention point restored')
    vi.advanceTimersByTime(3000)
    expect(box.textContent).toBe('')
  })

  it('reuses one live region', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const root = document.querySelector('#root')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    expect(toast(root, 'one').getAttribute('aria-live')).toBe('polite')
    expect(toast(root, 'two').textContent).toBe('two')
    expect(root.querySelectorAll('.toast').length).toBe(1)
  })
})

describe('a page that lost the elements a command expects', () => {
  /**
   * The same wiring over a bare page: every handler must give up quietly instead of throwing.
   * @param {string} html
   */
  function bare(html) {
    setRenderContext({
      artifact,
      headSha: artifact.pr.headSha,
      files,
      patches,
      comments,
      state: BASE,
      now: NOW,
    })
    document.body.innerHTML = `<div id="root">${html}</div>`
    const root = document.querySelector('#root')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    /** @type {Array<[string, unknown]>} */
    const calls = []
    const session = createReviewSession({
      prNumber: 42,
      artifact,
      files,
      state: BASE,
      capabilities: { canComment: true, tokenKind: 'classic', login: 'octocat' },
      headSha: artifact.pr.headSha,
      api: {
        putReviewed: async (_pr, id, reviewed) => {
          calls.push(['reviewed', { id, reviewed }])
          return { prNumber: 42, state: BASE }
        },
        putDismissed: async () => {
          calls.push(['dismissed', {}])
          return { prNumber: 42, state: BASE }
        },
        putThreadHidden: async () => {
          calls.push(['hidden', {}])
          return { prNumber: 42, state: BASE }
        },
        postComment: async () => {
          calls.push(['comment', {}])
          return { kind: 'issue', comment: postedIssueComment(), state: BASE }
        },
        postReview: async () => {
          calls.push(['review', {}])
          return {
            review: { id: 1, state: 'APPROVED', url: 'https://github.com/x', submittedAt: null },
            comments: [],
            warnings: [],
            submitted: 0,
            state: BASE,
          }
        },
      },
    })
    const wiring = wireReview(root, session)
    wirings.push(wiring)
    return { root, calls, wiring, session }
  }

  it('marks a layer reviewed even when its card is gone from the page', async () => {
    const { root, calls } = bare(
      '<button data-act="mark-layer" data-reviewed-id="layer:run-path">mark</button>'
    )
    click(root, '[data-act="mark-layer"]')
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: true }]])
  })

  it('does nothing for commands whose target is missing', async () => {
    const { root, calls } = bare(
      '<button data-act="point-post" data-point="nope">post</button>' +
        '<button data-act="point-dismiss">dismiss</button>' +
        '<button data-act="point-restore">restore</button>' +
        '<button data-act="mark-layer">mark</button>' +
        '<button data-act="comment-line" data-key="src_app_ts" data-side="new" data-line="4">+</button>' +
        '<button data-act="show-dismissed">show</button>' +
        '<button data-act="comment-line" data-key="nope" data-line="0">+</button>' +
        '<button data-act="comment-selection">comment</button>' +
        '<button data-act="composer-post">post</button>' +
        '<button data-act="composer-cancel">cancel</button>' +
        '<button data-act="thread-reply" data-thread="nan">reply</button>' +
        '<button data-act="signoff-post">post review</button>' +
        '<button data-act="signoff-close">close</button>' +
        '<button data-act="pr-comment">comment</button>' +
        '<button data-act="nothing">x</button>' +
        '<button disabled data-act="mark-layer" data-reviewed-id="layer:run-path">off</button>'
    )
    for (const el of Array.from(root.querySelectorAll('button'))) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    await flush()
    // Dismiss, restore, and the layer with no id reach the server; the rest find no target.
    expect(calls).toEqual([
      ['dismissed', {}],
      ['dismissed', {}],
      ['reviewed', { id: '', reviewed: true }],
    ])
    expect(root.querySelector('.composer-box')).toBeNull()
  })

  it('ignores keys when there is nothing to act on', async () => {
    const { root, calls } = bare('<p>nothing here</p>')
    for (const k of ['j', 'n', ']', '[', 'o', 'r', 'R', 'c', 'd', 'z']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    }
    await flush()
    expect(calls).toEqual([])
    expect(root.querySelector('.is-focused')).toBeNull()
  })

  it('still records a hide whose row is gone, and posts a point that names no side', async () => {
    const { root, calls } = bare(
      '<button data-act="thread-hide" data-thread="1001">hide</button>' +
        '<button data-act="thread-show" data-thread="1001">show</button>' +
        '<button data-act="point-post" data-point="p-2">post</button>'
    )
    for (const el of Array.from(root.querySelectorAll('button'))) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    await flush()
    // Hiding is local state, so it is recorded even with no row to fold; showing needs the row.
    expect(calls).toEqual([
      ['hidden', {}],
      ['comment', {}],
    ])
  })

  it('marks a reviewed checkbox that stands outside a label, and ignores other controls', async () => {
    const { root, calls } = bare(
      '<input type="checkbox" id="a" data-reviewed-id="layer:run-path" checked><input type="checkbox" id="c"><select id="b"></select>'
    )
    for (const el of Array.from(root.querySelectorAll('input, select'))) {
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await flush()
    expect(calls).toEqual([['reviewed', { id: 'layer:run-path', reviewed: true }]])
  })

  it('ignores a click that lands on no command', () => {
    const { root } = bare('<p>text</p>')
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const text = root.querySelector('p')
    text?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(root.querySelector('.toast')).toBeNull()
  })

  it('ignores a pointer press that is not on a line number', () => {
    const { root } = bare(
      '<table class="diff" data-key="src_app_ts"><tbody><tr><td class="code">x</td></tr></tbody></table>'
    )
    const cell = root.querySelector('td.code')
    cell?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    cell?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(root.querySelectorAll('tr.is-selected').length).toBe(0)
  })
})

describe('the AI Chat commands', () => {
  /** A stand-in for the pane: it records what the page asked it to do. */
  function fakeChat() {
    /** @type {Array<[string, unknown]>} */
    const calls = []
    return {
      calls,
      handle: {
        /** @param {unknown} context */
        ask: context => calls.push(['ask', context]),
        focusInput: () => calls.push(['focus', null]),
      },
    }
  }

  it('the ask command on a file card sets the chat context to that file', () => {
    setChatEnabled(true)
    const chat = fakeChat()
    const { root } = setup({ chat: () => /** @type {never} */ (chat.handle) })
    const ask = root.querySelector('article.file [data-act="ask"]')
    if (!(ask instanceof HTMLElement)) {
      throw new Error('no ask command on the file card')
    }
    ask.click()
    expect(chat.calls).toEqual([['ask', { kind: 'file', path: 'src/app.ts' }]])
    setChatEnabled(false)
  })

  it('the ask command on a layer card names the layer', () => {
    setChatEnabled(true)
    const chat = fakeChat()
    const { root } = setup({ chat: () => /** @type {never} */ (chat.handle) })
    const ask = root.querySelector('.layer-ctl [data-act="ask"]')
    if (!(ask instanceof HTMLElement)) {
      throw new Error('no ask command on the layer card')
    }
    ask.click()
    expect(chat.calls).toEqual([['ask', { kind: 'layer', layerId: 'run-path' }]])
    setChatEnabled(false)
  })

  it('the a key asks about the selection, and / puts the cursor in the box', () => {
    setChatEnabled(true)
    const chat = fakeChat()
    const { root } = setup({ chat: () => /** @type {never} */ (chat.handle) })
    const cell = root.querySelector('#L-src_app_ts-new-2 td.ln:nth-child(2)')
    if (!(cell instanceof HTMLElement)) {
      throw new Error('no diff line')
    }
    cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(chat.calls[0]?.[0]).toBe('ask')
    expect(chat.calls[0]?.[1]).toMatchObject({ kind: 'lines', path: 'src/app.ts' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))
    expect(chat.calls[1]).toEqual(['focus', null])
    setChatEnabled(false)
  })

  it('the a key says the pane is off when there is no chat', () => {
    const { root } = setup()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(root.querySelector('.toast')?.textContent).toContain('the AI Chat pane is off')
  })

  it('the settings command opens the dialog through the page', () => {
    /** @type {string[]} */
    const opened = []
    const { root } = setup({ openSettings: el => opened.push(el.textContent ?? '') })
    const settings = root.querySelector('#settings')
    if (!(settings instanceof HTMLElement)) {
      throw new Error('no settings command')
    }
    settings.click()
    expect(opened).toEqual(['settings'])
  })

  it('posts a proposed comment at the line it names', async () => {
    const { root, wiring, calls } = setup()
    const card = document.createElement('div')
    card.className = 'proposed'
    card.innerHTML = '<span class="tbtns"><button id="post">post to github</button></span>'
    root.appendChild(card)
    const button = card.querySelector('#post')
    if (!(button instanceof HTMLElement)) {
      throw new Error('no button')
    }
    wiring.onProposedComment(
      'post',
      { path: 'src/app.ts', line: 3, startLine: 2, side: 'new', body: 'Rename.' },
      button
    )
    await flush()
    expect(calls).toEqual([
      [
        'comment',
        {
          kind: 'inline',
          path: 'src/app.ts',
          line: 3,
          startLine: 2,
          side: 'new',
          body: 'Rename.',
          headSha: HEAD,
        },
      ],
    ])
    expect(card.querySelector('.tbtns a')?.textContent).toBe('view comment')
    expect(card.querySelector('.tbtns a')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42#discussion_r5001'
    )
    expect(card.querySelector('#post')).toBeNull()
  })

  it('opens the composer prefilled when the reader edits a proposed comment', () => {
    const { root, wiring } = setup()
    const button = document.createElement('button')
    root.appendChild(button)
    wiring.onProposedComment(
      'edit',
      { path: 'src/app.ts', line: 3, startLine: 2, side: 'new', body: 'Rename.' },
      button
    )
    const box = root.querySelector('.composer-box textarea')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no composer')
    }
    expect(box.value).toBe('Rename.')
    expect(root.querySelector('.composer-box')?.getAttribute('data-start-line')).toBe('2')
  })

  it('says why it cannot edit a comment whose file or line is not on screen', () => {
    const { root, wiring } = setup()
    const button = document.createElement('button')
    root.appendChild(button)
    wiring.onProposedComment('edit', { path: 'nope.ts', line: 3, side: 'new', body: 'x' }, button)
    expect(button.nextElementSibling?.textContent).toContain('not a file of this pull request')
    wiring.onProposedComment('edit', { path: 'src/app.ts', line: 900, side: 'new', body: 'x' }, button)
    expect(button.nextElementSibling?.textContent).toContain('not on screen')
  })
})

describe('askTargetFor', () => {
  it('prefers the selection, then the point, then the card, then the whole pull request', () => {
    setChatEnabled(true)
    const { root } = setup()
    const selection = /** @type {import('./selection.js').Selection} */ ({
      key: 'src_app_ts',
      path: 'src/app.ts',
      side: 'new',
      start: 2,
      end: 4,
      dragging: false,
    })
    const layer = root.querySelector('#layer-run-path')
    expect(askTargetFor(layer, selection)).toEqual({
      kind: 'lines',
      path: 'src/app.ts',
      side: 'new',
      start: 2,
      end: 4,
    })
    const point = artifact.points[0]
    if (point === undefined) {
      throw new Error('fixture changed')
    }
    expect(askTargetFor(root.querySelector(`[data-point="${point.id}"]`), null)).toEqual({
      kind: 'point',
      fingerprint: point.fingerprint,
    })
    expect(askTargetFor(layer, null)).toEqual({ kind: 'layer', layerId: 'run-path' })
    expect(askTargetFor(null, null)).toEqual({ kind: 'pr' })
    expect(askTargetFor(root.querySelector('#overview'), null)).toEqual({ kind: 'pr' })
    setChatEnabled(false)
  })
})

describe('posting a proposed comment on one line', () => {
  it('sends no range when the comment names a single line', async () => {
    const { root, wiring, calls } = setup()
    const button = document.createElement('button')
    root.appendChild(button)
    wiring.onProposedComment('post', { path: 'src/app.ts', line: 3, side: 'new', body: 'One line.' }, button)
    await flush()
    expect(calls).toEqual([
      [
        'comment',
        { kind: 'inline', path: 'src/app.ts', line: 3, side: 'new', body: 'One line.', headSha: HEAD },
      ],
    ])
  })
})

describe('moved code', () => {
  // One block of three lines deleted near the top and added again further down.
  const MOVE_PATCH = [
    '@@ -1,4 +1,1 @@',
    '-one()',
    '-two()',
    '-three()',
    ' keep',
    '@@ -20,1 +17,4 @@',
    ' keep2',
    '+one()',
    '+two()',
    '+three()',
  ].join('\n')

  /** Puts a rendered move diff on a wired review screen. */
  function setupMove() {
    const { root } = setup()
    const host = document.createElement('div')
    host.innerHTML = renderDiff({ key: 'moved_ts', path: 'moved.ts' }, MOVE_PATCH)
    root.appendChild(host)
    // What hydrateFileCard does for a real card: a fold opens when an anchor lands inside it.
    wireFoldReveal(host)
    return root
  }

  it('starts both ends folded and opens one when its summary is clicked', () => {
    const root = setupMove()
    const rows = root.querySelectorAll('tr.move-from, tr.move-to')
    expect(rows.length).toBe(6)
    expect([...rows].every(r => !r.classList.contains('shown'))).toBe(true)

    const summary = root.querySelector('tr.more.fold.move')
    const toggle = summary?.querySelector('button[data-act="show-fold"]')
    if (!(toggle instanceof HTMLElement)) {
      throw new Error('no fold toggle')
    }
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect([...root.querySelectorAll('tr.move-from')].every(r => r.classList.contains('shown'))).toBe(true)
    expect(toggle.textContent).toBe('hide')
    // The other end keeps its own fold.
    expect([...root.querySelectorAll('tr.move-to')].every(r => r.classList.contains('shown'))).toBe(false)

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect([...root.querySelectorAll('tr.move-from')].some(r => r.classList.contains('shown'))).toBe(false)
  })

  it('jumps to the other end of a move and opens the fold it landed in', () => {
    const root = setupMove()
    click(root, 'tr.more.fold.move button[data-act="jump-line"]')

    const landed = root.querySelector('#L-moved_ts-new-18')
    expect(landed?.classList.contains('is-target')).toBe(true)
    expect([...root.querySelectorAll('tr.move-to')].every(r => r.classList.contains('shown'))).toBe(true)
  })
})

describe('the pending review', () => {
  /**
   * Opens the composer on `src/app.ts:4` and writes `body` in it.
   * @param {HTMLElement} root
   * @param {string} body
   */
  function write(root, body) {
    click(root, '#L-src_app_ts-new-4 .plus')
    const area = root.querySelector('tr.composer textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = body
    return area
  }

  it('keeps a new composer and existing threads when an earlier add finishes', async () => {
    const release = Promise.withResolvers()
    const { root, session } = setup({
      api: {
        addPending: async (_pr, input) => {
          await release.promise
          return {
            prNumber: 42,
            state: {
              ...BASE,
              pending: [
                {
                  ...input,
                  headSha: HEAD,
                  id: 'held',
                  createdAt: NOW.toISOString(),
                  updatedAt: NOW.toISOString(),
                },
              ],
            },
          }
        },
      },
    })
    const thread = root.querySelector('tr.thread')
    const point = root.querySelector('tr.ifind')
    write(root, 'first comment')
    click(root, 'tr.composer [data-act="composer-queue"]')
    const next = write(root, 'unsaved second comment')
    release.resolve(undefined)
    await flush()
    expect(session.pending).toHaveLength(1)
    expect(next.isConnected).toBe(true)
    expect(next.value).toBe('unsaved second comment')
    expect(root.querySelector('tr.composer [data-act="composer-post"]')).toBeNull()
    expect(root.querySelector('tr.composer [data-act="composer-queue"]')?.textContent).toBe(
      'add review comment'
    )
    expect(root.querySelector('tr.thread')).toBe(thread)
    expect(root.querySelector('tr.ifind')).toBe(point)
    expect(root.querySelectorAll('tr.pending-row')).toHaveLength(1)
    expect(root.querySelector('tr.pending-row')?.closest('article')?.getAttribute('data-layer')).toBe(
      'run-path'
    )
  })

  it('draws a queued comment when the last concurrent state operation settles', async () => {
    const release = Promise.withResolvers()
    const { root, session } = setup({
      api: {
        putDismissed: async () => {
          await release.promise
          throw new Error('dismiss refused')
        },
      },
    })
    const dismissal = session.setDismissed('fp-1', true).catch(() => undefined)
    write(root, 'queued while dismissing')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    expect(root.querySelector('tr.pending-row')).toBeNull()
    release.resolve(undefined)
    await dismissal
    expect(root.querySelector('tr.pending-row .prose')?.textContent).toContain('queued while dismissing')
  })

  it('keeps an AI-edited inline comment inside the open review', async () => {
    const { root, wiring } = setup()
    write(root, 'first comment')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    const button = document.createElement('button')
    root.append(button)
    wiring.onProposedComment(
      'edit',
      { path: 'src/app.ts', line: 3, side: 'new', body: 'AI suggestion' },
      button
    )
    expect(root.querySelector('.composer-box')?.querySelector('textarea')?.value).toBe('AI suggestion')
    expect(root.querySelector('.composer-box [data-act="composer-post"]')).toBeNull()
    expect(root.querySelector('.composer-box [data-act="composer-queue"]')?.textContent).toBe(
      'add review comment'
    )
  })

  it('shows the submitted point as a posted thread and link without reloading', async () => {
    const { root, session } = setup()
    click(root, '[data-point="p-1"] [data-act="point-queue"]')
    await flush()
    const body = session.pending[0]?.body
    const answer = await session.postReview('COMMENT', 'a look')
    const posted = answer.comments[0]
    expect(posted?.body).toBe(body)
    expect(root.querySelector(`tr.thread[data-thread="${posted?.id}"] .prose`)?.textContent).toContain(
      'Sum instead of product'
    )
    const point = root.querySelector('li[data-point="p-1"]')
    expect(point?.querySelector('[data-act="point-queue"]')).toBeNull()
    expect(point?.querySelector('.tbtns a')?.getAttribute('href')).toBe(posted?.url)
  })

  it('starts a review instead of posting, and says so on the page', async () => {
    const { root, calls, session } = setup()
    write(root, 'needs a guard')
    // Nothing is open yet, so the first command offers to start one.
    expect(root.querySelector('tr.composer [data-act="composer-queue"]')?.textContent).toBe('start a review')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()

    expect(calls).toEqual([
      ['pending-add', { path: 'src/app.ts', line: 4, side: 'new', body: 'needs a guard', headSha: HEAD }],
    ])
    expect(session.pending).toHaveLength(1)
    // The draft is on the diff, marked as not posted.
    const draft = root.querySelector('tr.pending-row .pending-cmt')
    expect(draft?.querySelector('.prose')?.textContent).toContain('needs a guard')
    expect(draft?.querySelector('.pill.pending')?.textContent).toBe('pending')
    // And the bar says a review is open, which is what a reader far down the page sees.
    expect(root.querySelector('.pending-bar')?.textContent).toContain('1 pending comment')
    expect(root.querySelector('tr.composer')).toBeNull()
    expect(root.querySelector('.toast')?.textContent).toBe('comment added to your review')
  })

  it('offers only the review once one is open', async () => {
    const { root } = setup()
    write(root, 'one')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    click(root, '#L-src_app_ts-new-5 .plus')
    expect(root.querySelector('tr.composer [data-act="composer-queue"]')?.textContent).toBe(
      'add review comment'
    )
    // Posting one comment on its own is not offered while a review is waiting, so a comment
    // cannot jump the queue and publish ahead of the rest.
    expect(root.querySelector('tr.composer [data-act="composer-post"]')).toBeNull()
  })

  it('keeps the whole range of a comment on several lines', async () => {
    const { root, calls } = setup()
    root
      .querySelector('#L-src_app_ts-new-2 td.ln:nth-child(2)')
      ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    root
      .querySelector('#L-src_app_ts-new-4 td.ln:nth-child(2)')
      ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, shiftKey: true }))
    expect(root.querySelectorAll('tr.is-selected').length).toBe(3)
    click(root, 'tr.sel-bar [data-act="comment-selection"]')
    const area = root.querySelector('tr.composer textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    area.value = 'this whole block'
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    // The draft keeps both ends of the selection, which is what makes it a multi-line comment.
    expect(calls).toEqual([
      [
        'pending-add',
        {
          path: 'src/app.ts',
          line: 4,
          side: 'new',
          startLine: 2,
          body: 'this whole block',
          headSha: HEAD,
        },
      ],
    ])
  })

  it('edits a draft in place', async () => {
    const { root, calls, session } = setup()
    write(root, 'one')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    calls.length = 0

    click(root, '[data-act="pending-edit"]')
    const area = root.querySelector('.pending-cmt textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    expect(area.value).toBe('one')
    // A draft is already in the review, so saving is the only command it needs.
    expect(
      [...root.querySelectorAll('.pending-cmt .composer-actions button')].map(b => b.getAttribute('data-act'))
    ).toEqual(['pending-save', 'composer-cancel'])
    area.value = 'one, revised'
    click(root, '[data-act="pending-save"]')
    await flush()
    expect(calls).toEqual([['pending-edit', { id: 'p1', body: 'one, revised' }]])
    expect(session.pending[0]?.body).toBe('one, revised')
    expect(root.querySelector('.pending-cmt .prose')?.textContent).toContain('one, revised')
  })

  /**
   * The draft in the layer, which is the copy the tests below edit. The same file is drawn again
   * under Other changes, so a draft has more than one row on the page.
   * @param {HTMLElement} root
   */
  function draftHost(root) {
    const host = root.querySelector('tr.pending-row:not(.is-approx) .pending-cmt')
    if (!(host instanceof HTMLElement)) {
      throw new Error('no draft')
    }
    return host
  }

  /**
   * The commands on that draft, as the reader sees them: hidden ones do not count.
   * @param {HTMLElement} root
   */
  function draftCommands(root) {
    const btns = draftHost(root).querySelectorAll(':scope > .tbtns:not([hidden]) button')
    return [...btns].map(b => b.getAttribute('data-act'))
  }

  /**
   * Queues one draft and opens the editor on it.
   * @param {HTMLElement} root
   */
  async function editDraft(root) {
    write(root, 'one')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    const host = draftHost(root)
    const edit = host.querySelector('[data-act="pending-edit"]')
    if (!(edit instanceof HTMLElement)) {
      throw new Error('no edit command')
    }
    edit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // While the box is open the draft itself is out of the way, so only one of the two shows.
    expect(host.querySelector('.composer-box')).not.toBeNull()
    expect(draftCommands(root)).toEqual([])
    expect(host.querySelector(':scope > .prose')?.hasAttribute('hidden')).toBe(true)
    return host
  }

  it('brings a draft back when its edit is cancelled', async () => {
    const { root, session } = setup()
    const host = await editDraft(root)

    click(root, '.pending-cmt [data-act="composer-cancel"]')

    // Cancelling leaves the draft exactly as it was, commands and all. Before, the box was taken
    // away without putting back what it stood in front of, so edit and delete stayed hidden until
    // something else redrew the row.
    expect(host.querySelector('.composer-box')).toBeNull()
    expect(host.querySelector(':scope > .prose')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector(':scope > .prose')?.textContent).toContain('one')
    expect(draftCommands(root)).toEqual(['pending-edit', 'pending-delete'])
    expect(session.pending[0]?.body).toBe('one')
  })

  it('brings a draft back when Escape closes its edit', async () => {
    const { root } = setup()
    const host = await editDraft(root)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(host.querySelector('.composer-box')).toBeNull()
    expect(draftCommands(root)).toEqual(['pending-edit', 'pending-delete'])
  })

  it('brings a draft back when another composer takes the open box', async () => {
    const { root } = setup()
    const host = await editDraft(root)

    // Opening a box elsewhere closes the edit, which must leave the draft readable too.
    click(root, '#L-src_app_ts-new-5 .plus')

    expect(host.querySelector('.composer-box')).toBeNull()
    expect(root.querySelector('tr.composer')).not.toBeNull()
    expect(draftCommands(root)).toEqual(['pending-edit', 'pending-delete'])
  })

  it('can be edited again straight after a cancelled edit', async () => {
    const { root, calls, session } = setup()
    const host = await editDraft(root)
    click(root, '.pending-cmt [data-act="composer-cancel"]')
    calls.length = 0

    // The whole point of the commands coming back: the second edit is reachable, and works like
    // the first.
    expect(draftCommands(root)).toEqual(['pending-edit', 'pending-delete'])
    const edit = host.querySelector('[data-act="pending-edit"]')
    if (!(edit instanceof HTMLElement)) {
      throw new Error('no edit command')
    }
    edit.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const area = host.querySelector('textarea')
    if (!(area instanceof HTMLTextAreaElement)) {
      throw new Error('no textarea')
    }
    expect(area.value).toBe('one')
    area.value = 'one, revised'
    click(root, '[data-act="pending-save"]')
    await flush()

    expect(calls).toEqual([['pending-edit', { id: 'p1', body: 'one, revised' }]])
    expect(session.pending[0]?.body).toBe('one, revised')
    expect(draftCommands(root)).toEqual(['pending-edit', 'pending-delete'])
  })

  it('deletes one draft and takes the bar away with the last of them', async () => {
    const { root, calls, session } = setup()
    write(root, 'one')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    click(root, '[data-act="pending-delete"]')
    await flush()
    expect(calls.at(-1)).toEqual(['pending-delete', { id: 'p1' }])
    expect(session.pending).toEqual([])
    expect(root.querySelector('tr.pending-row')).toBeNull()
    expect(root.querySelector('.pending-bar')).toBeNull()
    expect(root.querySelector('.toast')?.textContent).toBe('draft deleted')
  })

  it('discards the whole review from the bar', async () => {
    const { root, session } = setup()
    write(root, 'one')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    click(root, '.pending-bar [data-act="pending-discard"]')
    await flush()
    expect(session.pending).toEqual([])
    expect(root.querySelector('.pending-bar')).toBeNull()
    expect(root.querySelector('.toast')?.textContent).toBe('1 pending comment discarded')
  })

  it('submits the drafts with the review and clears them from the page', async () => {
    const { root, calls, session } = setup({
      fetchReviewBody: async () => ({
        headSha: artifact.pr.headSha,
        body: 'a look',
        unreviewed: [],
        pending: 1,
      }),
    })
    write(root, 'needs a guard')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()

    click(root, '.pending-bar [data-act="pending-finish"]')
    await flush()
    const dialog = root.querySelector('#signoff-dialog')
    // Finishing a review opens on the verdict that claims nothing, the way a thread-level
    // review does, and says what will go out with it.
    expect(dialog?.getAttribute('data-event')).toBe('COMMENT')
    expect(dialog?.querySelector('.signoff-pending')?.textContent).toContain(
      '1 pending comment will be posted'
    )
    expect(dialog?.querySelector('[data-act="signoff-post"]')?.textContent).toBe(
      'post review · 1 pending comment'
    )

    click(root, '[data-act="signoff-post"]')
    await flush()
    expect(calls.at(-1)).toEqual(['review', { event: 'COMMENT', body: 'a look', headSha: HEAD }])
    expect(session.pending).toEqual([])
    expect(root.querySelector('tr.pending-row')).toBeNull()
    expect(root.querySelector('.pending-bar')).toBeNull()
    expect(root.querySelector('.toast')?.textContent).toBe('review posted with 1 comment')
  })

  it('keeps the draft on the page when the server refuses to take it', async () => {
    const { root, session } = setup({
      api: { addPending: () => Promise.reject(new Error('422 line not in diff')) },
    })
    write(root, 'needs a guard')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    expect(session.pending).toEqual([])
    // The box stays with what was typed in it, so nothing the reviewer wrote is lost.
    const kept = root.querySelector('tr.composer textarea')
    expect(kept instanceof HTMLTextAreaElement && kept.value).toBe('needs a guard')
    expect(root.querySelector('.cmd-err')?.textContent).toBe('422 line not in diff')
  })

  it('refuses to add an empty draft', async () => {
    const { root, calls } = setup()
    click(root, '#L-src_app_ts-new-4 .plus')
    click(root, 'tr.composer [data-act="composer-queue"]')
    await flush()
    expect(calls).toEqual([])
    expect(root.querySelector('.cmd-err')?.textContent).toBe('write something first')
  })

  it('adds an attention point to the review instead of posting it', async () => {
    const { root, calls, session } = setup()
    const card = root.querySelector('.findings li.finding[data-fingerprint="fp-1"]')
    click(root, '.findings li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]')
    await flush()

    expect(calls).toHaveLength(1)
    const [name, input] = calls[0] ?? []
    expect(name).toBe('pending-add')
    expect(input).toMatchObject({ path: 'src/app.ts', line: 4, side: 'new', pointFingerprint: 'fp-1' })
    // The point's own text is what waits, so the review reads the same as posting it would.
    expect(String(/** @type {{ body: string }} */ (input).body)).toContain('Sum instead of product')
    expect(session.pending).toHaveLength(1)
    expect(root.querySelector('.toast')?.textContent).toBe('attention point added to your review')

    // The point says it is waiting, everywhere it is drawn, and offers neither way out again.
    expect(card?.querySelector('.pill.pending')?.textContent).toBe('in your review')
    expect(root.querySelectorAll('[data-fingerprint="fp-1"] .pill.pending.queued').length).toBe(2)
    expect(root.querySelector('[data-act="point-queue"][data-point="p-1"]')).toBeNull()
    expect(root.querySelector('[data-act="point-post"][data-point="p-1"]')).toBeNull()
  })

  it('gives a point its commands back when its draft is deleted', async () => {
    const { root } = setup()
    click(root, '.findings li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]')
    await flush()
    click(root, 'tr.pending-row [data-act="pending-delete"]')
    await flush()
    const card = root.querySelector('.findings li.finding[data-fingerprint="fp-1"]')
    expect(card?.querySelector('.pill.pending')).toBeNull()
    expect(card?.querySelector('[data-act="point-post"]')).not.toBeNull()
    expect(card?.querySelector('[data-act="point-queue"]')).not.toBeNull()
  })

  it('still posts a point on its own while a review is open', async () => {
    const { root, calls } = setup()
    click(root, '.findings li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]')
    await flush()
    // A point's text is written in advance, so posting one is its own use, not a queue jump.
    click(root, 'tr.ifind[data-fingerprint="fp-3"] [data-act="point-post"]')
    await flush()
    expect(calls.map(c => c[0])).toEqual(['pending-add', 'comment'])
  })

  it('draws the drafts of a state the page opened with', () => {
    const { root } = setup({
      state: {
        ...BASE,
        pending: [
          {
            id: 'p9',
            path: 'src/app.ts',
            line: 4,
            side: 'new',
            body: 'written before the reload',
            headSha: HEAD,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        ],
      },
    })
    expect(root.querySelector('tr.pending-row .prose')?.textContent).toContain('written before the reload')
    expect(root.querySelector('.pending-bar')?.textContent).toContain('1 pending comment')
  })
})
