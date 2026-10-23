// @vitest-environment node
import { sceneFrame } from './html.js'

describe('sceneFrame', () => {
  it('inlines the kit and the runtime ahead of the scene, and carries the theme', () => {
    const page = sceneFrame({
      scene: '<div class="scene"><p>3 rows</p></div>',
      theme: 'dark',
      kit: '.scene{}',
      runtime: 'console.log(1)',
    })
    expect(page.startsWith('<!doctype html><html lang="en" data-theme="dark">')).toBe(true)
    expect(page.indexOf('<style>.scene{}</style>')).toBeLessThan(
      page.indexOf('<script>console.log(1)</script>')
    )
    expect(page.indexOf('</script>')).toBeLessThan(page.indexOf('<div class="scene">'))
    expect(page).toContain(
      '<main class="scene-root"><div class="scene-fit"><div class="scene"><p>3 rows</p></div></div></main>'
    )
    // The frame loads nothing: no external reference in what the server itself writes.
    expect(page.replace(/<div class="scene">.*<\/div><\/div>/, '')).not.toMatch(/\s(src|href)=/)
  })
})
