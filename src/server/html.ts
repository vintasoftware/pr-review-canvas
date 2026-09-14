import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { ErrorEnvelope, HomeData } from '../contract/api.js'
import type { Appearance } from '../contract/settings.js'

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
  /** The nonce of this response's Content-Security-Policy; the inline scripts carry it. */
  nonce: string
  /** How this page is painted, from the settings file or this request's `?skin` and `?theme`. */
  appearance: Appearance
}

export function pageShell(opts: PageOptions): Html {
  const preload = Object.entries(IMPORT_MAP.imports)
    .filter(([name]) => !LAZY_IMPORTS.includes(name))
    .map(([, href]) => href)
  return html`<!doctype html>
<html lang="en" data-skin="${opts.appearance.skin}" data-theme="${opts.appearance.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<link rel="stylesheet" href="/static/styles.css">
<script type="importmap" nonce="${opts.nonce}">${raw(jsonForScript(IMPORT_MAP))}</script>
${opts.app ? preload.map(href => html`<link rel="modulepreload" href="${href}">`) : ''}
${opts.app ? html`<link rel="modulepreload" href="/static/js/app.js">` : ''}
<script id="bootstrap" type="application/json" nonce="${opts.nonce}">${raw(jsonForScript(opts.bootstrap))}</script>
</head>
<body>
${opts.body}
${opts.app ? html`<script type="module" src="/static/js/app.js"></script>` : ''}
</body>
</html>`
}

export function reviewPage(
  bootstrap: { prNumber: number; owner: string; repo: string; version: string },
  nonce: string,
  appearance: Appearance
): Html {
  return pageShell({
    title: `PR #${bootstrap.prNumber} · ${bootstrap.owner}/${bootstrap.repo} · review canvas`,
    bootstrap,
    nonce,
    appearance,
    app: true,
    body: html`<a class="skip" href="#main">Skip to content</a>
<pr-app class="page" data-pr="${String(bootstrap.prNumber)}"><div class="loading">Loading PR #${String(bootstrap.prNumber)}…</div></pr-app>`,
  })
}

export function homePage(
  data: HomeData & { owner: string; repo: string; version: string; port: number },
  nonce: string,
  appearance: Appearance
): Html {
  return pageShell({
    title: 'PR review canvas',
    bootstrap: { owner: data.owner, repo: data.repo, version: data.version },
    nonce,
    appearance,
    app: false,
    body: html`<div class="page">
<header class="hdr">
<div class="hdr-bar"><div class="brand"><span class="box">PR review canvas</span><span class="mono muted">localhost:${String(data.port)}</span></div>
<div class="hdr-actions"><a class="cmd" href="/api/health">health</a></div></div>
<div class="stripe" aria-hidden="true"></div>
<div class="hdr-title"><div class="title"><h1>${data.owner}/${data.repo}</h1></div>
<p class="meta"><span>Open a pull request by number. Diffs come from your local clone; the canvas from a published review.</span></p></div>
</header>
<main id="main" class="home">
<section class="panel"><div class="panel-h"><h2>Open a pull request</h2></div>
<form class="body home-form" method="get" action="/review">
<label>PR number <input name="n" type="number" min="1" required inputmode="numeric"></label>
<button class="cmd fill" type="submit">open</button>
</form></section>
<section class="panel"><div class="panel-h"><h2>Recent</h2></div>
${
  data.recentPrs.length === 0
    ? html`<div class="body muted">No pull requests opened yet.</div>`
    : html`<ul class="plain body">${data.recentPrs.map(
        p =>
          html`<li><a href="/review/${String(p.number)}"><span class="mono num">#${String(p.number)}</span> ${p.title}</a></li>`
      )}</ul>`
}
</section>
</main>
<footer><span>pr-review ${data.version}</span><span>localhost only · nothing leaves this machine except GitHub posts you confirm</span></footer>
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
<div class="hdr-bar"><div class="brand"><span class="box">PR review canvas</span></div><div class="hdr-actions"><a class="cmd" href="/">home</a></div></div>
<div class="stripe" aria-hidden="true"></div></header>
<main id="main" class="home"><section class="panel error-card"><div class="panel-h"><h2><span class="mono">${error.code}</span></h2></div>
<div class="body"><p>${error.message}</p>${error.hint ? html`<p class="muted">${error.hint}</p>` : ''}</div></section></main></div>`,
  })
}
