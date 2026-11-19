// The static viewer's entry. With `?pr=<owner>/<repo>/<number>` it answers the review page's
// /api calls in the browser (viewer-api.ts) and boots the same app module the local server
// serves; without one it shows a form that asks for a public pull request.
import { version } from '../package.json'
import type { ReviewBootstrap } from '../src/contract/api.js'
import { type Appearance, DEFAULT_SETTINGS } from '../src/contract/settings.js'
import { isSkin } from '../static/js/skin.js'
import { isTheme } from '../static/js/theme.js'
import { createBrowserGithub } from './github-client.js'
import { createViewerState } from './review-state.js'
import { parseTarget } from './target.js'
import { createViewerApi, type ViewerTarget } from './viewer-api.js'

/** The page's API base. Nothing is served here: the fetch below answers it. */
const API_BASE = '/__viewer/'
const APPEARANCE_KEY = 'pr-review-viewer:appearance'

function readAppearance(): Appearance {
  const fallback: Appearance = { skin: DEFAULT_SETTINGS.skin, theme: DEFAULT_SETTINGS.theme }
  try {
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? 'null') as Partial<Appearance> | null
    return {
      skin: isSkin(stored?.skin) ? stored.skin : fallback.skin,
      theme: isTheme(stored?.theme) ? stored.theme : fallback.theme,
    }
  } catch {
    return fallback
  }
}

function saveAppearance(input: Partial<Appearance>): Appearance {
  const next = { ...readAppearance(), ...input }
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next))
  } catch {
    // Kept for this page only.
  }
  return next
}

function bootstrapFor(target: ViewerTarget): ReviewBootstrap {
  const s = DEFAULT_SETTINGS
  return {
    prNumber: target.number,
    owner: target.owner,
    repo: target.repo,
    project: `${target.owner}/${target.repo}`,
    base: API_BASE,
    version,
    host: { kind: 'github', label: 'GitHub', webBase: 'https://github.com' },
    foldLevel: s.foldLevel,
    diffLayout: s.diffLayout,
    layerView: s.layerView,
    readByPoints: s.readByPoints,
    pointColors: s.pointColors,
    startCollapsed: s.startCollapsed,
    backgroundOpen: s.backgroundOpen,
    compactPoints: s.compactPoints,
    fullWidthText: s.fullWidthText,
    hideInline: s.hideInline,
    hideInlineKinds: s.hideInlineKinds,
    hiddenItemClick: s.hiddenItemClick,
  }
}

/** Routes the page's calls under API_BASE to the viewer's API; every other request goes out as is. */
function installApi(handle: ReturnType<typeof createViewerApi>['handle'], realFetch: typeof fetch): void {
  window.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, location.href)
    if (url.origin !== location.origin || !url.pathname.startsWith(API_BASE)) {
      return realFetch(input, init)
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = null
      }
    }
    const apiUrl = new URL(`/${url.pathname.slice(API_BASE.length)}${url.search}`, location.origin)
    const answer =
      apiUrl.pathname === '/api/appearance' && method === 'PUT'
        ? { status: 200, body: saveAppearance((body ?? {}) as Partial<Appearance>) }
        : await handle(method, apiUrl, body)
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function renderLanding(error: string | null): void {
  document.title = 'PR review canvas viewer'
  const example = 'vintasoftware/pr-review-canvas/123'
  document.body.innerHTML = `<main class="viewer-landing">
  <h1><img src="/static/brand.svg" width="32" height="32" alt=""> PR review canvas viewer</h1>
  <p>Open the canvas published on a public GitHub pull request. Nothing to install: the page reads
  the pull request from GitHub's public API, and your review marks stay in this browser.</p>
  <form class="viewer-form" method="get">
    <label for="pr">Pull request</label>
    <input id="pr" name="pr" required placeholder="https://github.com/owner/repo/pull/123" autocomplete="off">
    <button class="cmd" type="submit">open</button>
  </form>
  ${error === null ? '' : '<p class="viewer-error" role="alert"></p>'}
  <p class="muted">For example <a href="?pr=${example}">${example}</a>. Private repositories, comments
  and AI chat need the local app: <code>pr-review serve</code>.</p>
</main>`
  const alert = document.querySelector('.viewer-error')
  if (alert !== null && error !== null) alert.textContent = error
}

async function main(): Promise<void> {
  const appearance = readAppearance()
  document.documentElement.dataset['skin'] = appearance.skin
  document.documentElement.dataset['theme'] = appearance.theme

  const raw = new URL(location.href).searchParams.get('pr')
  const target = parseTarget(raw)
  if (target === null) {
    renderLanding(
      raw === null ? null : `"${raw}" is not a GitHub pull request; use owner/repo/123 or its URL`
    )
    return
  }

  const realFetch = window.fetch.bind(window)
  const key = `github/${target.owner}/${target.repo}/${target.number}`.toLowerCase()
  const api = createViewerApi(target, {
    gh: createBrowserGithub({ fetchImpl: realFetch }),
    state: createViewerState(key),
  })
  installApi(api.handle, realFetch)

  document.title = `PR #${target.number} · ${target.owner}/${target.repo} · review canvas`
  const bootstrap = document.createElement('script')
  bootstrap.id = 'bootstrap'
  bootstrap.type = 'application/json'
  bootstrap.textContent = JSON.stringify(bootstrapFor(target))
  document.head.append(bootstrap)
  document.body.innerHTML = `<a class="skip" href="#main">Skip to content</a>
<pr-app class="page" data-pr="${target.number}"><div class="loading">Loading PR #${target.number}…</div></pr-app>`
  await import('../static/js/app.js')
}

void main()
