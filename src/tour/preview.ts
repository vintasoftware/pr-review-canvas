// The preview loop's browser: a Chrome-family browser already on this machine takes a screenshot
// of a page this server serves, so a generator can look at a landmark instead of writing it blind.
// Which pages, and where the pictures go, is the tour's business (`pr-review tour preview`).
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { findOnPath } from '../acpx/acpx.js'
import type { AppContext } from '../server/context.js'

export interface Viewport {
  width: number
  height: number
}

/**
 * The desktop the tour's stage is drawn for: the prose is 760 pixels wide, the pictures up to
 * 1120, and the window is tall enough to hold the title, the lead, and the picture under them.
 */
export const PREVIEW_VIEWPORT: Viewport = { width: 1280, height: 1400 }
/** A phone, where a scene must still read: the design promises phone parity. */
export const PHONE_VIEWPORT: Viewport = { width: 390, height: 1600 }
/** A picture alone, at the width the desktop page gives it, so a tall one is seen whole. */
export const FIGURE_VIEWPORT: Viewport = { width: 1120, height: 1400 }
/**
 * A picture alone at the width a phone page gives it: a phone page is taller than any window, so
 * this is where the phone composition of a picture is seen whole.
 */
export const FIGURE_PHONE_VIEWPORT: Viewport = { width: 350, height: 2400 }

/** A running copy of the review server that the browser loads the preview from. */
export interface PreviewServer {
  origin: string
  close(): Promise<void>
}

export interface PreviewDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  startServer(ctx: AppContext): Promise<PreviewServer>
  /** Loads `url` in the browser at the viewport, and writes what it shows to `file`. */
  screenshot(browser: string, url: string, file: string, viewport: Viewport): Promise<void>
}

/** Where each platform keeps the browsers tried, after `PR_REVIEW_BROWSER` and the PATH. */
function installedBrowsers(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'].map(
      app => `/Applications/${app}.app/Contents/MacOS/${app}`
    )
  }
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(
      (root): root is string => root !== undefined
    )
    return roots.flatMap(root => [
      path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  }
  return []
}

/** Names a Chrome-family browser goes by on a PATH. */
const BROWSER_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
  'brave-browser',
]

/** The browser to take screenshots with: `PR_REVIEW_BROWSER`, else the first one installed. */
export function findBrowser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const chosen = env['PR_REVIEW_BROWSER']
  if (chosen !== undefined && chosen !== '') {
    return chosen
  }
  for (const name of BROWSER_NAMES) {
    const found = findOnPath(name, env)
    if (found !== null) return found
  }
  for (const file of installedBrowsers(platform, env)) {
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      // Not installed there.
    }
  }
  return null
}

/** What to tell a generator when no browser is found. */
export const NO_BROWSER_HINT =
  'install Chrome, Chromium, or Edge, or set PR_REVIEW_BROWSER to one; or run `pr-review serve` and open previewUrl in a browser tool'

export interface PreviewTourResult {
  status: 'previewed' | 'no-browser' | 'no-page'
  headSha: string
  landmarks: number
  /**
   * Per landmark in tour order: the page on a desktop and on a phone, then each picture alone at
   * the width a desktop and a phone give it (the scene, then the micro-world). For the whole tour,
   * then each decision and each question on a desktop. Empty without a browser.
   */
  screenshots: string[]
  /**
   * Without a browser, the same preview on a running `pr-review serve`, for a browser tool. Absent
   * once screenshots are taken: they come from a server of their own, gone when preview ends.
   */
  previewUrl?: string
  hint?: string
}

/**
 * Screenshots every landmark of the tour as written, on a desktop and on a phone. Validation runs
 * first, so an invalid tour throws its problems as `tour publish` would. Without a browser, or for
 * a change set that has no page, it says where to look instead.
 */
