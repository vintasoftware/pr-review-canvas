// Checks a landmark's scene or micro-world before it is published. Both run in a frame with no
// origin and no network (sceneFramePolicy), and that is the boundary; these checks name what the
// frame would block or drop, so the generator fixes it instead of the reader seeing a gap.
import { iconSvg } from './icons.js'

/** Elements neither has a use for: they load something, submit, or leave the frame. */
const FORBIDDEN_TAGS =
  /<\s*(iframe|frame|object|embed|link|meta|base|form|video|audio|img|picture|source)\b/gi

/** Controls. A micro-world takes input through them; a scene is watched and takes none. */
const INPUT_TAGS = /<\s*(input|button|textarea|select)\b/gi

/** A scene's inline scripts, with their bodies. */
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi

/**
 * What a scene's scripts may not use, because the frame blocks it: the network, loading code,
 * eval, workers, and storage. The frame is the boundary; naming these catches the attempt early.
 */
const BLOCKED_APIS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\b(?:webkit)?RTCPeerConnection\b/, 'RTCPeerConnection'],
  [/\bWebTransport\b/, 'WebTransport'],
  [/\bimport\s*\(|\bimportScripts\b/, 'import()'],
  [/\b(?:Shared)?Worker\s*\(|\bserviceWorker\b/, 'workers'],
  [/\beval\s*\(|\bFunction\s*\(/, 'eval'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b/, 'storage'],
]

export interface SceneChecks {
  /** A micro-world: the reader works its controls, so form controls are allowed. */
  interactive?: boolean
}

/** The icons a scene names, as `<i data-icon="name"></i>`. */
export function sceneIcons(html: string): string[] {
  return [...html.matchAll(/<i\b[^>]*\bdata-icon\s*=\s*["']([^"']*)["'][^>]*>/gi)].map(m => m[1] as string)
}

/** What is wrong with a scene or a micro-world, one sentence each; empty when it may be published. */
export function sceneProblems(html: string, checks: SceneChecks = {}): string[] {
  const problems: string[] = []
  const what = checks.interactive === true ? 'a micro-world' : 'a scene'
  const scripts = [...html.matchAll(SCRIPT_RE)]
  // The markup is checked without the scripts' bodies, so code is not read as attributes.
  const markup = html.replace(SCRIPT_RE, '<script$1></script>')
  const tagsOf = (re: RegExp) => [...markup.matchAll(re)].map(m => (m[1] as string).toLowerCase())
  const tags = new Set([
    ...tagsOf(FORBIDDEN_TAGS),
    ...(checks.interactive === true ? [] : tagsOf(INPUT_TAGS)),
  ])
  if (tags.size > 0) {
    problems.push(
      checks.interactive === true
        ? `uses <${[...tags].join('>, <')}>; a micro-world is text, the kit's classes, icons, SVG, canvas, its controls, and inline styles and scripts, and it loads nothing`
        : `uses <${[...tags].join('>, <')}>; a scene is text, the kit's classes, icons, SVG, canvas, and inline styles and scripts, and it takes no input`
    )
  }
  if (/\son[a-z]+\s*=/i.test(markup)) {
    problems.push(
      `has an event handler attribute; put code in a <script>${checks.interactive === true ? ' that listens with addEventListener' : ', and a scene takes no clicks or keys'}`
    )
  }
  if (/url\s*\(\s*['"]?\s*(?!#|data:)|@import|javascript:|expression\s*\(/i.test(markup)) {
    problems.push(
      'loads something (url() of a file, @import, or javascript:); the frame loads nothing, so url() takes only #ids and data:'
    )
  }
  const refs = [...markup.matchAll(/\s(?:href|src|xlink:href|action|srcset)\s*=\s*["']?([^"'\s>]*)/gi)]
    .map(m => m[1] as string)
    .filter(ref => !ref.startsWith('#') && !ref.startsWith('data:'))
  if (refs.length > 0) {
    problems.push(
      `links to ${refs.slice(0, 3).join(', ')}; ${what} links nowhere, and its scripts are inline`
    )
  }
  const blocked = [
    ...new Set(
      scripts.flatMap(m => BLOCKED_APIS.filter(([re]) => re.test(m[2] as string)).map(([, name]) => name))
    ),
  ]
  if (blocked.length > 0) {
    problems.push(
      `its script uses ${blocked.join(', ')}; the frame has no network, storage, eval, or workers, and blocks them`
    )
  }
  const unknown = [...new Set(sceneIcons(markup).filter(name => iconSvg(name) === null))]
  if (unknown.length > 0) {
    problems.push(
      `names icons that do not exist: ${unknown.join(', ')} (Lucide names, such as database or circle-x)`
    )
  }
  const words = markup.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, '')
  if (!/<[a-z]/i.test(markup) || words.trim() === '') {
    problems.push(
      `shows no text in its markup; ${what} says what happens with words the page lays out, not only ones a script draws`
    )
  }
  return problems
}
