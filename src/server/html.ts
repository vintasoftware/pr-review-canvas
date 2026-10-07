import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { ErrorEnvelope, HomeData, ReviewBootstrap } from '../contract/api.js'
import { keyLabel, keyToString, LOCAL_KEYS, type LocalKey } from '../contract/review-key.js'
import type { Appearance } from '../contract/settings.js'
import { type Host, publicHost } from '../host/host.js'
import { esc } from '../../static/js/dom.js'
import { headerBarHtml, type ProjectLink } from '../../static/js/header-bar.js'
import { basePathOf, slugParts } from '../hub/slug.js'

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
  /** Modules of its own, for a page that loads no app: the skin and theme commands, and more. */
  scripts?: readonly string[]
}

/** The module that runs the skin and theme commands of the pages with no app. */
const PAGE_APPEARANCE_SCRIPT = '/static/js/page-appearance.js'
/** The module behind the project list's remove commands. */
const PROJECTS_PAGE_SCRIPT = '/static/js/projects-page.js'

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
<link rel="icon" type="image/svg+xml" href="/static/brand.svg">
<link rel="stylesheet" href="/static/styles.css">
<script type="importmap" nonce="${opts.nonce}">${raw(jsonForScript(IMPORT_MAP))}</script>
${opts.app ? preload.map(href => html`<link rel="modulepreload" href="${href}">`) : ''}
${opts.app ? html`<link rel="modulepreload" href="/static/js/app.js">` : ''}
<script id="bootstrap" type="application/json" nonce="${opts.nonce}">${raw(jsonForScript(opts.bootstrap))}</script>
</head>
<body>
${opts.body}
${opts.app ? html`<script type="module" src="/static/js/app.js"></script>` : ''}
${(opts.scripts ?? []).map(src => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`
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

/** The home page's link that generates the first canvas of a local review. */
const LOCAL_GENERATE: Record<LocalKey, string> = {
  branch: 'generate for this branch',
  uncommitted: 'generate for uncommitted work',
}

export function homePage(
  data: HomeData & {
    owner: string
    repo: string
    version: string
    /** The project as the header names it. */
    project: ProjectLink
    /** The project's base path on the server, with a trailing slash. */
    base: string
    host: Host
    /** The local reviews prepared here, so the home page can link straight to them. */
    localReviews: readonly LocalKey[]
    /** An agent can run here, so the page offers to generate a canvas as well as to open one. */
    canGenerate: boolean
  },
  nonce: string,
  appearance: Appearance
): Html {
  const { noun, nounShort, label } = data.host
  return pageShell({
    title: 'PR review canvas',
    bootstrap: {
      owner: data.owner,
      repo: data.repo,
      base: data.base,
      version: data.version,
      host: publicHost(data.host),
    },
    nonce,
    appearance,
    app: false,
    scripts: [PAGE_APPEARANCE_SCRIPT],
    body: html`<div class="page">
<header class="hdr">
${raw(headerBarHtml({ project: data.project, ...appearance }, `<a class="cmd" id="health" href="${esc(data.base)}api/health" title="Check git, the host login, and the chat agent for this project">health</a>`))}
<div class="stripe" aria-hidden="true"></div>
<div class="hdr-title"><div class="title"><h1>${data.owner}/${data.repo}</h1></div>
<p class="meta"><span>Open a ${noun} by number. Diffs come from your local clone; the canvas from a published review.</span></p></div>
</header>
<main id="main" class="home">
<section class="panel"><div class="panel-h"><h2>Open a ${noun}</h2></div>
<form class="body home-form" method="get" action="${data.base}review">
<label>${nounShort} number <input name="n" type="number" min="1" required inputmode="numeric"></label>
<button class="cmd fill" type="submit">open</button>
${data.canGenerate ? html`<button class="cmd" type="submit" name="generate" value="1" title="Open the ${noun} and generate its canvas with the chat agent">generate canvas</button>` : ''}
</form></section>
<section class="panel"><div class="panel-h"><h2>Before the ${noun}</h2></div>
<div class="body">${
      data.localReviews.length === 0
        ? html`<p class="muted">Nothing reviewed here yet. Run <code>/pr-review-canvas branch</code> to read the current branch against the default one, or <code>/pr-review-canvas uncommitted</code> to read it with your working-tree edits on top, before opening a ${noun}.</p>`
        : html`<ul class="plain">${data.localReviews.map(
            key =>
              html`<li><a href="${data.base}review/${key}">${keyLabel(key)}</a> <span class="muted">${data.base}review/${key}</span></li>`
          )}</ul>`
    }${
      // Each local review not started here yet can be, whether or not the other one was.
      data.canGenerate && data.localReviews.length < LOCAL_KEYS.length
        ? html`<p class="tbtns">${LOCAL_KEYS.filter(key => !data.localReviews.includes(key)).map(
            key => html`<a class="cmd" href="${data.base}review/${key}?generate=1">${LOCAL_GENERATE[key]}</a>`
          )}</p>`
        : ''
    }</div></section>
<section class="panel"><div class="panel-h"><h2>Recent</h2></div>
${
  data.recentPrs.length === 0
    ? html`<div class="body muted">No ${noun}s opened yet.</div>`
    : html`<ul class="plain body">${data.recentPrs.map(
        p =>
          html`<li><a href="${data.base}review/${String(p.number)}"><span class="mono num">#${String(p.number)}</span> ${p.title}</a>${p.hasCanvas === false ? html` <span class="muted">no canvas yet</span>${data.canGenerate ? html` <a class="cmd" href="${data.base}review/${String(p.number)}?generate=1">generate</a>` : ''}` : ''}</li>`
      )}</ul>`
}
</section>
</main>
<footer><span>pr-review ${data.version}</span><span>local review app · ${label} operations and AI requests contact their services</span></footer>
</div>`,
  })
}

