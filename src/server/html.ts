import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { ErrorEnvelope, HomeData, ReviewBootstrap } from '../contract/api.js'
import { keyLabel, keyToString, type LocalKey } from '../contract/review-key.js'
import type { Appearance } from '../contract/settings.js'
import type { TourBootstrap } from '../contract/tour-api.js'
import { type Host, publicHost } from '../host/host.js'

type Html = HtmlEscapedString | Promise<HtmlEscapedString>

/** Bare names the browser modules import; the server maps them to `/vendor/*` files. */
export const IMPORT_MAP = {
  imports: {
    diff: '/vendor/diff/index.js',
    marked: '/vendor/marked.js',
    dompurify: '/vendor/purify.js',
    hljs: '/vendor/highlight.js',
    mermaid: '/vendor/mermaid/mermaid.esm.min.mjs',
  },
} as const

/**
 * Names the page must not preload: mermaid is imported by `diagram.js` only when a screen holds a
 * diagram, and most screens hold none.
 */
export const LAZY_IMPORTS: readonly string[] = ['mermaid']

/** JSON that is safe inside a <script> element: no `<`, `>`, `&`, or line separators. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export interface PageOptions {
  title: string
  bootstrap: unknown
  body: Html
  /** Load the app module. Off for the plain pages (home, error). */
  app: boolean
  /** The module the page boots from, when it is not the review app. */
  entry?: string
  /** The nonce of this response's Content-Security-Policy; the inline scripts carry it. */
  nonce: string
  /** How this page is painted, from the settings file or this request's `?skin` and `?theme`. */
  appearance: Appearance
}

export function pageShell(opts: PageOptions): Html {
  const entry = opts.entry ?? '/static/js/app.js'
  // The vendored libraries are the review app's; a page with its own module preloads none.
  const preload =
    opts.entry === undefined
      ? Object.entries(IMPORT_MAP.imports)
          .filter(([name]) => !LAZY_IMPORTS.includes(name))
          .map(([, href]) => href)
      : []
  return html`<!doctype html>
<html lang="en" data-skin="${opts.appearance.skin}" data-theme="${opts.appearance.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<link rel="icon" type="image/svg+xml" href="/static/brand.svg">
<link rel="stylesheet" href="/static/styles.css">
<script type="importmap" nonce="${opts.nonce}">${raw(jsonForScript(IMPORT_MAP))}</script>
${opts.app ? preload.map(href => html`<link rel="modulepreload" href="${href}">`) : ''}
${opts.app ? html`<link rel="modulepreload" href="${entry}">` : ''}
<script id="bootstrap" type="application/json" nonce="${opts.nonce}">${raw(jsonForScript(opts.bootstrap))}</script>
</head>
<body>
${opts.body}
${opts.app ? html`<script type="module" src="${entry}"></script>` : ''}
</body>
</html>`
}

/**
 * The page a landmark's scene or micro-world is drawn in. The scene is generated HTML, placed as
 * written with its icons inlined, after the kit's stylesheet and the scene runtime, both inline so
 * the frame loads nothing. Its policy (`sceneFramePolicy`) runs its scripts with no origin and no
 * network. The runtime sizes the frame to `.scene-root` and takes the theme the tour page sends.
 */
export function sceneFrame(opts: {
  scene: string
  skin: string
  theme: 'light' | 'dark' | 'auto'
  kit: string
  runtime: string
}): string {
  return `<!doctype html><html lang="en" data-skin="${opts.skin.replace(/[^\w-]/g, '')}" data-theme="${opts.theme}"><head><meta charset="utf-8"><title>scene</title>
<style>${opts.kit}</style><script>${opts.runtime}</script></head>
<body><main class="scene-root"><div class="scene-fit">${opts.scene}</div></main></body></html>`
}

export function reviewPage(
  page: Omit<ReviewBootstrap, 'host'> & { host: Host },
  nonce: string,
  appearance: Appearance
): Html {
  const bootstrap: ReviewBootstrap = { ...page, host: publicHost(page.host) }
  const key = keyToString(bootstrap.prNumber)
  const what =
    typeof bootstrap.prNumber === 'number' ? `${page.host.nounShort} #${key}` : keyLabel(bootstrap.prNumber)
  return pageShell({
    title: `${what} · ${bootstrap.owner}/${bootstrap.repo} · review canvas`,
    bootstrap,
    nonce,
    appearance,
    app: true,
    body: html`<a class="skip" href="#main">Skip to content</a>
<pr-app class="page" data-pr="${key}"><div class="loading">Loading ${what}…</div></pr-app>`,
  })
}

