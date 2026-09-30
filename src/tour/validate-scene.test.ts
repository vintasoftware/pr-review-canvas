// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../paths.js'
import { iconsFor, iconSvg } from './icons.js'
import { inlineIcons } from './scene.js'
import { sceneIcons, sceneProblems } from './validate-scene.js'

describe('icons', () => {
  it('reads a Lucide icon as bare SVG that takes its color and size from the text', () => {
    const svg = iconSvg('database') ?? ''
    expect(svg.startsWith('<svg class="icon" aria-hidden="true"')).toBe(true)
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).not.toContain('width="24"')
    expect(svg).not.toContain('<!--')
    expect(iconSvg('database')).toBe(svg)
  })

  it('knows no icon outside the set, and no name that could be a path', () => {
    expect(iconSvg('no-such-icon')).toBeNull()
    expect(iconSvg('../package')).toBeNull()
    expect(iconSvg('Database')).toBeNull()
    expect(Object.keys(iconsFor(['user', 'nope', 'user', 'clock']))).toEqual(['user', 'clock'])
  })
})

describe('inlineIcons', () => {
  it('replaces each icon name with its SVG, keeping its classes and nothing else', () => {
    const html = inlineIcons(
      '<i data-icon="user" class="lg bad" onclick="x"></i> and <i data-icon="clock"></i>'
    )
    expect(html).toMatch(/^<svg class="icon lg bad" aria-hidden="true"/)
    expect(html).toContain(' and <svg class="icon" aria-hidden="true"')
    expect(html).not.toContain('onclick')
    // A class that tries to leave the attribute ends at its first quote.
    expect(inlineIcons('<i class=\'x" onload="y\' data-icon="user"></i>')).toMatch(
      /^<svg class="icon x" aria-hidden/
    )
    expect(inlineIcons('<i data-icon="nope"></i>left')).toBe('left')
  })
})