/** One checkout the server serves, as the project list shows it. */
export interface ListedProject {
  slug: string
  repoRoot: string
  /** `repoRoot` as the list prints it, with the home folder written `~`. */
  shownPath: string
}

/**
 * The checkouts grouped by repository, repositories by name: in each, the main checkout first,
 * then the linked worktrees by folder name.
 */
export function groupProjects(
  projects: readonly ListedProject[]
): { repo: string; checkouts: { worktree: string | null; project: ListedProject }[] }[] {
  const groups = new Map<string, { worktree: string | null; project: ListedProject }[]>()
  for (const project of projects) {
    const { repo, worktree } = slugParts(project.slug)
    groups.set(repo, [...(groups.get(repo) ?? []), { worktree, project }])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, checkouts]) => ({
      repo,
      checkouts: checkouts.sort((a, b) =>
        a.worktree === null ? -1 : b.worktree === null ? 1 : a.worktree.localeCompare(b.worktree)
      ),
    }))
}

/** The server's root: every checkout it serves, one panel per repository. */
export function projectsPage(
  data: {
    version: string
    port: number
    projects: readonly ListedProject[]
  },
  nonce: string,
  appearance: Appearance
): Html {
  const groups = groupProjects(data.projects)
  return pageShell({
    title: 'PR review canvas',
    bootstrap: { base: '/', version: data.version },
    nonce,
    appearance,
    app: false,
    scripts: [PAGE_APPEARANCE_SCRIPT, PROJECTS_PAGE_SCRIPT],
    body: html`<div class="page">
<header class="hdr">
${raw(headerBarHtml({ host: `localhost:${String(data.port)}`, ...appearance }, '<a class="cmd" id="health" href="/api/health" title="The server version, its port, and the projects it serves">health</a>'))}
<div class="stripe" aria-hidden="true"></div>
<div class="hdr-title"><div class="title"><h1>Projects</h1></div>
<p class="meta"><span>Every checkout this server serves, by repository. Run <code>pr-review open</code> in a project's folder to add it.</span></p></div>
</header>
<main id="main" class="home">
${
  groups.length === 0
    ? html`<section class="panel"><div class="panel-h"><h2>No projects yet</h2></div>
<div class="body"><p>Run <code>pr-review open</code> in a project's folder. It adds the project here and opens its review.</p></div></section>`
    : groups.map(
        group => html`<section class="panel project-group"><div class="panel-h"><h2>${group.repo}</h2><span class="muted">${String(group.checkouts.length)} ${group.checkouts.length === 1 ? 'checkout' : 'checkouts'}</span></div>
<ul class="project-list">${group.checkouts.map(
          ({ worktree, project }) =>
            html`<li class="project-row"><div class="project-main"><a class="project-name" href="${basePathOf(project.slug)}">${worktree ?? 'main checkout'}</a>${worktree === null ? '' : html` <span class="pill">worktree</span>`}<span class="project-path mono muted" title="${project.repoRoot}">${project.shownPath}</span></div><button class="cmd project-remove" type="button" data-remove="${project.slug}" title="Take ${project.slug} off this list. Its canvases and review state stay in its .pr-review folder, and pr-review open adds it again.">remove</button></li>`
        )}</ul></section>`
      )
}
<p class="muted project-note">A checkout whose folder is gone leaves the list by itself. Removing one keeps its canvases and review state.</p>
</main>
<footer><span>pr-review ${data.version}</span><span>local review app</span></footer>
</div>`,
  })
}

/** `project` is the project the error is in; null for an error of the server's own. */
export function errorPage(
  error: ErrorEnvelope['error'],
  nonce: string,
  appearance: Appearance,
  project: ProjectLink | null = null
): Html {
  return pageShell({
    title: `Error · ${error.code}`,
    bootstrap: { error, base: project === null ? '/' : project.home },
    nonce,
    appearance,
    app: false,
    scripts: [PAGE_APPEARANCE_SCRIPT],
    body: html`<div class="page"><header class="hdr">
${raw(headerBarHtml({ project: project ?? undefined, ...appearance }))}
<div class="stripe" aria-hidden="true"></div></header>
<main id="main" class="home"><section class="panel error-card"><div class="panel-h"><h2><span class="mono">${error.code}</span></h2></div>
<div class="body"><p>${error.message}</p>${error.hint ? html`<p class="muted">${error.hint}</p>` : ''}</div></section></main></div>`,
  })
}
