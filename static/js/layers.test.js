// @ts-check
// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyState } from '../../src/contract/state.js'
import { toPatchMap } from '../../src/git/diff-collector.js'
import { createGit } from '../../src/git/git.js'
import { mapReviewComment } from '../../src/github/comments.js'
import { PACKAGE_ROOT } from '../../src/server/context.js'
import { GH_REVIEW_COMMENTS, SYNTHETIC_FILES, syntheticArtifact } from '../../src/testing/synthetic.js'
import { setChatEnabled } from './ask.js'
import {
  applyDecorations,
  commentHtml,
  insertNoteRow,
  insertPointRow,
  insertThreadRow,
  threadRowHtml,
} from './diff-decorations.js'
import {
  DEFERRED_DIFF_LINES,
  defineLayerElements,
  dotColor,
  elsewhereHtml,
  fileCount,
  getRenderContext,
  hunkIdForPoint,
  hunkLayerIndex,
  hydrateAll,
  hydrateFileCard,
  layerDiagramHtml,
  PrFileElement,
  patchLineCount,
  pathSet,
  renderFileCard,
  renderLayerSection,
  renderLayers,
  renderRail,
  setCardRenderedHook,
  setRenderContext,
  testMapHtml,
  threadsForHunks,
} from './layers.js'
import { progressSummary } from './progress.js'
import { buildThreads } from './threads.js'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const artifact = syntheticArtifact()
const files = artifact.files
const patches = toPatchMap(SYNTHETIC_FILES)
const comments = GH_REVIEW_COMMENTS.map(c => mapReviewComment(c, new Set([1001, 1002])))
const state = emptyState(NOW.toISOString())

/** @returns {import('./layers.js').RenderContext} */
function ctx() {
  return { artifact, files, patches, comments, state, now: NOW }
}

describe('rail', () => {
  it('lists overview, layers with dots, and Other muted', () => {
    document.body.innerHTML = renderRail(artifact, state)
    const items = [...document.querySelectorAll('.tree a')]
    expect(items.map(a => a.getAttribute('href'))).toEqual(['#overview', '#layer-run-path', '#layer-other'])
    expect(items[0]?.getAttribute('aria-current')).toBe('location')
    expect(items[0]?.querySelector('.m')?.textContent).toBe('3 attention points')
    expect(items[1]?.querySelector('.dot')?.getAttribute('aria-label')).toBe('not started')
    expect(items[1]?.querySelector('.dot')?.getAttribute('style')).toBe('--dc:var(--s1)')
    expect(items[1]?.querySelector('.m')?.textContent).toBe('3 files · schema')
    expect(document.querySelector('li.other .m')?.textContent).toBe('3 files, ignored')
    expect(dotColor(7)).toBe('var(--s2)')
  })

  it('shows partial and done dots and the active item', () => {
    const partial = { ...state, reviewed: { 'layer:run-path/file:src_app_ts': /** @type {const} */ (true) } }
    document.body.innerHTML = renderRail(artifact, partial, { activeId: 'layer-run-path' })
    const a = document.querySelector('a[href="#layer-run-path"]')
    expect(a?.getAttribute('aria-current')).toBe('location')
    expect(a?.querySelector('.dot')?.className).toBe('dot half')
    expect(a?.querySelector('.m')?.textContent).toBe('1 of 3 files · schema')
    const done = { ...state, reviewed: { 'layer:run-path': /** @type {const} */ (true) } }
    document.body.innerHTML = renderRail(artifact, done)
    expect(document.querySelector('a[href="#layer-run-path"] .dot')?.className).toBe('dot on')
    document.body.innerHTML = renderRail(
      {
        ...artifact,
        layers: artifact.layers.filter(l => l.kind !== 'other'),
        points: artifact.points.slice(0, 1),
      },
      state
    )
    expect(document.querySelector('li.other')).toBeNull()
    expect(document.querySelector('a[href="#overview"] .m')?.textContent).toBe('1 attention point')
  })
})

