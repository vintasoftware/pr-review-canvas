// Checks a side's scene before it is published. A scene runs in a frame that allows
// no script and no network (sceneFramePolicy), and that is the boundary; these checks name what
// the frame would silently drop, so the generator fixes it instead of the author seeing a gap.
import { iconSvg } from './icons.js'

/** Elements a scene has no use for: they run code, load something, or leave the frame. */
const FORBIDDEN_TAGS =
  /<\s*(script|iframe|frame|object|embed|link|meta|base|form|input|button|textarea|select|video|audio|img|picture|source|canvas|style|template|slot)\b/gi

/** The icons a scene names, as `<i data-icon="name"></i>`. */
export function sceneIcons(html: string): string[] {
  return [...html.matchAll(/<i\b[^>]*\bdata-icon\s*=\s*["']([^"']*)["'][^>]*>/gi)].map(m => m[1] as string)
}

/** What is wrong with a scene, one sentence each; empty when it may be published. */
export function sceneProblems(html: string): string[] {
  const problems: string[] = []
  const tags = new Set([...html.matchAll(FORBIDDEN_TAGS)].map(m => (m[1] as string).toLowerCase()))
  if (tags.size > 0) {
    problems.push(
      `uses <${[...tags].join('>, <')}>; a scene is text, the kit's classes, icons, and inline SVG`
    )
  }
  if (/\son[a-z]+\s*=/i.test(html)) {
    problems.push('has an event handler attribute; the frame runs no script')
  }
  if (/url\s*\(|@import|javascript:|expression\s*\(/i.test(html)) {
    problems.push('loads something (url(), @import, or javascript:); the frame loads nothing')
  }
  const refs = [...html.matchAll(/\s(?:href|src|xlink:href|action|srcset)\s*=\s*["']?([^"'\s>]*)/gi)]
    .map(m => m[1] as string)
    .filter(ref => !ref.startsWith('#'))
  if (refs.length > 0) {
    problems.push(`links to ${refs.slice(0, 3).join(', ')}; a scene links nowhere`)
  }
  const unknown = [...new Set(sceneIcons(html).filter(name => iconSvg(name) === null))]
  if (unknown.length > 0) {
    problems.push(
      `names icons that do not exist: ${unknown.join(', ')} (Lucide names, such as database or circle-x)`
    )
  }
  if (!/<[a-z]/i.test(html) || html.replace(/<[^>]*>/g, '').trim() === '') {
    problems.push('shows no text; a scene says what happens, with words the reader can take in')
  }
  return problems
}
