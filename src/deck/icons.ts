// The icons a card may use, by Lucide name (lucide-static, ISC). They are files of this package's
// dependencies, never generated, so their markup is trusted; a card names an icon and the server
// inlines it, which keeps the deck page and the scene frame free of any icon request.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ICON_DIR = path.join(path.dirname(require.resolve('lucide-static/package.json')), 'icons')

/** Lucide names are lowercase words joined by hyphens, which also keeps them out of path tricks. */
export const ICON_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const cache = new Map<string, string | null>()

/** The icon's SVG, sized by the text around it and drawn in its color; null when there is none. */
export function iconSvg(name: string): string | null {
  if (!ICON_NAME_RE.test(name)) return null
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  let svg: string | null
  try {
    svg = readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+class="[^"]*"/, ` class="icon" aria-hidden="true"`)
      .replace(/\s+width="24"\s+height="24"/, '')
      .replace(/\s*\n\s*/g, ' ')
      .trim()
  } catch {
    svg = null
  }
  cache.set(name, svg)
  return svg
}

/** The SVG of every icon named, for the names that exist. */
export function iconsFor(names: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const svg = iconSvg(name)
    if (svg !== null) out[name] = svg
  }
  return out
}
