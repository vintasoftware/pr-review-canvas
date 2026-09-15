// @ts-check
// Markdown for every AI-written or GitHub-written text: marked (GFM, raw HTML off) →
// DOMPurify with an allowlist → headings demoted → path:line linkify. Returns an HTML string that
// is safe to assign to innerHTML.
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { diagramPlaceholderHtml } from './diagram.js'
import { esc } from './dom.js'
import { linkLabel, parseLink } from './links.js'
import { splitMermaid } from './mermaid-fences.js'

const ALLOWED_TAGS = [
  'p',
  'br',
  'em',
  'strong',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // h1 and h2 pass the sanitizer only so demoteHeadings can turn them into h3 and h4.
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'del',
  'input',
  'img',
  'details',
  'summary',
  'kbd',
  'sup',
  'sub',
]
// `type`, `checked`, and `disabled` are for GFM task-list checkboxes. No `class`: model text must
// not be able to style itself as a command.
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'type', 'checked', 'disabled', 'open']
const ALLOWED_URI = /^(?:https?:|#)/i

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML in the source renders as text, never as markup.
    html(token) {
      return esc(token.text)
    },
  },
})

const githubMarked = new Marked({ gfm: true, breaks: false })

/** Model text never outranks the page's own headings: h1→h3, h2→h4, h3→h5, h4-h6→h6. */
const DEMOTE = { H1: 'h3', H2: 'h4', H3: 'h5', H4: 'h6', H5: 'h6', H6: 'h6' }

/**
 * @param {HTMLElement} root
 */
function demoteHeadings(root) {
  for (const el of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    const tag = DEMOTE[/** @type {keyof typeof DEMOTE} */ (el.tagName)]
    const next = document.createElement(tag)
    while (el.firstChild) {
      next.append(el.firstChild)
    }
    el.replaceWith(next)
  }
}

/**
 * Turns `path/to/file.ts:12` and `path/to/file.ts:12-20` in text nodes into canvas links, but
 * only for paths that are in the diff.
 * @param {HTMLElement} root
 * @param {ReadonlySet<string>} paths
 */
function linkifyPaths(root, paths) {
  if (paths.size === 0) {
    return
  }
  const re = /((?:[\w@.-]+\/)+[\w@.-]+\.[\w-]+):(\d+)(?:-(\d+))?/g
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  /** @type {Text[]} */
  const texts = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement
    if (parent && !parent.closest('a,code,pre')) {
      texts.push(/** @type {Text} */ (n))
    }
  }
  for (const node of texts) {
    const text = node.data
    let last = 0
    /** @type {Node[]} */
    const out = []
    for (const m of text.matchAll(re)) {
      const path = m[1] ?? ''
      if (!paths.has(path) || m.index === undefined) {
        continue
      }
      out.push(document.createTextNode(text.slice(last, m.index)))
      const a = document.createElement('a')
      const range = m[3] ? `${m[2]}-${m[3]}` : m[2]
      a.href = `#line:${path}:${range}`
      a.className = 'loc'
      a.textContent = m[0]
      out.push(a)
      last = m.index + m[0].length
    }
    if (out.length === 0) {
      continue
    }
    out.push(document.createTextNode(text.slice(last)))
    node.replaceWith(...out)
  }
}

/**
 * Canvas links get `.loc` and a label when empty; http(s) links open in a new tab.
 * @param {HTMLElement} root
 */
function decorateLinks(root) {
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? ''
    const link = parseLink(href)
    if (link) {
      a.classList.add('loc')
      a.setAttribute('data-link', href)
      if (a.textContent === '' || a.textContent === href) {
        a.textContent = linkLabel(link)
      }
    } else if (/^https?:/i.test(href)) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }
}

/**
 * One markdown text, without mermaid blocks.
 * @param {string} src markdown
 * @param {{ paths?: ReadonlySet<string>, github?: boolean }} opts
 * @returns {string} sanitized HTML
 */
function renderProse(src, opts) {
  const raw = (opts.github ? githubMarked : marked).parse(src, { async: false })
  // marked's renderer escapes raw HTML, and the sanitizer is still the boundary: nothing from
  // `raw` reaches a DOM tree before DOMPurify has parsed and filtered it.
  const root = document.createElement('div')
  root.append(
    DOMPurify.sanitize(raw, {
      ALLOWED_TAGS,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'form'],
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: ALLOWED_URI,
      KEEP_CONTENT: true,
      RETURN_DOM_FRAGMENT: true,
    })
  )
  for (const element of root.querySelectorAll('*')) {
    if (!ALLOWED_TAGS.includes(element.tagName.toLowerCase())) element.remove()
  }
  for (const img of root.querySelectorAll('img')) {
    if (!/^https:\/\//i.test(img.getAttribute('src') ?? '')) {
      img.remove()
    } else {
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
    }
  }
  for (const input of root.querySelectorAll('input')) {
    input.type = 'checkbox'
    input.disabled = true
  }
  demoteHeadings(root)
  linkifyPaths(root, opts.paths ?? new Set())
  decorateLinks(root)
  return root.innerHTML
}

/**
 * The link reference definitions of a text, written out again as markdown. Marked reads them, so
 * a definition shown inside a code block is an example and a definition written over two lines is
 * still one definition. The title is dropped, since the sanitizer allows no `title` attribute.
 * @param {string} src markdown
 * @returns {string}
 */
function linkDefinitions(src) {
  // The destination is already parsed, so the characters marked reads in one are written back
  // escaped: it parses this text a second time and must arrive at the same destination.
  return Object.entries(marked.lexer(src).links)
    .map(([label, def]) => `[${label}]: <${def.href.replace(/[\\<>]/g, ch => `\\${ch}`)}>`)
    .join('\n')
}

/**
 * Markdown as sanitized HTML. Two fields draw diagrams, the PR summary and a layer rationale, and
 * they ask for it with `diagrams`. Everywhere else a ```mermaid fence stays a code block: a PR
 * description and a GitHub comment are text from anyone, and the validator counts and measures
 * diagrams only in the two fields the model writes them in.
 * @param {string} src markdown
 * @param {{ paths?: ReadonlySet<string>, diagrams?: boolean, github?: boolean }} [opts] `paths` linkifies `path:line`
 * @returns {string} sanitized HTML
 */
export function renderMarkdown(src, opts = {}) {
  if (opts.diagrams !== true) {
    return renderProse(src, opts)
  }
  const segments = splitMermaid(src)
  // Each piece of prose is parsed on its own, so the link definitions of the whole text are
  // repeated in front of every piece: `[label]: target` written after a drawing still resolves a
  // `[label]` written before it. A definition renders nothing, so repeating one shows nothing.
  const defs = linkDefinitions(src)
  return segments
    .map(segment =>
      segment.type === 'mermaid'
        ? diagramPlaceholderHtml(segment.text)
        : renderProse(defs === '' ? segment.text : `${defs}\n\n${segment.text}`, opts)
    )
    .join('')
}