describe('layer sections', () => {
  const paths = pathSet(files)

  it('renders the test map with links for covered tests', () => {
    const layer = artifact.layers[0]
    if (!layer) {
      throw new Error('no layer')
    }
    document.body.innerHTML = testMapHtml(layer, paths)
    const rows = [...document.querySelectorAll('tbody tr')]
    expect(rows.map(r => r.querySelector('.st')?.textContent)).toEqual(['covered', 'missing', 'not-needed'])
    expect(rows[0]?.querySelector('a.loc')?.getAttribute('href')).toBe('#file:src/app.test.ts')
    expect(rows[1]?.querySelector('.muted.small')?.textContent?.trim()).toBe('y is unused')
    expect(testMapHtml({ ...layer, tests: [] }, paths)).toBe('')
  })

  it('renders a file card that was already reviewed as checked and folded away', () => {
    const reviewed = {
      ...state,
      reviewed: { 'layer:run-path/file:src_app_ts': /** @type {const} */ (true) },
    }
    document.body.innerHTML = renderLayers(artifact, files, reviewed)
    const card = document.querySelector('article.file#file-src_app_ts')
    expect(card?.classList.contains('is-reviewed')).toBe(true)
    expect(card?.querySelector('.file-body')?.hasAttribute('hidden')).toBe(true)
    expect(card?.querySelector('.chev')?.getAttribute('aria-expanded')).toBe('false')
    const box = card?.querySelector('input[data-reviewed-id]')
    expect(box?.hasAttribute('checked')).toBe(true)
    expect(box?.getAttribute('data-reviewed-id')).toBe('layer:run-path/file:src_app_ts')
  })

  it('renders a semantic layer with header bar, controls outside any toggle, rationale, cards, and the reviewed command', () => {
    document.body.innerHTML = renderLayers(artifact, files, state)
    const section = document.querySelector('section.layer#layer-run-path')
    expect(section?.querySelector('.layer-h h2 .lbl')?.textContent).toBe('Layer 1 of 1')
    expect(section?.querySelector('.layer-h .risks .pill')?.textContent).toBe('schema')
    expect(section?.querySelector('.layer-h summary')).toBeNull()
    const layerChevron = section?.querySelector('.layer-h > .chev')
    expect(layerChevron?.textContent).toBe('>')
    expect(layerChevron?.getAttribute('aria-expanded')).toBe('true')
    expect(layerChevron?.getAttribute('aria-label')).toBe('Collapse layer')
    expect(layerChevron?.hasAttribute('disabled')).toBe(false)
    expect(layerChevron?.nextElementSibling?.tagName).toBe('H2')
    // The pane is off in this render, so the layer carries no way to ask about it.
    expect([...(section?.querySelectorAll('.layer-ctl .cmd') ?? [])].map(b => b.textContent)).toEqual([])
    expect(section?.querySelector('.layer-ctl input')?.getAttribute('data-reviewed-id')).toBe(
      'layer:run-path'
    )
    expect(section?.querySelector('.layer-end .cmd')?.getAttribute('data-act')).toBe('mark-layer')
    expect(section?.querySelector('.rationale a[href="#line:src/app.ts:4"]')?.textContent).toBe('line 4')
    expect([...(section?.querySelectorAll('.judgment .lbl') ?? [])].map(h => h.textContent)).toEqual([
      'Decisions and trade-offs',
      'Check by hand',
    ])
    expect(section?.querySelector('.judgment.decisions a[href="#hunk:src/app.ts#1"]')?.textContent).toBe(
      'app.ts'
    )
    expect(section?.querySelector('.judgment.check-by-hand .prose')?.textContent?.trim()).toBe(
      'Run the app once and confirm the total.'
    )
    expect(section?.querySelector('.testmap')).not.toBeNull()
    // Order inside the section: rationale and judgment, test map, this layer's point cards, then files.
    expect(
      [...(section?.querySelectorAll('.body, .testmap, .lbl.sub, .findings, .files') ?? [])].map(
        el => el.className
      )
    ).toEqual(['body', 'lbl sub', 'testmap', 'lbl sub', 'findings', 'lbl sub', 'files'])
    expect([...(section?.querySelectorAll('.lbl.sub') ?? [])].map(h => h.textContent)).toEqual([
      'Tests',
      'Attention points · 1',
      'Files · 3',
    ])
    expect(
      [...(section?.querySelectorAll('.findings li.finding') ?? [])].map(li => li.getAttribute('data-point'))
    ).toEqual(['p-1'])
    const cards = [...(section?.querySelectorAll('article.file') ?? [])]
    expect(cards.map(c => c.id)).toEqual(['file-src_app_ts', 'file-src_new_name_ts', 'file-src_app_test_ts'])
    expect(cards[2]?.classList.contains('test')).toBe(true)
    // File header: chevron toggle, then the path, then the right-side controls with no collapse command.
    const fileChevron = cards[0]?.querySelector('.file-h > .chev')
    expect(fileChevron?.textContent).toBe('>')
    expect(fileChevron?.getAttribute('aria-expanded')).toBe('true')
    expect(fileChevron?.getAttribute('aria-label')).toBe('Collapse file')
    expect(fileChevron?.hasAttribute('disabled')).toBe(false)
    expect(fileChevron?.nextElementSibling?.classList.contains('path')).toBe(true)
    expect([...(cards[0]?.querySelectorAll('.file-h .cmd') ?? [])].map(b => b.textContent)).toEqual([])
    expect(cards[0]?.querySelector('.file-h .chk input')).not.toBeNull()
    expect(cards[2]?.querySelector('.pill.test-tag')?.textContent).toBe('test')
    expect(cards[0]?.querySelector('.note .prose')?.textContent?.trim()).toBe('Read the return first.')
    expect(cards[0]?.querySelector('.diff-host')?.getAttribute('data-hunks')).toBe('src_app_ts#1')
    expect(cards[0]?.querySelector('.more-hunks')?.textContent).toBe('1 more chunk in Other changes')
    expect(cards[1]?.querySelector('.path .old')?.textContent).toBe('src/old-name.ts → ')
    expect(cards[1]?.querySelector('.status')?.textContent).toBe('renamed')
    expect(section?.querySelector('.layer-end .cmd')?.textContent).toBe('mark layer as reviewed')
    const other = document.querySelector('section.panel#layer-other')
    expect(other?.querySelector('details summary h2')?.textContent).toBe('Other changes — 3 files, ignored')
    const otherChevron = other?.querySelector('details summary > .chev')
    expect(otherChevron?.getAttribute('aria-hidden')).toBe('true')
    expect(otherChevron?.nextElementSibling?.tagName).toBe('H2')
    expect(other?.querySelector('details summary .cmd')).toBeNull()
    expect(other?.querySelector('details')?.hasAttribute('open')).toBe(false)
    expect(fileCount(1)).toBe('1 file')
    expect(other?.querySelector('article.file#file-src_app_ts-other')).not.toBeNull()
    expect(other?.querySelector('article.file#file-src_app_ts-other .more-hunks')?.textContent).toBe(
      '1 more chunk in layer 1 · Run path'
    )
  })

  it('puts a layer diagram after the rationale and before the decisions, and omits it when absent', () => {
    const layer = artifact.layers[0]
    if (!layer) {
      throw new Error('no layer')
    }
    expect(layerDiagramHtml(layer)).toBe('')
    const drawn = { ...layer, diagram: { mermaid: 'stateDiagram-v2\n  [*] --> active', links: {} } }
    const cctx = { hunkIndex: hunkLayerIndex(artifact), paths, firstCardFor: new Set() }
    document.body.innerHTML = renderLayerSection(drawn, 0, artifact, files, state, cctx)
    const body = document.querySelector('section.layer > .layer-body > .body')
    expect([...(body?.children ?? [])].map(el => el.className)).toEqual([
      'rationale prose',
      'diagram',
      'judgment decisions',
      'judgment check-by-hand',
    ])
    expect(body?.querySelector('.diagram')?.getAttribute('data-mermaid')).toBe(
      'stateDiagram-v2\n  [*] --> active'
    )
  })

  it('draws a fence in the rationale and leaves one in the decisions as code', () => {
    const layer = artifact.layers[0]
    if (!layer) {
      throw new Error('no layer')
    }
    const fenced = {
      ...layer,
      rationale: 'The swap.\n\n```mermaid\nflowchart LR\n  A --> B\n```',
      decisions: 'We kept it.\n\n```mermaid\nflowchart LR\n  C --> D\n```',
    }
    const cctx = { hunkIndex: hunkLayerIndex(artifact), paths, firstCardFor: new Set() }
    document.body.innerHTML = renderLayerSection(fenced, 0, artifact, files, state, cctx)
    expect([...document.querySelectorAll('.diagram')].map(el => el.getAttribute('data-mermaid'))).toEqual([
      'flowchart LR\n  A --> B',
    ])
    expect(document.querySelector('.judgment.decisions pre code')?.textContent).toBe(
      'flowchart LR\n  C --> D\n'
    )
  })

  it('handles files missing from the manifest and a checked reviewed box', () => {
    const layer = artifact.layers[0]
    if (!layer) {
      throw new Error('no layer')
    }
    const cctx = { hunkIndex: hunkLayerIndex(artifact), paths, firstCardFor: new Set() }
    const html = renderFileCard(
      { path: 'ghost.ts', hunks: ['ghost_ts#1'], isTest: false, annotations: [] },
      undefined,
      layer,
      cctx
    )
    expect(html).toContain('id="file-ghost_ts"')
    expect(html).not.toContain('pill add')
    expect(
      elsewhereHtml(
        { path: 'ghost.ts', hunks: [], isTest: false, annotations: [] },
        undefined,
        layer,
        cctx.hunkIndex
      )
    ).toBe('')
    // A hunk that no layer lists is not reported as living elsewhere.
    const entry = files[0]
    if (!entry) {
      throw new Error('no entry')
    }
    expect(
      elsewhereHtml({ path: entry.path, hunks: [], isTest: false, annotations: [] }, entry, layer, new Map())
    ).toBe('')
    const done = { ...state, reviewed: { 'layer:run-path': /** @type {const} */ (true) } }
    document.body.innerHTML = renderLayerSection(layer, 0, artifact, files, done, cctx)
    expect(document.querySelector('.layer-ctl input')?.hasAttribute('checked')).toBe(true)
  })

  it('starts routine files collapsed without marking them reviewed', () => {
    const layer = artifact.layers[0]
    if (layer === undefined) {
      throw new Error('missing layer')
    }

    const file = {
      path: 'routine.ts',
      hunks: ['routine_ts#1'],
      isTest: false,
      annotations: [],
      collapsed: true,
    }
    const cardContext = { hunkIndex: hunkLayerIndex(artifact), paths, firstCardFor: new Set() }
    document.body.innerHTML = renderFileCard(file, undefined, layer, cardContext)

    expect(document.querySelector('.file-body')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('.chev')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('input')?.checked).toBe(false)

    document.body.innerHTML = renderFileCard(file, undefined, layer, { ...cardContext, keepOpen: true })
    expect(document.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('.chev')?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('hydration', () => {
  beforeEach(() => {
    document.body.innerHTML = renderLayers(artifact, files, state)
  })

  it('keeps a file collapsed when its diff finishes rendering', () => {
    const card = document.querySelector('article.file#file-src_app_ts')
    const body = card?.querySelector('.file-body')
    const toggle = card?.querySelector('.file-h > .chev')
    if (!(card instanceof HTMLElement && body instanceof HTMLElement && toggle instanceof HTMLElement)) {
      throw new Error('no file card')
    }
    body.hidden = true
    toggle.setAttribute('aria-expanded', 'false')

    expect(hydrateFileCard(card, ctx())).toEqual({ rendered: true, deferred: false, placed: 3, missed: 0 })
    expect(body.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders only the layer hunks and applies annotations, points, and threads', () => {
    const card = document.querySelector('article.file#file-src_app_ts')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    const result = hydrateFileCard(card, ctx())
    expect(result).toEqual({ rendered: true, deferred: false, placed: 3, missed: 0 })
    expect(card.querySelectorAll('table.diff').length).toBe(1)
    expect(card.querySelector('table.diff')?.id).toBe('hunk-src_app_ts-1')
    // Lines 3 and 4 carry the band edge, and so does the note row itself.
    expect(card.querySelectorAll('tr.ann').length).toBe(3)
    expect(card.querySelector('tr.annot .lbl')?.textContent).toBe('Annotation · lines 3–4')
    expect(card.querySelector('tr.ifind')?.getAttribute('data-point')).toBe('p-1')
    expect(card.querySelector('tr.thread.resolved .thread-collapsed')?.textContent).toBe(
      '1 resolved thread · show'
    )
    expect(card.querySelector('tr.thread.resolved .thread-full')?.hasAttribute('hidden')).toBe(true)
    // Row order under line 4: the line, its annotation, the point, the thread.
    const row4 = card.querySelector('#L-src_app_ts-new-4')
    expect(row4?.nextElementSibling?.classList.contains('annot')).toBe(true)
    expect(row4?.nextElementSibling?.nextElementSibling?.classList.contains('ifind')).toBe(true)
    expect(
      row4?.nextElementSibling?.nextElementSibling?.nextElementSibling?.classList.contains('thread')
    ).toBe(true)
    // Idempotent.
    expect(hydrateFileCard(card, ctx())).toEqual({ rendered: true, deferred: false, placed: 3, missed: 0 })
    expect(card.querySelectorAll('tr.annot').length).toBe(1)
  })

  it('hydrates the Other card with the second hunk and its tests-kind point', () => {
    const card = document.querySelector('article.file#file-src_app_ts-other')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    expect(hydrateFileCard(card, ctx())).toEqual({ rendered: true, deferred: false, placed: 1, missed: 0 })
    expect(card.querySelector('table.diff')?.id).toBe('hunk-src_app_ts-2')
    expect(card.querySelector('tr.ifind')?.getAttribute('data-point')).toBe('p-2')
  })

  it('places an old-side point on a deleted line', () => {
    const card = document.querySelector('article.file#file-src_gone_ts')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    expect(hydrateFileCard(card, ctx())).toEqual({ rendered: true, deferred: false, placed: 1, missed: 0 })
    expect(card.querySelector('#L-src_gone_ts-old-1')?.nextElementSibling?.classList.contains('ifind')).toBe(
      true
    )
  })

  it('shows the unavailable note without patches and skips malformed cards', () => {
    const card = document.querySelector('article.file#file-src_app_ts')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    expect(hydrateFileCard(card, { ...ctx(), patches: null })).toEqual({
      rendered: false,
      deferred: false,
      placed: 0,
      missed: 0,
    })
    expect(card.querySelector('.unavailable')?.textContent).toContain('Diff not available locally')
    card.removeAttribute('data-key')
    expect(hydrateFileCard(card, ctx())).toEqual({ rendered: false, deferred: false, placed: 0, missed: 0 })
    expect(hydrateAll(document, ctx())).toBe(5)
  })

  it('finds the hunk of a point and the threads of a hunk set', () => {
    const entry = files[0]
    const p = artifact.points[0]
    if (!(entry && p)) {
      throw new Error('fixture')
    }
    expect(hunkIdForPoint(p, entry)).toBe('src_app_ts#1')
    expect(hunkIdForPoint({ ...p, line: 99 }, entry)).toBe('')
    expect(threadsForHunks(comments, entry, new Set(['src_app_ts#1'])).map(t => t.root.id)).toEqual([1001])
    expect(threadsForHunks(comments, entry, new Set(['src_app_ts#2']))).toEqual([])
  })

  /**
   * happy-dom does not upgrade custom elements parsed from innerHTML, so the tests build an
   * upgraded element and run its callback directly.
   * @returns {PrFileElement}
   */
  function upgradedCard() {
    defineLayerElements()
    const el = document.createElement('pr-file')
    if (!(el instanceof PrFileElement)) {
      throw new Error('pr-file did not upgrade')
    }
    const source = document.querySelector('pr-file')
    el.innerHTML = source?.innerHTML ?? ''
    document.body.append(el)
    return el
  }

  it('holds a patch over the line limit behind [ show diff ] and draws it on click', async () => {
    document.body.innerHTML = renderLayers(artifact, files, state)
    const card = document.querySelector('article.file')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    const key = card.getAttribute('data-key') ?? ''
    const first = patches[key] ?? ''
    // The same patch, padded with context lines past the limit.
    const huge = `${first}\n${' x\n'.repeat(DEFERRED_DIFF_LINES)}`
    const big = { ...ctx(), patches: { ...patches, [key]: huge } }
    expect(patchLineCount(huge)).toBeGreaterThan(DEFERRED_DIFF_LINES)
    expect(patchLineCount('')).toBe(0)
    expect(hydrateFileCard(card, big)).toEqual({ rendered: false, deferred: true, placed: 0, missed: 0 })
    expect(card.querySelectorAll('table.diff').length).toBe(0)
    const show = card.querySelector('[data-act="show-diff"]')
    expect(show?.textContent).toBe('show diff')
    expect(card.querySelector('.deferred .hint')?.textContent).toContain(
      `above the ${DEFERRED_DIFF_LINES}-line limit`
    )
    if (!(show instanceof HTMLElement)) {
      throw new Error('no show command')
    }
    show.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(card.querySelectorAll('table.diff').length).toBeGreaterThan(0)

    // Asking for it up front skips the wait.
    document.body.innerHTML = renderLayers(artifact, files, state)
    const again = document.querySelector('article.file')
    if (!(again instanceof HTMLElement)) {
      throw new Error('no card')
    }
    expect(hydrateFileCard(again, big, { force: true }).deferred).toBe(false)
    expect(again.querySelectorAll('table.diff').length).toBeGreaterThan(0)
  })

  it('<pr-file> keeps a held-back card drawable, so a link into it still lands on a row', () => {
    document.body.innerHTML = renderLayers(artifact, files, state)
    const key = document.querySelector('article.file')?.getAttribute('data-key') ?? ''
    const huge = `${patches[key] ?? ''}\n${' x\n'.repeat(DEFERRED_DIFF_LINES)}`
    setRenderContext({ ...ctx(), patches: { ...patches, [key]: huge } })
    const saved = globalThis.IntersectionObserver
    vi.stubGlobal('IntersectionObserver', undefined)
    const el = upgradedCard()
    el.connectedCallback()
    expect(el.rendered).toBe(true)
    expect(el.deferred).toBe(true)
    expect(el.querySelectorAll('table.diff').length).toBe(0)
    // A second sighting changes nothing; a forced draw replaces the command with the diff.
    expect(el.renderNow()).toBe(false)
    expect(el.renderNow(true)).toBe(true)
    expect(el.deferred).toBe(false)
    expect(el.querySelectorAll('table.diff').length).toBe(1)
    expect(el.renderNow(true)).toBe(false)
    vi.stubGlobal('IntersectionObserver', saved)
    setRenderContext(null)
  })

  it('<pr-file> clears its held-back state when the reader clicks [ show diff ]', async () => {
    document.body.innerHTML = renderLayers(artifact, files, state)
    const key = document.querySelector('article.file')?.getAttribute('data-key') ?? ''
    const huge = `${patches[key] ?? ''}\n${' x\n'.repeat(DEFERRED_DIFF_LINES)}`
    setRenderContext({ ...ctx(), patches: { ...patches, [key]: huge } })
    const saved = globalThis.IntersectionObserver
    vi.stubGlobal('IntersectionObserver', undefined)
    const el = upgradedCard()
    el.connectedCallback()
    expect(el.deferred).toBe(true)
    const show = el.querySelector('[data-act="show-diff"]')
    if (!(show instanceof HTMLElement)) {
      throw new Error('no show command')
    }
    show.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(el.querySelectorAll('table.diff').length).toBe(1)
    expect(el.deferred).toBe(false)
    // A link into the card now finds its rows and leaves them alone.
    expect(el.renderNow(true)).toBe(false)
    vi.stubGlobal('IntersectionObserver', saved)
    setRenderContext(null)
  })

  it('<pr-file> renders its diff exactly once when it connects with the context set', () => {
    defineLayerElements()
    defineLayerElements()
    expect(customElements.get('pr-file')).toBe(PrFileElement)
    setRenderContext(ctx())
    expect(getRenderContext()).not.toBeNull()
    const saved = globalThis.IntersectionObserver
    vi.stubGlobal('IntersectionObserver', undefined)
    const el = upgradedCard()
    el.connectedCallback()
    expect(el.querySelectorAll('table.diff').length).toBe(1)
    expect(el.rendered).toBe(true)
    // Moving the element in the DOM reconnects it; the diff is not rendered again.
    const table = el.querySelector('table.diff')
    el.connectedCallback()
    expect(el.querySelector('table.diff')).toBe(table)
    // With no context there is nothing to render, and the callback does not throw.
    setRenderContext(null)
    const bare = upgradedCard()
    bare.connectedCallback()
    expect(bare.rendered).toBe(false)
    expect(bare.querySelector('table.diff')).toBeNull()
    const empty = document.createElement('pr-file')
    if (empty instanceof PrFileElement) {
      expect(() => empty.connectedCallback()).not.toThrow()
    }
    vi.stubGlobal('IntersectionObserver', saved)
  })

  it('<pr-file> waits for the IntersectionObserver when one exists', () => {
    setRenderContext(ctx())
    /** @type {{ cb: ((entries: Array<{ isIntersecting: boolean }>) => void) | null }} */
    const holder = { cb: null }
    const disconnect = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        /** @param {(entries: Array<{ isIntersecting: boolean }>) => void} cb */
        constructor(cb) {
          holder.cb = cb
        }
        observe() {}
        disconnect = disconnect
      }
    )
    const el = upgradedCard()
    el.connectedCallback()
    expect(el.querySelectorAll('table.diff').length).toBe(0)
    const cb = holder.cb
    if (!cb) {
      throw new Error('observer not created')
    }
    cb([{ isIntersecting: false }])
    expect(el.querySelectorAll('table.diff').length).toBe(0)
    cb([{ isIntersecting: true }])
    expect(el.querySelectorAll('table.diff').length).toBe(1)
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
    setRenderContext(null)
  })

  it('<pr-file> drops the watcher of its previous connection and the one it leaves behind', () => {
    setRenderContext(ctx())
    let created = 0
    const disconnect = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor() {
          created += 1
        }
        observe() {}
        disconnect = disconnect
      }
    )
    const el = upgradedCard()
    // Moving a card in the DOM reconnects it: one watcher at a time, not one per move.
    el.connectedCallback()
    el.connectedCallback()
    el.connectedCallback()
    expect(created).toBeGreaterThan(1)
    expect(disconnect).toHaveBeenCalledTimes(created - 1)
    el.disconnectedCallback()
    expect(disconnect).toHaveBeenCalledTimes(created)
    expect(el.observer).toBeNull()
    vi.unstubAllGlobals()
    setRenderContext(null)
  })

  it('runs the hook after a card draws, and stops running it once it is cleared', () => {
    setRenderContext(ctx())
    vi.stubGlobal('IntersectionObserver', undefined)
    /** @type {string[]} */
    const drawn = []
    setCardRenderedHook(card => drawn.push(card.getAttribute('data-key') ?? ''))
    upgradedCard().connectedCallback()
    expect(drawn).toEqual(['src_app_ts'])
    setCardRenderedHook(null)
    upgradedCard().connectedCallback()
    expect(drawn).toEqual(['src_app_ts'])
    vi.unstubAllGlobals()
    setRenderContext(null)
  })
})

describe('decorations in isolation', () => {
  it('reports misses for anchors that are not on the page and marks approximate placements', () => {
    document.body.innerHTML =
      '<article class="file"><table class="diff" data-key="k"><tbody><tr id="L-k-new-10" class="ctx" data-old="10"><td></td></tr></tbody></table></article>'
    const card = document.querySelector('article.file')
    if (!(card instanceof HTMLElement)) {
      throw new Error('no card')
    }
    expect(insertNoteRow(card, 'k', { side: 'new', startLine: 500, endLine: 501, text: 'far' })).toBe(false)
    expect(insertNoteRow(card, 'k', { side: 'new', startLine: 12, endLine: 12, text: 'near' })).toBe(true)
    expect(card.querySelector('tr.annot')?.classList.contains('is-approx')).toBe(true)
    const p = artifact.points[0]
    if (!p) {
      throw new Error('no point')
    }
    expect(insertPointRow(card, 'k', { ...p, line: 900 }, { paths: new Set() })).toBe(false)
    expect(insertPointRow(card, 'k', { ...p, line: 11 }, { paths: new Set() })).toBe(true)
    expect(card.querySelector('tr.ifind')?.classList.contains('is-approx')).toBe(true)
    const threads = buildThreads(comments)
    const t = threads.byAnchor.get('src/app.ts|new|4')?.[0]
    const outdated = threads.outdated.get('src/app.ts')?.[0]
    if (!(t && outdated)) {
      throw new Error('no thread')
    }
    expect(insertThreadRow(card, 'k', outdated, { now: NOW })).toBe(false)
    expect(insertThreadRow(card, 'k', { ...t, line: 10, resolved: false }, { now: NOW })).toBe(true)
    expect(card.querySelector('tr.thread .cmt .who b')?.textContent).toBe('reviewer')
    expect(insertThreadRow(card, 'k', { ...t, line: 700, resolved: false }, { now: NOW })).toBe(false)
    expect(threadRowHtml({ ...t, resolved: false }, { now: NOW, hidden: true })).toContain('1 hidden thread')
    expect(commentHtml(t.root, NOW)).toContain('<b>reviewer</b>')
    const data = {
      annotations: [{ side: /** @type {const} */ ('old'), startLine: 10, endLine: 10, text: 'old side' }],
      points: [{ ...p, line: 900 }],
      threads: [
        { ...t, line: 10, resolved: false },
        { ...t, line: 12, resolved: false },
      ],
      paths: new Set(),
      now: NOW,
      hiddenThreads: new Set([1001]),
    }
    expect(applyDecorations(card, 'k', data)).toEqual({ placed: 3, missed: 1 })
    expect(card.querySelector('tr.thread.hidden-thread')).not.toBeNull()
    expect(card.querySelectorAll('tr.thread.is-approx').length).toBe(1)
    expect(card.querySelector('tr.annot .lbl')?.textContent).toBe('Annotation · line 10 (old)')
    // Re-applying removes the previous rows and bands first.
    expect(applyDecorations(card, 'k', data)).toEqual({ placed: 3, missed: 1 })
    expect(card.querySelectorAll('tr.annot').length).toBe(1)
    expect(card.querySelectorAll('tr.ann').length).toBe(2)
  })
})

/** @type {import('./contract-types.js').ReviewArtifact} */
const fixture = JSON.parse(await readFile(path.join(PACKAGE_ROOT, '__fixtures__/pr-278/review.json'), 'utf8'))
const repoGit = createGit(path.resolve(PACKAGE_ROOT, '..', '..'))
const liveHead = await repoGit.revParse('refs/pr/278/head').catch(() => null)
const liveDiffAvailable =
  liveHead === fixture.pr.headSha && (await repoGit.commitExists(fixture.pr.mergeBaseSha))

describe('canvas without an Other layer', () => {
  it('renders the rail, the sections, and the progress count with every layer semantic', () => {
    const noOther = { ...artifact, layers: artifact.layers.filter(l => l.kind !== 'other') }
    document.body.innerHTML = renderRail(noOther, state) + renderLayers(noOther, files, state)
    expect(document.querySelector('li.other')).toBeNull()
    expect(document.querySelectorAll('section.layer').length).toBe(1)
    expect(document.querySelectorAll('section.panel#layer-other').length).toBe(0)
    expect(document.querySelector('section.layer h2')?.textContent).toContain('Layer 1 of 1')
    expect(document.querySelectorAll('article.file').length).toBe(3)
    // The second hunk of src/app.ts belongs to no layer here, so no cross-layer link is drawn.
    expect(document.querySelector('.more-hunks')).toBeNull()
    expect(progressSummary(noOther, state)).toEqual({ done: 0, total: 1, percent: 0 })
  })
})

describe('PR #278 fixture render', () => {
  it('renders every layer, card, point, and test map without a console error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const semantic = fixture.layers.filter(l => l.kind !== 'other')
    document.body.innerHTML = renderRail(fixture, state) + renderLayers(fixture, fixture.files, state)
    expect(document.querySelectorAll('section.layer').length).toBe(semantic.length)
    expect(document.querySelectorAll('section.panel#layer-other').length).toBe(1)
    expect(document.querySelectorAll('article.file').length).toBe(
      fixture.layers.reduce((n, l) => n + l.files.length, 0)
    )
    expect(document.querySelectorAll('.testmap').length).toBe(semantic.filter(l => l.tests.length > 0).length)
    expect(document.querySelectorAll('.tree .layers a').length).toBe(semantic.length)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it.skipIf(!liveDiffAvailable)(
    'hydrates every card from the live diff of refs/pr/278/head',
    async () => {
      const { collectDiffs } = await import('../../src/git/diff-collector.js')
      const live = await collectDiffs(repoGit, fixture.pr.mergeBaseSha, fixture.pr.headSha)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      document.body.innerHTML = renderLayers(fixture, fixture.files, state)
      const rendered = hydrateAll(document, {
        artifact: fixture,
        files: fixture.files,
        patches: toPatchMap(live),
        comments: [],
        state,
        now: NOW,
      })
      expect(rendered).toBe(document.querySelectorAll('article.file').length)
      expect(document.querySelectorAll('table.diff').length).toBe(
        fixture.files.reduce((n, f) => n + f.hunks.length, 0)
      )
      expect(document.querySelectorAll('tr.ifind').length).toBe(fixture.points.length)
      expect(document.querySelectorAll('tr.annot').length).toBe(
        fixture.layers.reduce((n, l) => n + l.files.reduce((m, f) => m + f.annotations.length, 0), 0)
      )
      expect(document.querySelectorAll('tr.is-approx').length).toBe(0)
      expect(errors).not.toHaveBeenCalled()
      errors.mockRestore()
    },
    30_000
  )
})

describe('the ask command on a card', () => {
  it('appears with the target once the AI Chat pane is on', () => {
    setChatEnabled(true)
    try {
      document.body.innerHTML = renderLayers(artifact, files, state, comments)
      const layerAsk = document.querySelector('.layer-ctl [data-act="ask"]')
      expect(layerAsk?.textContent).toBe('ask about this layer')
      expect(layerAsk?.getAttribute('data-ask-layer')).toBe('run-path')
      const fileAsk = document.querySelector('article.file [data-act="ask"]')
      expect(fileAsk?.getAttribute('data-ask-path')).toBe('src/app.ts')
    } finally {
      setChatEnabled(false)
    }
  })
})