export async function previewTour(
  ctx: AppContext,
  tourDir: string,
  deps: PreviewDeps,
  opts: { landmark?: string | undefined } = {}
): Promise<PreviewTourResult> {
  const { readTourContext, readTourModel, tourValidationInput, TourInvalidError } =
    await import('./publish.js')
  const { validateTourModel } = await import('./validate.js')
  const context = await readTourContext(tourDir)
  const model = await readTourModel(context)
  const result =
    'error' in model
      ? {
          ok: false as const,
          errors: [{ code: 'SCHEMA' as const, where: '(root)', message: model.error.message }],
          output: null,
        }
      : validateTourModel(model.raw, tourValidationInput(context))
  if (!result.ok || result.output === null)
    throw new TourInvalidError({ ok: false, errors: result.errors }, 0)
  // Each landmark keeps its place in the tour, so a retake of one is numbered as the whole run is.
  const landmarks = result.output.landmarks
    .map((landmark, i) => ({ landmark, n: String(i + 1).padStart(2, '0') }))
    .filter(({ landmark }) => opts.landmark === undefined || landmark.id === opts.landmark)
  const key =
    context.target.kind === 'pr'
      ? String(context.target.number)
      : context.target.kind === 'local'
        ? context.target.source
        : null
  const base = { headSha: context.headSha, landmarks: landmarks.length }
  if (key === null) {
    return {
      ...base,
      status: 'no-page',
      screenshots: [],
      hint: 'a --base/--head tour has no page; publish it and open it once a pull request exists',
    }
  }
  const previewUrl = `http://localhost:${ctx.config.port}${ctx.config.basePath}tour/${key}?preview`
  const browser = findBrowser(deps.env, deps.platform)
  if (browser === null)
    return { ...base, status: 'no-browser', screenshots: [], previewUrl, hint: NO_BROWSER_HINT }
  const dir = path.join(tourDir, 'preview')
  // A whole run starts over; a retake of one landmark replaces only that landmark's pictures.
  if (opts.landmark === undefined) {
    await rm(dir, { recursive: true, force: true })
  } else {
    for (const { n, landmark } of landmarks) {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith(`${n}-${landmark.id}-`)) await rm(path.join(dir, name), { force: true })
      }
    }
  }
  await mkdir(dir, { recursive: true })
  const server = await deps.startServer(ctx)
  const screenshots: string[] = []
  try {
    for (const { n, landmark } of landmarks) {
      const id = encodeURIComponent(landmark.id)
      const page = `${server.origin}/tour/${key}?preview&landmark=${id}&theme=light`
      const picture = (kind: 'scene' | 'micro') =>
        `${server.origin}/tour-scene/${key}/${id}/${kind}?preview&theme=light`
      const shots: Array<readonly [string, string, Viewport]> = [
        ['desktop', page, PREVIEW_VIEWPORT],
        ['phone', page, PHONE_VIEWPORT],
        ...(['scene', 'micro'] as const)
          .filter(kind => typeof landmark[kind] === 'string')
          .flatMap(kind => [
            [kind, picture(kind), FIGURE_VIEWPORT] as const,
            [`${kind}-phone`, picture(kind), FIGURE_PHONE_VIEWPORT] as const,
          ]),
      ]
      for (const [name, url, viewport] of shots) {
        const file = path.join(dir, `${n}-${landmark.id}-${name}.png`)
        await deps.screenshot(browser, url, file, viewport)
        screenshots.push(file)
      }
    }
    // The whole tour also shows each decision and question once, so their texts are seen too.
    if (opts.landmark === undefined) {
      const steps = [
        ...result.output.decisions.map((d, i) => [`d${i + 1}-${d.key}`, `decision-${d.key}`] as const),
        ...result.output.quiz.map((q, i) => [`q${i + 1}-${q.id}`, `quiz-${q.id}`] as const),
      ]
      for (const [name, hash] of steps) {
        const file = path.join(dir, `${name}.png`)
        await deps.screenshot(
          browser,
          `${server.origin}/tour/${key}?preview&theme=light#${hash}`,
          file,
          PREVIEW_VIEWPORT
        )
        screenshots.push(file)
      }
    }
  } finally {
    await server.close()
  }
  return { ...base, status: 'previewed', screenshots }
}

const run = promisify(execFile)

/**
 * One headless run of the browser per page, in a profile of its own that is removed after. Reduced
 * motion shows each scene at rest, the state that has to read on its own, and the virtual time
 * budget lets the frames load and size themselves before the picture is taken.
 */
export async function headlessScreenshot(
  browser: string,
  url: string,
  file: string,
  viewport: Viewport = PREVIEW_VIEWPORT
): Promise<void> {
  const profile = await mkdtemp(path.join(tmpdir(), 'pr-review-preview-'))
  try {
    await run(
      browser,
      [
        '--headless',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        '--force-prefers-reduced-motion',
        // A scene's frame has no origin, so Chrome would draw it in a process of its own, which the
        // virtual time budget does not wait for: the shot then catches the frame before it sizes
        // itself. In one process, the frames load, report their heights, and paint within the budget.
        '--disable-site-isolation-trials',
        '--disable-features=IsolateOrigins,site-per-process',
        `--user-data-dir=${profile}`,
        `--window-size=${viewport.width},${viewport.height}`,
        '--virtual-time-budget=10000',
        `--screenshot=${file}`,
        url,
      ],
      { timeout: 60_000 }
    )
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
