// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../server/context.js'
import { codeOnly, sketchProblems } from './validate-sketch.js'

const ok = "p.draw = () => { ui.box(20, 20, 80, 60, 'save'); p.circle(200, 150, 40) }"

describe('sketchProblems', () => {
  it('passes a sketch that draws with p and ui, whatever its labels say', () => {
    expect(sketchProblems(ok)).toEqual([])
    // Words in strings and comments are not calls: a label may say "fetch" or "window".
    expect(
      sketchProblems(
        '// no window here\np.draw = () => ui.label("fetch window.top", 200, 150, { color: ui.top })'
      )
    ).toEqual([])
  })

  it('passes the example the deck prompt teaches with', async () => {
    const prompt = await readFile(path.join(PACKAGE_ROOT, 'prompts', 'self-review-deck.md'), 'utf8')
    const example = /```js\n([\s\S]*?)```/.exec(prompt)?.[1]
    expect(example).toBeDefined()
    expect(sketchProblems(example as string)).toEqual([])
  })

  it('refuses code that does not parse, naming why', () => {
    const [problem] = sketchProblems('p.draw = () => {')
    expect(problem).toMatch(/^does not parse as a function body: /)
  })

  it('refuses a sketch that draws nothing', () => {
    expect(sketchProblems('p.setup = () => {}')).toEqual(['never assigns p.draw, so nothing is drawn'])
  })

  it('refuses page, network, and eval globals, but not properties of the same name', () => {
    expect(sketchProblems('p.draw = () => { fetch("/api"); document.title = parent.name }')).toEqual([
      'uses document, parent, fetch; a sketch draws with p and ui only',
    ])
    expect(sketchProblems('p.draw = () => { const f = Function; f("x") }')[0]).toContain('Function')
    // `ui.self` and `p.top` are properties, not the globals.
    expect(sketchProblems('p.draw = () => { const t = p.top; ui.label(String(ui.self), 200, 150) }')).toEqual(
      []
    )
  })

  it('sees through a template literal to the code in its placeholders', () => {
    expect(sketchProblems('p.draw = () => ui.label(`${fetch("x")} rows`, 1, 2)')).toEqual([
      'uses fetch; a sketch draws with p and ui only',
    ])
    expect(sketchProblems('p.draw = () => ui.label(`fetch ${3} rows`, 200, 150)')).toEqual([])
  })

  it('refuses p5 calls that load, save, add elements, or take the canvas', () => {
    const [problem] = sketchProblems(
      'p.setup = () => { p.createCanvas(10, 10); p.loadImage("x.png"); p . createDiv("hi") }\np.draw = () => p.saveCanvas()'
    )
    expect(problem).toBe(
      'calls p.createCanvas, p.loadImage, p.createDiv, p.saveCanvas; the frame owns the canvas, and sketches load nothing and add no elements'
    )
    // Drawing calls that merely start the same way are fine.
    expect(
      sketchProblems(
        'p.draw = () => { p.loadPixels(); p.removeItemX = 1; p.createCanvasX = 2; p.rect(9, 9, 5, 5) }'
      )
    ).toEqual([])
    expect(sketchProblems('p.draw = () => { p.lerp(0, 1, 0.5); p.rect(1, 2, 3, 4) }')).toEqual([])
  })
})

describe('drawing the sketch', () => {
  it('refuses a sketch that throws, naming the error', () => {
    expect(sketchProblems('p.draw = () => { ui.nope(1) }')).toEqual([
      'fails when drawn: TypeError: ui.nope is not a function',
    ])
    expect(sketchProblems('p.draw = () => { ui.box(1, 1, 9, 9, missing) }')).toEqual([
      'fails when drawn: ReferenceError: missing is not defined',
    ])
    // Only at the payoff, which a glance at the idle loop would miss.
    expect(sketchProblems('p.draw = () => { if (ui.beat === 1) ui.nope(); p.rect(9, 9, 9, 9) }')).toEqual([
      'fails when drawn: TypeError: ui.nope is not a function',
    ])
  })

  it('stops a sketch that never finishes a frame', () => {
    const [problem] = sketchProblems('p.draw = () => { while (true) p.rect(1, 1, 1, 1) }')
    expect(problem).toMatch(/^fails when drawn: .*timed out after 1500ms$/)
  })

  it('refuses a sketch that draws nothing', () => {
    expect(sketchProblems('p.draw = () => { p.stroke(ui.ink) }')).toEqual(['draws nothing on the stage'])
  })

  it('gives the sketch nothing of this process to reach', () => {
    // The stand-in and the kit live in the sketch's own context, so their constructors lead to
    // that context's Function, which knows no process, require, or file system.
    expect(sketchProblems("p.draw = () => { p.rect.constructor('return process')().exit(1) }")).toEqual([
      'fails when drawn: ReferenceError: process is not defined',
    ])
    expect(sketchProblems("p.draw = () => { ui.box.constructor('return require')()('fs') }")).toEqual([
      'fails when drawn: ReferenceError: require is not defined',
    ])
  })

  it('runs what p5 offers and the stand-in does not know as a no-op', () => {
    expect(
      sketchProblems(
        'p.setup = () => p.randomSeed(3)\np.draw = () => { p.blendMode(p.MULTIPLY); const x = p.random(50, 60); p.rect(x, p.lerp(10, 20, ui.loop()), 30, 30) }'
      )
    ).toEqual([])
  })
})

