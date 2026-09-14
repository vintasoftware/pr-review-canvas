// @ts-check
// Mermaid diagrams. A diagram is a `.diagram[data-mermaid]` placeholder holding its source in an
// attribute; the library is imported only when a page has at least one, runs with
// `securityLevel: 'strict'`, and its SVG goes through DOMPurify before it reaches the page.
// Model text is untrusted, so mermaid's own escaping is not the only barrier.
import DOMPurify from 'dompurify'
import { followLink } from './deep-link.js'
import { chevronHtml, esc } from './dom.js'
import { linkLabel, parseLink } from './links.js'
import { diagramKind } from './mermaid-fences.js'

export { diagramKind }

/** The page tokens the diagram theme is built from. Read from the computed style, so both themes work. */
export const THEME_TOKENS = /** @type {const} */ ([
  '--bg',
  '--panel',
  '--fg',
  '--fg-muted',
  '--line',
  '--accent',
  '--purple',
  '--v1',
  '--v2',
  '--v3',
  '--v4',
  '--v5',
  '--v6',
])

/** @typedef {Record<(typeof THEME_TOKENS)[number], string>} ThemeColors */
/** The part of mermaid this module uses, taken from mermaid's own types so a version bump is checked. */
/** @typedef {Pick<import('mermaid').Mermaid, 'initialize' | 'render'>} MermaidApi */
/** @typedef {{ load?: () => Promise<MermaidApi>, colors?: ThemeColors }} RenderOptions */

/** Colors that keep a diagram readable when a token is missing (the dark theme's values). */
const FALLBACK_COLORS = {
  '--bg': '#1e1f2b',
  '--panel': '#282a3a',
  '--fg': '#eaf2f1',
  '--fg-muted': '#a4a8b3',
  '--line': '#3a3d4b',
  '--accent': '#91a7ff',
  '--purple': '#c39ac9',
  '--v1': '#ffe066',
  '--v2': '#ffc078',
  '--v3': '#faa2c1',
  '--v4': '#e599f7',
  '--v5': '#b197fc',
  '--v6': '#91a7ff',
}

/**
 * The diagram as a fenced block, which is how a GitHub comment draws it. The fence is longer than
 * the longest run of backticks in the source, so a source that holds a fence of its own stays
 * inside the block when it is pasted.
 * @param {string} source mermaid text
 * @returns {string}
 */
