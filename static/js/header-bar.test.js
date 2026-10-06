// @ts-check
// @vitest-environment happy-dom
// The bar every page starts with, which the server and the review page both draw from this module.
import { ENV_DIALOG_ID, headerBarHtml, wireEnvBadge } from './header-bar.js'

/** @param {string} html */
function bar(html) {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const root = holder.querySelector('.hdr-bar')
  if (root === null) {
    throw new Error('no .hdr-bar')
  }
  return root
}

/** @param {Element} root */
function brandChildren(root) {
  return [...(root.querySelector('.brand')?.children ?? [])]
}

const look = /** @type {const} */ ({ theme: 'dark', skin: 'olive' })

describe('headerBarHtml', () => {
  it("links the project's name to its home page next to the wordmark", () => {
    const root = bar(
      headerBarHtml({ project: { slug: 'acme/widgets~fix', home: '/r/acme/widgets~fix/' }, ...look })
    )
    const [brand, context, ...rest] = brandChildren(root)
    expect(rest).toEqual([])
    expect(brand?.getAttribute('href')).toBe('/')
    expect(brand?.getAttribute('title')).toBe('All projects')
    expect(brand?.textContent).toBe('PR review canvas')
    expect(context?.tagName).toBe('A')
    expect(context?.getAttribute('href')).toBe('/r/acme/widgets~fix/')
    expect(context?.getAttribute('title')).toBe("This project's home page")
    expect(context?.textContent).toBe('acme/widgets~fix')
  })

  it('names the host on a page of the server, and takes the project over it', () => {
    const [, host] = brandChildren(bar(headerBarHtml({ host: 'localhost:3010', ...look })))
    expect(host?.tagName).toBe('SPAN')
    expect(host?.className).toBe('mono muted')
    expect(host?.textContent).toBe('localhost:3010')
    const [, project] = brandChildren(
      bar(
        headerBarHtml({
          host: 'localhost:3010',
          project: { slug: 'acme/widgets', home: '/r/acme/widgets/' },
          ...look,
        })
      )
    )
    expect(project?.tagName).toBe('A')
    expect(project?.textContent).toBe('acme/widgets')
  })

  it('has no context element when given neither', () => {
    expect(brandChildren(bar(headerBarHtml({ ...look }))).map(el => el.className)).toEqual(['brand-wordmark'])
  })

  it("puts the page's commands in the actions group, before the skin and theme commands", () => {
    const root = bar(headerBarHtml({ ...look }, '<a class="cmd" id="health" href="/api/health">health</a>'))
    const group = root.querySelector('.hdr-actions')
    expect(group?.getAttribute('role')).toBe('group')
    expect(group?.getAttribute('aria-label')).toBe('Page actions')
    expect([...(group?.children ?? [])].map(el => [el.id, el.textContent])).toEqual([
      ['health', 'health'],
      ['skin-toggle', 'skin: olive'],
      ['theme-toggle', 'theme: dark'],
    ])
    for (const id of ['skin-toggle', 'theme-toggle']) {
      expect(root.querySelector(`#${id}`)?.getAttribute('type')).toBe('button')
    }
  })

  it('draws only the skin and theme commands when the page has none', () => {
    const group = bar(headerBarHtml({ theme: 'auto', skin: 'github' })).querySelector('.hdr-actions')
    expect([...(group?.children ?? [])].map(el => el.textContent)).toEqual(['skin: github', 'theme: auto'])
  })

  it('escapes the project, its home, and the host', () => {
    const html = headerBarHtml({
      project: { slug: '<b>acme</b>', home: '/r/"x"/' },
      ...look,
    })
    expect(html).toContain('href="/r/&quot;x&quot;/"')
    expect(html).toContain('&lt;b&gt;acme&lt;/b&gt;')
    expect(html).not.toContain('<b>')
    const [, project] = brandChildren(bar(html))
    expect(project?.getAttribute('href')).toBe('/r/"x"/')
    expect(project?.textContent).toBe('<b>acme</b>')
    const host = headerBarHtml({ host: '<i>evil</i>', ...look })
    expect(host).toContain('&lt;i&gt;evil&lt;/i&gt;')
    expect(host).not.toContain('<i>')
  })

  describe("a project running under the server's environment", () => {
    const restored = {
      project: { slug: 'acme/widgets', home: '/r/acme/widgets/', reopenIn: "/src/<it's>" },
      ...look,
    }

    it("wears a badge next to its name, whose dialog says what can differ and how to give it the terminal's back", () => {
      const holder = document.createElement('div')
      holder.innerHTML = headerBarHtml(restored)
      const [, name, badge, ...rest] = brandChildren(bar(holder.innerHTML))
      expect(rest).toEqual([])
      expect(name?.textContent).toBe('acme/widgets')
      expect(badge?.tagName).toBe('BUTTON')
      expect(badge?.textContent).toBe('server env')
      expect(badge?.getAttribute('aria-haspopup')).toBe('dialog')
      const dialog = holder.querySelector(`dialog#${ENV_DIALOG_ID}`)
      expect(dialog?.hasAttribute('open')).toBe(false)
      expect(dialog?.querySelector('h2')?.textContent).toBe("Running with the server's environment")
      expect(dialog?.textContent).toMatch(
        /comments may post as that account.*the chat agent or the CLI may not be found/
      )
      // The command quotes the folder for the shell; the page escapes it for HTML.
      const command = "cd '/src/<it'\\''s>' && pr-review open"
      expect(dialog?.querySelector('.cmdbox code')?.textContent).toBe(command)
      expect(dialog?.querySelector('.cmdbox button')?.getAttribute('data-copy')).toBe(command)
      expect(headerBarHtml(restored)).not.toContain('<it')
    })

    it('opens the dialog from the badge, after the header is drawn again too', () => {
      const root = document.createElement('div')
      document.body.append(root)
      wireEnvBadge(root)
      wireEnvBadge(root)
      for (let draw = 0; draw < 2; draw++) {
        root.innerHTML = headerBarHtml(restored)
        const dialog = /** @type {HTMLDialogElement} */ (root.querySelector(`#${ENV_DIALOG_ID}`))
        const opened = vi.spyOn(dialog, 'showModal')
        root.querySelector('[data-env-help]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(opened).toHaveBeenCalledTimes(1)
        expect(dialog.open).toBe(true)
        dialog.close()
      }
      root.remove()
    })
  })

  it('has no badge and no dialog for a project with the shell environment, or on a page of the server', () => {
    for (const opts of [
      { project: { slug: 'acme/widgets', home: '/r/acme/widgets/' }, ...look },
      { host: 'localhost:3010', ...look },
    ]) {
      const html = headerBarHtml(opts)
      expect(html).not.toContain('data-env-help')
      expect(html).not.toContain(ENV_DIALOG_ID)
    }
  })
})
