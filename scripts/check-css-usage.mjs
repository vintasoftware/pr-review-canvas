#!/usr/bin/env node
// Finds dead CSS that Stylelint cannot see, because the markup is built in JavaScript:
//   - a class selector whose name appears nowhere in the code that builds the markup;
//   - a custom property that is set (in CSS, or inline from JS) but never read with var();
//   - a custom property read with var() in JS that nothing sets.
// Each scope pairs its stylesheets with the sources that write its markup. A name counts as used
// when it appears as a whole token in a source, or when a source builds it from a template that
// starts with its prefix: `move-${side}` covers .move-from, `var(--s${n})` reads --s1 to --s6.
// Names written by a library at run time go in `dynamic`.
import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The scene kit: generated scenes write its classes, and the scene guide is where they are taught. */
const SCENE_KIT = 'static/styles/scene.css'

/** @type {Array<{ name: string, css: string[], exclude?: string[], sources: string[], dynamic: RegExp[] }>} */
const SCOPES = [
  {
    name: 'app',
    css: ['static/styles/*.css'],
    exclude: [SCENE_KIT],
    sources: ['static/js/**/*.js', 'src/**/*.ts'],
    // highlight.js writes its token classes at run time.
    dynamic: [/^hljs(-|$)/, /^(function|class)_$/],
  },
  {
    // A kit class no guide example or kit entry names is one no generator will ever write.
    name: 'scene',
    css: [SCENE_KIT],
    sources: ['skills/pr-tour/scenes.md', 'static/js/scene-runtime.js', 'src/server/html.ts'],
    dynamic: [],
  },
  {
    name: 'site',
    css: ['site/*.css'],
    sources: ['site/*.html', 'site/*.js'],
    dynamic: [/^hljs(-|$)/, /^(function|class)_$/],
  },
]

/** @param {string[]} patterns @param {string[]} [exclude] */
async function files(patterns, exclude = []) {
  const out = []
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: ROOT })) {
      if (!/\.test\.[jt]s$/.test(file) && !file.includes('__fixtures__') && !exclude.includes(file)) {
        out.push(file)
      }
    }
  }
  return out.sort()
}

/** @param {string[]} list */
async function read(list) {
  return Promise.all(list.map(async file => ({ file, text: await readFile(path.join(ROOT, file), 'utf8') })))
}

/** Comments, strings, and url() bodies hold no selectors or property names. */
function stripCss(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, 'url()')
    .replace(/'[^'\n]*'|"[^"\n]*"/g, "''")
}

/** Class names used in selectors: every `.name` in a rule's prelude, never in a declaration value. */
function selectorClasses(css) {
  const found = new Map()
  const text = stripCss(css.text)
  // A prelude is the text before a `{` back to the previous `{`, `}` or `;`.
  for (const match of text.matchAll(/([^{};]*)\{/g)) {
    const prelude = match[1] ?? ''
    if (prelude.trim().startsWith('@')) {
      continue
    }
    for (const cls of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      const name = cls[1] ?? ''
      if (!found.has(name)) {
        found.set(name, lineOf(text, (match.index ?? 0) + (cls.index ?? 0)))
      }
    }
  }
  return found
}

/** @param {string} text @param {number} index */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/** @param {string} name */
function tokenPattern(name) {
  return new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
}

const problems = []
for (const scope of SCOPES) {
  const sheets = await read(await files(scope.css, scope.exclude))
  const sources = await read(await files(scope.sources))
  const markup = sources.map(s => s.text).join('\n')
  // Prefixes of names built from templates, like `move-${side}` or `var(--s${n})`.
  const built = [...markup.matchAll(/([\w-]*[\w-])\$\{/g)].map(m => m[1] ?? '').filter(p => p.length > 2)
  const isBuilt = (/** @type {string} */ name) => built.some(prefix => name.startsWith(prefix))

  for (const sheet of sheets) {
    for (const [name, line] of selectorClasses(sheet)) {
      if (scope.dynamic.some(re => re.test(name)) || tokenPattern(name).test(markup) || isBuilt(name)) {
        continue
      }
      problems.push(`${sheet.file}:${line}  class .${name} is styled but no source writes it`)
    }
  }

  const cssText = sheets.map(s => stripCss(s.text)).join('\n')
  // Sources set a property in an inline style attribute or with setProperty(); any other `--x:` in
  // a source is a CLI flag or prose.
  const set = new Set([
    ...[...cssText.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]),
    ...[...markup.matchAll(/style="[^"]*?(--[\w-]+)\s*:/g)].map(m => m[1]),
    ...[...markup.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].map(m => m[1]),
  ])
  const readNames = new Set([...`${cssText}\n${markup}`.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]))
  for (const name of [...set].sort()) {
    if (!readNames.has(name) && !isBuilt(name)) {
      problems.push(`${scope.name}: custom property ${name} is set but never read`)
    }
  }
  for (const name of [
    ...new Set([...markup.matchAll(/var\(\s*(--[\w-]+)(?!\$\{)/g)].map(m => m[1])),
  ].sort()) {
    if (!set.has(name) && !markup.includes(`var(${name}\${`)) {
      problems.push(`${scope.name}: custom property ${name} is read in a source but nothing sets it`)
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  console.error(`\n${problems.length} unused or unset CSS name(s).`)
  process.exit(1)
}
console.log('CSS usage: every styled class and custom property is used.')