export function diagramMarkdown(source) {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}mermaid\n${source}\n${fence}`
}

/**
 * The placeholder a diagram renders into: a header with the chevron, what kind of drawing it is,
 * and a copy command, then the body the SVG goes in. The source sits in an attribute, never as
 * markup, and so does the sidecar map of node links.
 * @param {string} source mermaid text
 * @param {Record<string, string>} [links] node id → canvas link
 * @returns {string}
 */
export function diagramPlaceholderHtml(source, links = {}) {
  const kind = diagramKind(source)
  const label = kind === '' ? 'diagram' : `diagram &middot; ${esc(kind)}`
  const map = Object.keys(links).length === 0 ? '' : ` data-links="${esc(JSON.stringify(links))}"`
  return (
    `<div class="diagram" data-mermaid="${esc(source)}"${map}>` +
    `<div class="diagram-h">${chevronHtml('Toggle diagram')}<span class="lbl">${label}</span>` +
    `<button class="cmd" type="button" data-copy="${esc(diagramMarkdown(source))}">copy</button></div>` +
    '<div class="diagram-body"></div></div>'
  )
}

/**
 * The sidecar map a placeholder carries. Anything that is not an object of strings reads as no
 * links at all: the attribute holds model output, which is text like any other.
 * @param {HTMLElement} node
 * @returns {Record<string, string>}
 */
function linksOf(node) {
  const raw = node.getAttribute('data-links')
  if (raw === null || raw === '') {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(Object.entries(parsed).filter(([, href]) => typeof href === 'string'))
  } catch {
    return {}
  }
}

/** The prefix mermaid puts in front of a node's id, by diagram type. */
const NODE_PREFIXES = ['flowchart', 'state', 'entity', 'classId']

/** @param {string} text */
function escapeForRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The pattern that matches the group id mermaid gives one node: the id of the whole drawing
 * first, then the type's prefix, the source id, and a counter, as in
 * `pr-diagram-3-flowchart-store-1` or `pr-diagram-3-state-active-1`. Naming the drawing keeps a
 * node called `b` apart from a node called `a-state-b`.
 * @param {string} nodeId
 * @param {string} [svgId] the id of the `<svg>` the groups sit in
 * @returns {RegExp}
 */
export function nodeGroupPattern(nodeId, svgId = '') {
  const head = svgId === '' ? '(?:^|-)' : `^${escapeForRegex(svgId)}-`
  return new RegExp(`${head}(?:${NODE_PREFIXES.join('|')})-${escapeForRegex(nodeId)}-\\d+$`)
}

/**
 * The groups mermaid drew for one node id, inside one diagram body. A sequence participant is
 * found by the `data-id` mermaid writes on it, which it marks with `data-et="participant"`; the
 * other types are found by their group id.
 * @param {ParentNode} body
 * @param {string} nodeId
 * @returns {Element[]}
 */
export function findNodeGroups(body, nodeId) {
  const svg = body.querySelector('svg')
  const pattern = nodeGroupPattern(nodeId, svg?.getAttribute('id') ?? '')
  return [...body.querySelectorAll('g')].filter(g => {
    const id = g.getAttribute('id')
    const participant = g.getAttribute('data-et') === 'participant' && g.getAttribute('data-id') === nodeId
    return participant || (id !== null && pattern.test(id))
  })
}

/**
 * Makes the drawn nodes of one placeholder clickable, from its sidecar map. The link itself is
 * parsed first, so only the four canvas forms reach the page, and it lands on `data-link`, which
 * the delegated handler reads: mermaid's own `click` directives stay off.
 * @param {HTMLElement} node the `.diagram` element
 * @returns {number} how many groups became links
 */
export function attachNodeLinks(node) {
  const { body } = partsOf(node)
  if (body === null) {
    return 0
  }
  let attached = 0
  for (const [nodeId, href] of Object.entries(linksOf(node))) {
    const link = parseLink(href)
    if (link === null) {
      continue
    }
    for (const group of findNodeGroups(body, nodeId)) {
      group.setAttribute('data-link', href)
      group.setAttribute('role', 'link')
      group.setAttribute('tabindex', '0')
      group.setAttribute('aria-label', linkLabel(link))
      attached += 1
    }
  }
  return attached
}

/**
 * Follows the node link under an event, if there is one. Click and Enter both arrive here.
 * @param {Event} event
 * @returns {boolean} true when a link was followed
 */
export function activateNodeLink(event) {
  const target = event.target instanceof Element ? event.target.closest('.diagram-body [data-link]') : null
  const href = target?.getAttribute('data-link') ?? null
  if (href === null) {
    return false
  }
  event.preventDefault()
  return followLink(href)
}

/**
 * The parts of one placeholder. An empty body means the diagram still needs drawing, which is what
 * a closed one is left with: it is drawn when it is opened rather than while nobody can see it.
 * @param {HTMLElement} node
 */
function partsOf(node) {
  const chevron = node.querySelector('.diagram-h .chev')
  const body = node.querySelector('.diagram-body')
  return {
    chevron: chevron instanceof HTMLElement ? chevron : null,
    body: body instanceof HTMLElement ? body : null,
    open: chevron === null || chevron.getAttribute('aria-expanded') !== 'false',
  }
}

/** What the muted line says when a placeholder shows its source instead of a drawing. */
export const FALLBACK_NOTE = 'diagram could not be rendered'
export const DIRECTIVE_NOTE = 'diagram not drawn: it sets mermaid options'

/**
 * What a placeholder shows when mermaid cannot draw it: the source, and a line saying why.
 * @param {string} source
 * @param {string} [note]
 * @returns {string}
 */
export function diagramFallbackHtml(source, note = FALLBACK_NOTE) {
  return `<pre class="diagram-src"><code>${esc(source)}</code></pre><p class="muted small">${esc(note)}</p>`
}

/**
 * True when the source sets mermaid options, through a `%%{...}%%` directive or through YAML front
 * matter at the top. Mermaid keeps `securityLevel` out of their reach but lets them set `themeCSS`,
 * which puts CSS of the author's choosing inside the drawing, and `htmlLabels`, which draws labels
 * the SVG sanitizer then removes. The source comes from a model or from a pull request written by
 * anyone, and the page supplies the theme, so a diagram that sets options is not drawn.
 * @param {string} source
 * @returns {boolean}
 */
export function setsOptions(source) {
  return source.includes('%%{') || /^\s*---\s*[\n\r]/.test(source)
}

/**
 * The page's colors, resolved. The tokens use `light-dark()`, which a custom property keeps
 * unresolved, so each one is read back through a probe element's `color`. A token the page never
 * declares gets its fallback: an undeclared property makes the probe's `color` invalid, and the
 * probe would then report the color it inherits.
 * @param {Document} [doc]
 * @returns {ThemeColors}
 */
export function readThemeColors(doc = document) {
  const view = doc.defaultView
  const root = view === null || view === undefined ? null : view.getComputedStyle(doc.documentElement)
  const probe = doc.createElement('span')
  probe.style.display = 'none'
  doc.body.append(probe)
  try {
    return /** @type {ThemeColors} */ (
      Object.fromEntries(
        THEME_TOKENS.map(token => {
          if ((root?.getPropertyValue(token) ?? '').trim() === '') {
            return [token, FALLBACK_COLORS[token]]
          }
          probe.style.color = `var(${token})`
          const value = view?.getComputedStyle(probe).color ?? ''
          return [token, value === '' ? FALLBACK_COLORS[token] : value]
        })
      )
    )
  } finally {
    probe.remove()
  }
}

/**
 * The mermaid config for one theme. `base` plus the page tokens, so a diagram looks like the page
 * it sits in instead of like mermaid.
 * @param {ThemeColors} c
 */
export function mermaidConfig(c) {
  // `useMaxWidth: false` keeps the drawing at its own size, so a wide one scrolls inside its card
  // at a readable scale. It is per diagram type, so each type the prompt recommends says it.
  const own = { useMaxWidth: false }
  return {
    startOnLoad: false,
    securityLevel: /** @type {const} */ ('strict'),
    // Mermaid draws its own error diagram into a temporary element and leaves it in the page;
    // with this on it cleans up and throws, and the placeholder shows the source instead.
    suppressErrorRendering: true,
    theme: /** @type {const} */ ('base'),
    // SVG text labels: an HTML label would be stripped by the SVG sanitizer.
    htmlLabels: false,
    flowchart: { htmlLabels: false, ...own },
    sequence: own,
    state: own,
    er: own,
    themeVariables: {
      background: c['--bg'],
      mainBkg: c['--panel'],
      primaryColor: c['--panel'],
      primaryTextColor: c['--fg'],
      primaryBorderColor: c['--fg'],
      secondaryColor: c['--bg'],
      secondaryBorderColor: c['--line'],
      tertiaryColor: c['--bg'],
      tertiaryBorderColor: c['--line'],
      textColor: c['--fg'],
      nodeTextColor: c['--fg'],
      nodeBorder: c['--fg'],
      lineColor: c['--fg-muted'],
      clusterBkg: c['--bg'],
      clusterBorder: c['--line'],
      titleColor: c['--fg'],
      edgeLabelBackground: c['--bg'],
      labelBoxBkgColor: c['--panel'],
      labelBoxBorderColor: c['--line'],
      labelTextColor: c['--fg'],
      loopTextColor: c['--fg'],
      noteBkgColor: c['--bg'],
      noteTextColor: c['--fg-muted'],
      noteBorderColor: c['--purple'],
      actorBkg: c['--panel'],
      actorBorder: c['--fg'],
      actorTextColor: c['--fg'],
      actorLineColor: c['--line'],
      signalColor: c['--fg-muted'],
      signalTextColor: c['--fg'],
      activationBkgColor: c['--panel'],
      activationBorderColor: c['--accent'],
      cScale0: c['--v1'],
      cScale1: c['--v2'],
      cScale2: c['--v3'],
      cScale3: c['--v4'],
      cScale4: c['--v5'],
      cScale5: c['--v6'],
    },
  }
}

/** The library is fetched once per page, the first time a diagram needs it. */
/** @type {Promise<MermaidApi> | null} */
let modulePromise = null

/**
 * The default loader: the import map points `mermaid` at the vendored ESM build.
 * @returns {Promise<MermaidApi>}
 */
async function importMermaid() {
  const module = await import('mermaid')
  return module.default
}

/** Forgets the loaded library. Tests call it between cases; the page never does. */
export function resetMermaid() {
  modulePromise = null
  nextId = 0
}

let nextId = 0

/** Each call to `drawNodes` takes the next number and claims the nodes it draws with it. */
let nextPass = 0

/**
 * Sanitizes one rendered SVG. `svg` and `svgFilters` cover the shapes mermaid emits; scripts,
 * event handlers, `foreignObject`, and `javascript:` targets do not survive. The `<style>` mermaid
 * writes its theme into stays, which is why a source that sets `themeCSS` is refused earlier.
 * @param {string} svg
 * @returns {string}
 */
export function sanitizeSvg(svg) {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_ATTR: ['viewBox', 'preserveAspectRatio', 'marker-end', 'marker-start', 'dominant-baseline'],
  })
}

/**
 * Draws every placeholder under `root`. Nothing is imported when there is none.
 * @param {ParentNode} root
 * @param {RenderOptions & { cancelled?: () => boolean }} [opts]
 * @returns {Promise<{ rendered: number, failed: number }>}
 */
export async function renderDiagrams(root, opts = {}) {
  return drawNodes(collectNodes(root), opts)
}

/**
 * The placeholders under `root`, and `root` itself when it is one. Opening a single diagram draws
 * that one node, so the collector has to accept it as well as its container.
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
function collectNodes(root) {
  const found = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.diagram[data-mermaid]')])
  return root instanceof HTMLElement && root.matches('.diagram[data-mermaid]') ? [root, ...found] : found
}

/**
 * Draws the given placeholders. Nothing is imported when the list is empty, and a closed diagram
 * is left for the moment it is opened.
 * @param {readonly HTMLElement[]} nodes
 * @param {RenderOptions & { cancelled?: () => boolean }} opts
 * @returns {Promise<{ rendered: number, failed: number }>}
 */
async function drawNodes(nodes, opts) {
  nextPass += 1
  const pass = String(nextPass)
  // Every node is claimed before anything is awaited, so the pass that started last owns them all
  // and a pass that resumes later can no longer take one back.
  /** @type {HTMLElement[]} */
  const open = []
  for (const node of nodes) {
    node.setAttribute('data-pass', pass)
    const parts = partsOf(node)
    if (parts.open) {
      open.push(node)
      continue
    }
    if (parts.body !== null) {
      parts.body.innerHTML = ''
    }
  }
  if (open.length === 0) {
    return { rendered: 0, failed: 0 }
  }
  const cancelled = opts.cancelled ?? (() => false)
  const load = opts.load ?? importMermaid
  let mermaid
  try {
    modulePromise ??= load()
    mermaid = await modulePromise
  } catch {
    // A later render tries the import again; the page keeps working without the library.
    modulePromise = null
    if (cancelled()) {
      return { rendered: 0, failed: 0 }
    }
    let shown = 0
    for (const node of open) {
      shown += write(node, pass, diagramFallbackHtml(node.getAttribute('data-mermaid') ?? '')) ? 1 : 0
    }
    return { rendered: 0, failed: shown }
  }
  if (cancelled()) {
    return { rendered: 0, failed: 0 }
  }
  mermaid.initialize(mermaidConfig(opts.colors ?? readThemeColors()))
  let rendered = 0
  let failed = 0
  for (const node of open) {
    if (node.getAttribute('data-pass') !== pass) {
      continue
    }
    const source = node.getAttribute('data-mermaid') ?? ''
    if (setsOptions(source)) {
      failed += write(node, pass, diagramFallbackHtml(source, DIRECTIVE_NOTE)) ? 1 : 0
      continue
    }
    nextId += 1
    try {
      const result = await mermaid.render(`pr-diagram-${nextId}`, source)
      if (cancelled()) {
        break
      }
      rendered += write(node, pass, sanitizeSvg(result.svg)) ? 1 : 0
    } catch {
      if (cancelled()) {
        break
      }
      failed += write(node, pass, diagramFallbackHtml(source)) ? 1 : 0
    }
  }
  return { rendered, failed }
}

/**
 * Puts a drawing, or the source it could not draw, in the placeholder's body. The header stays.
 * A pass writes only while it still owns the node: a theme flip or an opened diagram starts a
 * newer pass, and the drawing the older one was working on is the wrong one by then. A node that
 * was closed while the pass ran is left empty, so opening it draws it in the theme on screen.
 * @param {HTMLElement} node
 * @param {string} pass the writer's pass number
 * @param {string} html already sanitized or escaped
 * @returns {boolean} true when the html reached the page
 */
function write(node, pass, html) {
  if (node.getAttribute('data-pass') !== pass) {
    return false
  }
  const { body, open } = partsOf(node)
  if (body === null) {
    return false
  }
  if (open) {
    body.innerHTML = html
    // Every drawing is written here, so this is where a redrawn diagram gets its links back.
    attachNodeLinks(node)
    return true
  }
  body.innerHTML = ''
  return false
}

/**
 * Runs `onChange` whenever the theme or the skin flips, so the diagrams can be drawn again in the
 * new colors. Both attributes change the tokens a diagram is built from.
 * @param {() => void} onChange
 * @param {HTMLElement} [target] usually <html>
 * @returns {{ stop: () => void }}
 */
export function observeTheme(onChange, target = document.documentElement) {
  if (typeof MutationObserver === 'undefined') {
    return { stop: () => {} }
  }
  const observer = new MutationObserver(() => onChange())
  observer.observe(target, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] })
  return { stop: () => observer.disconnect() }
}

/**
 * Opens or closes one diagram. One that holds no drawing is drawn now, whether it was closed
 * before the page got to it or emptied by a theme flip, so a reader always opens a diagram in the
 * theme on screen. One that already holds its drawing is shown again without redrawing.
 * @param {HTMLElement} node the `.diagram` element
 * @param {RenderOptions & { cancelled?: () => boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function toggleDiagram(node, opts = {}) {
  const { chevron, body } = partsOf(node)
  if (chevron === null || body === null) {
    return
  }
  const opening = chevron.getAttribute('aria-expanded') === 'false'
  chevron.setAttribute('aria-expanded', opening ? 'true' : 'false')
  body.hidden = !opening
  if (opening && body.innerHTML === '') {
    await drawNodes([node], opts)
  }
}

/**
 * Draws the diagrams of a screen, keeps them in the page's theme, and lets a reader close one.
 * `stop` ends the watch, the click handler, and the pass that is running, so a screen that goes
 * away writes nothing more.
 * @param {ParentNode} root
 * @param {RenderOptions} [opts]
 */
export function initDiagrams(root, opts = {}) {
  let stopped = false
  const cancelled = () => stopped
  const pass = { ...opts, cancelled }
  void renderDiagrams(root, pass)
  const watch = observeTheme(() => {
    void renderDiagrams(root, pass)
  })
  const clicks = new AbortController()
  if (root instanceof HTMLElement || root instanceof Document) {
    // One listener for the screen: a redrawn diagram brings new elements, never a new handler.
    root.addEventListener(
      'click',
      event => {
        if (activateNodeLink(event)) {
          return
        }
        const chevron = event.target instanceof Element ? event.target.closest('.diagram > .diagram-h > .chev') : null
        const node = chevron?.closest('.diagram')
        if (node instanceof HTMLElement) {
          void toggleDiagram(node, pass)
        }
      },
      { signal: clicks.signal }
    )
    root.addEventListener(
      'keydown',
      event => {
        if (event instanceof KeyboardEvent && event.key === 'Enter') {
          activateNodeLink(event)
        }
      },
      { signal: clicks.signal }
    )
  }
  return {
    stop: () => {
      stopped = true
      watch.stop()
      clicks.abort()
    },
  }
}
