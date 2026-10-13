// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GALLERY_DIR, galleryEntries, renderGallery } from './gallery.js'
import { sceneProblems, sceneTechnique } from './validate-scene.js'

async function tempGallery(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pr-review-gallery-test-'))
  await writeFile(
    path.join(dir, 'sequence.scene.html'),
    '<div class="scene" data-technique="sequence"><p>a</p></div>'
  )
  await writeFile(path.join(dir, 'race-lab.micro.html'), '<div class="scene"><p>b</p></div>')
  await writeFile(path.join(dir, 'README.md'), '# The gallery\n')
  await writeFile(path.join(dir, 'notes.txt'), 'not an entry')
  return dir
}

describe('the shipped gallery', () => {
  it('has entries the frame would publish, each scene naming its technique, all in the README', async () => {
    const entries = await galleryEntries()
    expect(entries.length).toBeGreaterThanOrEqual(12)
    expect(entries.some(e => e.kind === 'micro')).toBe(true)
    const readme = await readFile(path.join(GALLERY_DIR, 'README.md'), 'utf8')
    for (const entry of entries) {
      const html = await readFile(entry.file, 'utf8')
      expect(html.length).toBeLessThanOrEqual(12_000)
      expect(sceneProblems(html, { interactive: entry.kind === 'micro' })).toEqual([])
      if (entry.kind === 'scene') expect(sceneTechnique(html)).toBe(entry.slug)
      expect(readme).toContain(`\`${entry.slug}\``)
    }
  })
})

describe('renderGallery', () => {
  const browserEnv = { PR_REVIEW_BROWSER: '/opt/chrome' }

  it('lists the entries by slug, and only scene and micro-world files', async () => {
    const dir = await tempGallery()
    const result = await renderGallery(
      [],
      { env: {}, platform: 'linux', screenshot: async () => undefined },
      { dir }
    )
    expect(result).toEqual({
      status: 'listed',
      entries: [
        { slug: 'race-lab', kind: 'micro' },
        { slug: 'sequence', kind: 'scene' },
      ],
      readme: path.join(dir, 'README.md'),
    })
  })

  it('draws each entry named, in the frame, at the width the page gives a picture', async () => {
    const dir = await tempGallery()
    const outDir = await mkdtemp(path.join(tmpdir(), 'pr-review-gallery-out-'))
    const shots: Array<{ url: string; width: number }> = []
    const result = await renderGallery(
      ['sequence', 'race-lab'],
      {
        env: browserEnv,
        platform: 'linux',
        screenshot: async (_b, url, file, viewport) => {
          shots.push({ url, width: viewport.width })
          await writeFile(file, 'png')
        },
      },
      { dir, outDir }
    )
    expect(result.status).toBe('rendered')
    expect(result.entries).toEqual([
      { slug: 'sequence', kind: 'scene', png: path.join(outDir, 'sequence.png') },
      { slug: 'race-lab', kind: 'micro', png: path.join(outDir, 'race-lab.png') },
    ])
    expect(shots.map(s => s.width)).toEqual([1120, 1120])
    expect(shots[0]?.url).toMatch(/^file:\/\/.*sequence\.frame\.html$/)
    const frame = await readFile(path.join(outDir, 'sequence.frame.html'), 'utf8')
    expect(frame).toContain(
      '<main class="scene-root"><div class="scene-fit"><div class="scene" data-technique="sequence">'
    )
    expect(frame).toContain('window.parent.postMessage')
    // Without --out, each run draws into a new private directory of its own.
    const deps = { env: browserEnv, platform: 'linux' as const, screenshot: async () => undefined }
    const first = await renderGallery(['sequence'], deps, { dir })
    const second = await renderGallery(['sequence'], deps, { dir })
    const firstDir = path.dirname(first.entries[0]?.png ?? '')
    expect(path.basename(firstDir)).toMatch(/^pr-review-gallery-/)
    expect(path.dirname(second.entries[0]?.png ?? '')).not.toBe(firstDir)
  })

  it('names an unknown entry, and says where to look without a browser', async () => {
    const dir = await tempGallery()
    const deps = { env: {}, platform: 'linux' as const, screenshot: async () => undefined }
    const unknown = await renderGallery(['nope'], deps, { dir })
    expect(unknown.status).toBe('unknown')
    expect(unknown.hint).toBe('no gallery entry nope; pick from the entries listed')
    expect(unknown.entries).toHaveLength(2)
    const blind = await renderGallery(['sequence'], { ...deps, env: { PATH: '' } }, { dir })
    expect(blind.status).toBe('no-browser')
    expect(blind.entries).toEqual([{ slug: 'sequence', kind: 'scene' }])
    expect(blind.hint).toMatch(/open the HTML files beside the README/)
  })
})