describe('the layout of what a sketch draws', () => {
  it('refuses labels too small, off the stage, or on top of each other', () => {
    expect(sketchProblems("p.draw = () => ui.label('tiny', 200, 150, { size: 9 })")).toEqual([
      'label "tiny" is size 9; labels are at least 12',
    ])
    // Scaled down, a label that says 14 is drawn at 7.
    expect(sketchProblems("p.draw = () => { p.scale(0.5); ui.label('half', 400, 300) }")).toEqual([
      'label "half" is size 7; labels are at least 12',
    ])
    expect(sketchProblems("p.draw = () => ui.label('a long label here', 395, 150)")).toEqual([
      'label "a long label here" runs off the 400×300 stage',
    ])
    expect(
      sketchProblems("p.draw = () => { ui.label('first', 200, 150); ui.label('second', 205, 155) }")
    ).toEqual(['labels "first" and "second" overlap'])
  })

  it('refuses a label painted over, or crossed by a line or an icon', () => {
    expect(
      sketchProblems("p.draw = () => { ui.box(100, 100, 200, 100, 'queue'); ui.dot(200, 150, 10) }")
    ).toEqual(['a circle drawn after label "queue" covers it; draw the label last or move one of them'])
    expect(
      sketchProblems("p.draw = () => { ui.label('cache', 200, 150); ui.arrow(100, 150, 300, 150) }")
    ).toEqual(['a line crosses label "cache"; move one of them'])
    expect(
      sketchProblems("p.draw = () => { ui.label('point', 200, 150); ui.icon('check', 200, 150, 30) }")[0]
    ).toBe('a line crosses label "point"; move one of them')
  })

  it('passes what frames or backs a label, and a label moved clear of the box contents', () => {
    // The box is drawn first, as the label's background; the box outline frames the label.
    expect(
      sketchProblems(
        "p.draw = () => { ui.box(100, 100, 200, 100, 'queue', { at: 'top' }); ui.dot(200, 160, 10) }"
      )
    ).toEqual([])
    expect(
      sketchProblems("p.draw = () => { ui.label('far', 60, 40); ui.arrow(100, 200, 300, 200) }")
    ).toEqual([])
    // Under a rotation the boxes are not axis-aligned, so the checks leave it alone.
    expect(
      sketchProblems(
        "p.draw = () => { p.rotate(0.3); ui.label('tilted', 200, 150); p.rect(190, 140, 40, 20) }"
      )
    ).toEqual([])
  })

  it('tests a stroke as the segment it is, as wide as it is drawn', () => {
    // A steep line whose box overlaps the label's but which passes beside it (a generator hit this).
    expect(
      sketchProblems("p.draw = () => { ui.label('prompt', 124, 118); p.line(145, 95, 160, 140) }")
    ).toEqual([])
    // The same line, moved onto the label.
    expect(
      sketchProblems("p.draw = () => { ui.label('prompt', 124, 118); p.line(115, 95, 130, 140) }")
    ).toEqual(['a line crosses label "prompt"; move one of them'])
    // A thin stroke just above a label clears it; a thick bar at the same place does not.
    const bar = (w: number) =>
      `p.draw = () => { ui.label('cache', 200, 150); p.strokeWeight(${w}); p.line(150, 139, 250, 139) }`
    expect(sketchProblems(bar(1))).toEqual([])
    expect(sketchProblems(bar(12))).toEqual(['a line crosses label "cache"; move one of them'])
    // A curve counts along its path, not by its ends alone.
    expect(
      sketchProblems(
        "p.draw = () => { ui.label('mid', 200, 150); p.bezier(100, 250, 160, 117, 240, 117, 300, 250) }"
      )
    ).toEqual(['a line crosses label "mid"; move one of them'])
  })

  it('counts a turned shape by the box around its turned corners', () => {
    // A bar turned 90 degrees about the label now stands across it.
    expect(
      sketchProblems(
        "p.draw = () => { ui.label('cache', 200, 150); p.translate(200, 150); p.rotate(p.HALF_PI); p.rect(-40, -6, 80, 12) }"
      )
    ).toEqual(['a rect drawn after label "cache" covers it; draw the label last or move one of them'])
    // Turned away from it, the same bar leaves it alone.
    expect(
      sketchProblems(
        "p.draw = () => { ui.label('cache', 200, 150); p.translate(200, 60); p.rotate(p.HALF_PI); p.rect(-40, -6, 80, 12) }"
      )
    ).toEqual([])
  })

  it('names at most four problems per sketch', () => {
    const labels = Array.from({ length: 8 }, (_, i) => `ui.label('l${i}', 200, 150, { size: 8 })`).join('; ')
    expect(sketchProblems(`p.draw = () => { ${labels} }`)).toHaveLength(4)
  })
})

describe('codeOnly', () => {
  it('blanks strings and comments and keeps template placeholders', () => {
    expect(codeOnly("a('x') /* y */ b // z\n`t ${c} u ${d}`")).toBe('a( )   b  \n c d ')
  })
})
