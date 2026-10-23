// The scene gallery the generation skill looks at before drawing: real pull requests drawn well.
// It ships as HTML beside the scene guide and is drawn into pictures on demand, by the same browser
// the preview uses, so the skill copy a project installs carries no images.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PACKAGE_ROOT } from '../paths.js'
import { sceneFrame } from '../server/html.js'
import { FIGURE_VIEWPORT, findBrowser, NO_BROWSER_HINT, type PreviewDeps } from './preview.js'
import { inlineIcons } from './scene.js'

/** Where the gallery ships: `<slug>.scene.html` and `<slug>.micro.html`, and a README. */
export const GALLERY_DIR = path.join(PACKAGE_ROOT, 'skills', 'pr-tour', 'gallery')

export interface GalleryEntry {
  slug: string
  kind: 'scene' | 'micro'
  file: string
}

/** The entries in the gallery directory, by slug. */
export async function galleryEntries(dir: string = GALLERY_DIR): Promise<GalleryEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .map(name => /^([a-z0-9][a-z0-9-]*)\.(scene|micro)\.html$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ slug: m[1] as string, kind: m[2] as 'scene' | 'micro', file: path.join(dir, m[0]) }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

export interface GalleryResult {
  status: 'listed' | 'rendered' | 'no-browser' | 'unknown'
  /** Every entry when listing or naming an unknown one; else the ones asked for, with pictures. */
  entries: Array<{ slug: string; kind: 'scene' | 'micro'; png?: string }>
  readme: string
  hint?: string
}

export interface GalleryOptions {
  dir?: string
  /** Where the pictures go: `tour gallery` passes the data dir's `gallery` folder. */
  outDir: string
}

/**
 * With no slugs, the gallery's entries. With slugs, each entry drawn at the width the tour page
 * gives a picture, at rest, as `<outDir>/<slug>.png`, for a generator to look at.
 */
export async function renderGallery(
  slugs: readonly string[],
  deps: Pick<PreviewDeps, 'env' | 'platform' | 'screenshot'>,
  opts: GalleryOptions
): Promise<GalleryResult> {
  const dir = opts.dir ?? GALLERY_DIR
  const all = await galleryEntries(dir)
  const readme = path.join(dir, 'README.md')
  if (slugs.length === 0) {
    return { status: 'listed', entries: all.map(({ slug, kind }) => ({ slug, kind })), readme }
  }
  const unknown = slugs.filter(s => !all.some(e => e.slug === s))
  if (unknown.length > 0) {
    return {
      status: 'unknown',
      entries: all.map(({ slug, kind }) => ({ slug, kind })),
      readme,
      hint: `no gallery entry ${unknown.join(', ')}; pick from the entries listed`,
    }
  }
  const wanted = slugs.map(s => all.find(e => e.slug === s) as GalleryEntry)
  const browser = findBrowser(deps.env, deps.platform)
  if (browser === null) {
    return {
      status: 'no-browser',
      entries: wanted.map(({ slug, kind }) => ({ slug, kind })),
      readme,
      hint: `${NO_BROWSER_HINT}; or open the HTML files beside the README in a browser tool`,
    }
  }
  const { outDir } = opts
  await mkdir(outDir, { recursive: true })
  const [kit, runtime] = await Promise.all([
    readFile(path.join(PACKAGE_ROOT, 'static', 'styles', 'scene.css'), 'utf8'),
    readFile(path.join(PACKAGE_ROOT, 'static', 'js', 'scene-runtime.js'), 'utf8'),
  ])
  const entries: GalleryResult['entries'] = []
  for (const entry of wanted) {
    const scene = inlineIcons(await readFile(entry.file, 'utf8'))
    const frame = path.join(outDir, `${entry.slug}.frame.html`)
    await writeFile(frame, sceneFrame({ scene, theme: 'light', kit, runtime }), 'utf8')
    const png = path.join(outDir, `${entry.slug}.png`)
    await deps.screenshot(browser, pathToFileURL(frame).href, png, FIGURE_VIEWPORT)
    entries.push({ slug: entry.slug, kind: entry.kind, png })
  }
  return { status: 'rendered', entries, readme }
}