/** The tour page: its module boots from the bootstrap and fetches the bundle. */
export function tourPage(
  page: Omit<TourBootstrap, 'host'> & { host: Host },
  nonce: string,
  appearance: Appearance
): Html {
  const bootstrap: TourBootstrap = { ...page, host: publicHost(page.host) }
  const key = keyToString(page.key)
  const what = typeof page.key === 'number' ? `${page.host.nounShort} #${key}` : keyLabel(page.key)
  return pageShell({
    title: `Tour · ${what} · ${page.owner}/${page.repo}`,
    bootstrap,
    nonce,
    appearance,
    app: true,
    entry: '/static/js/tour/tour.js',
    body: html`<a class="skip" href="#main">Skip to content</a>
<pr-tour class="page tour-page" data-pr="${key}"><div class="loading">Loading the tour of ${what}…</div></pr-tour>`,
  })
}

export function homePage(
  data: HomeData & {
    owner: string
    repo: string
    version: string
    port: number
    host: Host
    /** The local reviews prepared here, so the home page can link straight to them. */
    localReviews: readonly LocalKey[]
    /** The local reviews with a tour. */
    localTours: readonly LocalKey[]
  },
  nonce: string,
  appearance: Appearance
): Html {
  const { noun, nounShort, label } = data.host
  return pageShell({
    title: 'PR review canvas',
    bootstrap: { owner: data.owner, repo: data.repo, version: data.version, host: publicHost(data.host) },
    nonce,
    appearance,
    app: false,
    body: html`<div class="page">
<header class="hdr">
<div class="hdr-bar"><div class="brand"><span class="brand-wordmark"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</span><span class="mono muted">localhost:${String(data.port)}</span></div>
<div class="hdr-actions"><a class="cmd" href="/api/health">health</a></div></div>
<div class="stripe" aria-hidden="true"></div>
<div class="hdr-title"><div class="title"><h1>${data.owner}/${data.repo}</h1></div>
<p class="meta"><span>Open a ${noun} by number. Diffs come from your local clone; the canvas from a published review.</span></p></div>
</header>
<main id="main" class="home">
<section class="panel"><div class="panel-h"><h2>Open a ${noun}</h2></div>
<form class="body home-form" method="get" action="/review">
<label>${nounShort} number <input name="n" type="number" min="1" required inputmode="numeric"></label>
<button class="cmd fill" type="submit">open</button>
</form></section>
<section class="panel"><div class="panel-h"><h2>Before the ${noun}</h2></div>
<div class="body">${
      data.localReviews.length === 0
        ? html`<p class="muted">Nothing reviewed here yet. Run <code>/pr-review-canvas branch</code> to read the current branch against the default one, or <code>/pr-review-canvas uncommitted</code> to read it with your working-tree edits on top, before opening a ${noun}.</p>`
        : html`<ul class="plain">${data.localReviews.map(
            key =>
              html`<li><a href="/review/${key}">${keyLabel(key)}</a> <span class="muted">/review/${key}</span>${data.localTours.includes(key) ? html` · <a href="/tour/${key}">tour</a>` : ''}</li>`
          )}</ul>`
    }</div></section>
<section class="panel"><div class="panel-h"><h2>Recent</h2></div>
${
  data.recentPrs.length === 0
    ? html`<div class="body muted">No ${noun}s opened yet.</div>`
    : html`<ul class="plain body">${data.recentPrs.map(
        p =>
          html`<li><a href="/review/${String(p.number)}"><span class="mono num">#${String(p.number)}</span> ${p.title}</a>${p.hasCanvas === false ? html` <span class="muted">no canvas yet</span>` : ''}${p.hasTour === true ? html` · <a href="/tour/${String(p.number)}">tour</a>` : ''}</li>`
      )}</ul>`
}
</section>
<section class="panel"><div class="panel-h"><h2>The tour</h2></div>
<div class="body"><p class="muted">The recommended pass before a review: run <code>/pr-tour &lt;number&gt;</code> in your agent, then open <code>/tour/&lt;number&gt;</code> to read the change as landmarks, keep or change its decisions, and take the quiz.</p></div></section>
</main>
<footer><span>pr-review ${data.version}</span><span>local review app · ${label} operations and AI requests contact their services</span></footer>
</div>`,
  })
}

export function errorPage(error: ErrorEnvelope['error'], nonce: string, appearance: Appearance): Html {
  return pageShell({
    title: `Error · ${error.code}`,
    bootstrap: { error },
    nonce,
    appearance,
    app: false,
    body: html`<div class="page"><header class="hdr">
<div class="hdr-bar"><div class="brand"><span class="brand-wordmark"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</span></div><div class="hdr-actions"><a class="cmd" href="/">home</a></div></div>
<div class="stripe" aria-hidden="true"></div></header>
<main id="main" class="home"><section class="panel error-card"><div class="panel-h"><h2><span class="mono">${error.code}</span></h2></div>
<div class="body"><p>${error.message}</p>${error.hint ? html`<p class="muted">${error.hint}</p>` : ''}</div></section></main></div>`,
  })
}
