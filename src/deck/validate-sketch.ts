// Checks a side's p5 sketch before it is published. The deck page runs sketches in a sandboxed
// frame with an opaque origin and no network, and that sandbox is the boundary; these checks only
// turn a sketch that would fail there, reach for what the frame withholds, or draw labels nobody
// can read, into a problem the generator can fix, instead of a broken side on the author's screen.
// The generator cannot see what it draws, so this is its only look at the result.
import { compileFunction } from 'node:vm'
import { layoutProblems, runSketch } from './sketch-run.js'

/** Globals a sketch has no use for: the page, the network, storage, and code from strings. */
const FORBIDDEN_GLOBALS = [
  'window',
  'self',
  'globalThis',
  'document',
  'parent',
  'top',
  'opener',
  'frames',
  'location',
  'navigator',
  'postMessage',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'RTCPeerConnection',
  'Worker',
  'SharedWorker',
  'importScripts',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'eval',
  'Function',
  'import',
  'require',
] as const

/**
 * p5 functions a sketch may not call. The frame owns the one canvas; the rest load files, reach
 * the network or storage, or add page elements.
 */
const FORBIDDEN_P5 =
  /^(createCanvas|resizeCanvas|noCanvas|remove|load(?!Pixels$)\w*|http\w*|save\w*|select\w*|create(Div|P|Span|Img|A|Button|Checkbox|Select|Radio|ColorPicker|Input|FileInput|Video|Audio|Capture|Element|Slider|Graphics|Framebuffer|Shader|FilterShader)|storeItem|getItem|removeItem|clearStorage|getURL\w*|fullscreen|requestPointerLock)$/

/**
 * The code outside string literals and comments, so a label that says "save" is no call. The
 * expressions inside a template literal's `${...}` stay: they run.
 */
export function codeOnly(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    token => {
      if (token.startsWith('`')) {
        return ' ' + [...token.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]).join(' ') + ' '
      }
      return ' '
    }
  )
}

/** What is wrong with a sketch, one sentence each; empty when it may be published. */
export function sketchProblems(source: string): string[] {
  const problems: string[] = []
  try {
    compileFunction(source, ['p', 'ui'])
  } catch (err) {
    problems.push(`does not parse as a function body: ${err instanceof Error ? err.message : String(err)}`)
    return problems
  }
  const code = codeOnly(source)
  const globals = new Set<string>()
  for (const name of FORBIDDEN_GLOBALS) {
    // A bare name, not a property: `ui.top` is fine, `top` is not.
    if (new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(code)) globals.add(name)
  }
  if (globals.size > 0) {
    problems.push(`uses ${[...globals].join(', ')}; a sketch draws with p and ui only`)
  }
  const calls = new Set<string>()
  for (const m of code.matchAll(/(?<![\w$])p\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const name = m[1] as string
    if (FORBIDDEN_P5.test(name)) calls.add(`p.${name}`)
  }
  if (calls.size > 0) {
    problems.push(
      `calls ${[...calls].join(', ')}; the frame owns the canvas, and sketches load nothing and add no elements`
    )
  }
  if (!/(?<![\w$])p\s*\.\s*draw\s*=/.test(code)) {
    problems.push('never assigns p.draw, so nothing is drawn')
  }
  if (problems.length > 0) {
    return problems
  }
  // Only a sketch that passed the checks above is run.
  const run = runSketch(source)
  if (!run.ok) {
    return [`fails when drawn: ${run.error}`]
  }
  if (run.frames.every(f => f.texts.length === 0 && f.shapes.length === 0)) {
    return ['draws nothing on the stage']
  }
  return layoutProblems(run.frames)
}