describe('sceneProblems', () => {
  const ok =
    '<div class="scene"><div class="row"><div class="box bad"><i data-icon="circle-x"></i>failed</div></div></div>'

  it('passes a scene of text, kit classes, icons, and inline SVG with in-page references', () => {
    expect(sceneProblems(ok)).toEqual([])
    expect(sceneProblems('<svg viewBox="0 0 10 10"><use href="#a"/></svg><p>two</p>')).toEqual([])
    expect(sceneIcons(ok)).toEqual(['circle-x'])
  })

  it('passes its own styles, a canvas, and inline scripts, whose code is not read as markup', () => {
    const scene =
      '<div class="scene"><canvas class="q"></canvas><p>3 queued</p>' +
      '<style>.q { fill: url(#g); background: url(data:image/png;base64,AA) }</style>' +
      '<script>const onChange = () => 1; el.innerHTML = \'<b onclick="x">\'; document.querySelector(".q")</script></div>'
    expect(sceneProblems(scene)).toEqual([])
  })

  it('passes every example the scene guide teaches with, using only classes it can style', async () => {
    const guide = await readFile(path.join(PACKAGE_ROOT, 'skills', 'pr-tour', 'scenes.md'), 'utf8')
    const kit = await readFile(path.join(PACKAGE_ROOT, 'static', 'styles', 'scene.css'), 'utf8')
    // A micro-world example is fenced as ```html micro-world; the rest are scenes.
    const examples = [...guide.matchAll(/```html( micro-world)?\n([\s\S]*?)```/g)].map(m => ({
      interactive: m[1] !== undefined,
      html: m[2] as string,
    }))
    expect(examples.length).toBeGreaterThanOrEqual(6)
    expect(examples.some(e => e.interactive)).toBe(true)
    for (const { interactive, html } of examples) {
      expect(html).toContain('class="scene"')
      expect(sceneProblems(html, { interactive })).toEqual([])
      // A class the kit does not define is one the example styles or scripts itself.
      const own = [...html.matchAll(/<(?:style|script)\b[^>]*>([\s\S]*?)<\//g)].map(m => m[1]).join('\n')
      const classes = [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap(m => (m[1] as string).split(/\s+/))
      const unknown = classes.filter(c => c !== '' && !kit.includes(`.${c}`) && !own.includes(c))
      expect(unknown).toEqual([])
    }
  })

  it('names what loads, takes input, or leaves the frame', () => {
    expect(
      sceneProblems(
        '<p>x</p><iframe></iframe><IMG src="a.png"><input><p onclick="go()">y</p><script src="https://x.example/a.js"></script>'
      )
    ).toEqual([
      "uses <iframe>, <img>, <input>; a scene is text, the kit's classes, icons, SVG, canvas, and inline styles and scripts, and it takes no input",
      'has an event handler attribute; put code in a <script>, and a scene takes no clicks or keys',
      'links to a.png, https://x.example/a.js; a scene links nowhere, and its scripts are inline',
    ])
    expect(sceneProblems('<p style="background: url(https://x.example/t.png)">x</p>')).toEqual([
      'loads something (url() of a file, @import, or javascript:); the frame loads nothing, so url() takes only #ids and data:',
    ])
    expect(sceneProblems('<a href="https://x.example">go</a>')).toEqual([
      'links to https://x.example; a scene links nowhere, and its scripts are inline',
    ])
  })

  it('lets a micro-world take input through its controls, but never through a form or a handler attribute', () => {
    const controls =
      '<div class="scene"><fieldset><legend>stdout is</legend><label><input type="radio" name="o" checked> a terminal</label>' +
      '<select><option>a</option></select><button type="button">run</button></fieldset><p>text</p>' +
      '<script>document.querySelector("button").addEventListener("click", () => 1)</script></div>'
    expect(sceneProblems(controls, { interactive: true })).toEqual([])
    expect(sceneProblems(controls).length).toBe(1)
    expect(sceneProblems('<form><input></form><p onchange="x()">t</p>', { interactive: true })).toEqual([
      "uses <form>; a micro-world is text, the kit's classes, icons, SVG, canvas, its controls, and inline styles and scripts, and it loads nothing",
      'has an event handler attribute; put code in a <script> that listens with addEventListener',
    ])
    expect(sceneProblems('<a href="https://x.example">go</a>', { interactive: true })).toEqual([
      'links to https://x.example; a micro-world links nowhere, and its scripts are inline',
    ])
  })

  it('names what a script would find blocked: the network, storage, eval, and workers', () => {
    const script = (code: string) => sceneProblems(`<p>x</p><script>${code}</script>`)
    expect(script("fetch('/api/x'); new WebSocket('ws://x'); navigator.sendBeacon('/x')")).toEqual([
      'its script uses fetch, WebSocket, sendBeacon; the frame has no network, storage, eval, or workers, and blocks them',
    ])
    expect(script('new RTCPeerConnection(); localStorage.x = 1; eval("1"); new Worker("w.js")')).toEqual([
      'its script uses RTCPeerConnection, workers, eval, storage; the frame has no network, storage, eval, or workers, and blocks them',
    ])
    // Words that only contain those names are fine.
    expect(script('const prefetched = myFunction(1); node.parentElement')).toEqual([])
  })

  it('names icons that do not exist, and a scene with no words in its markup', () => {
    expect(sceneProblems('<p><i data-icon="made-up"></i>x</p>')).toEqual([
      'names icons that do not exist: made-up (Lucide names, such as database or circle-x)',
    ])
    const wordless =
      'shows no text in its markup; a scene says what happens with words the page lays out, not only ones a script draws'
    expect(sceneProblems('<div><i data-icon="user"></i></div>')).toEqual([wordless])
    expect(sceneProblems('just words')).toEqual([wordless])
    expect(sceneProblems('<canvas></canvas><script>ctx.fillText("3 rows lost", 0, 0)</script>')).toEqual([
      wordless,
    ])
    expect(sceneProblems('<div><i data-icon="user"></i></div>', { interactive: true })).toEqual([
      'shows no text in its markup; a micro-world says what happens with words the page lays out, not only ones a script draws',
    ])
  })
})
