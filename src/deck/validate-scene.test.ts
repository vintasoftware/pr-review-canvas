// @vitest-environment node
import { iconsFor, iconSvg } from './icons.js'
import { inlineIcons } from './scene.js'
import { sceneIcons, sceneProblems, storyProblems } from './validate-scene.js'

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

  it('names what runs, loads, or leaves the frame', () => {
    expect(
      sceneProblems('<p>x</p><script>1</script><IMG src="a.png"><style>p{}</style><p onclick="go()">y</p>')
    ).toEqual([
      "uses <script>, <img>, <style>; a scene is text, the kit's classes, icons, and inline SVG",
      'has an event handler attribute; the frame runs no script',
      'links to a.png; a scene links nowhere',
    ])
    expect(sceneProblems('<p style="background: url(https://x.example/t.png)">x</p>')).toEqual([
      'loads something (url(), @import, or javascript:); the frame loads nothing',
    ])
    expect(sceneProblems('<a href="https://x.example">go</a>')).toEqual([
      'links to https://x.example; a scene links nowhere',
    ])
  })

  it('names icons that do not exist, and a scene with no words', () => {
    expect(sceneProblems('<p><i data-icon="made-up"></i>x</p>')).toEqual([
      'names icons that do not exist: made-up (Lucide names, such as database or circle-x)',
    ])
    expect(sceneProblems('<div><i data-icon="user"></i></div>')).toEqual([
      'shows no text; a scene says what happens, with words the reader can take in',
    ])
    expect(sceneProblems('just words')).toEqual([
      'shows no text; a scene says what happens, with words the reader can take in',
    ])
  })
})

describe('storyProblems', () => {
  it('names each missing icon once', () => {
    expect(storyProblems([{ icon: 'user' }, { icon: 'nope' }, { icon: 'nope' }])).toEqual([
      'names icons that do not exist: nope (Lucide names, such as database or circle-x)',
    ])
    expect(storyProblems([{ icon: 'user' }, { icon: 'send' }])).toEqual([])
  })
})
