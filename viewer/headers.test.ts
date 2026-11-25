import { headersFile, viewerCsp, viewerHeaders } from './headers.js'

it('lets the page run only its own script and talk only to GitHub and the auth Worker', () => {
  const csp = viewerCsp({ workerUrl: 'https://auth.example.com/some/path' })
  const directives = Object.fromEntries(
    csp.split('; ').map(d => {
      const [name, ...values] = d.split(' ')
      return [name, values]
    })
  )
  expect(directives['default-src']).toEqual(["'none'"])
  expect(directives['script-src']).toEqual(["'self'"])
  expect(directives['connect-src']).toEqual(["'self'", 'https://api.github.com', 'https://auth.example.com'])
  expect(directives['frame-ancestors']).toEqual(["'none'"])
  expect(directives['base-uri']).toEqual(["'none'"])
  expect(directives['object-src']).toEqual(["'none'"])
  expect(directives['img-src']).not.toContain('https:')
  expect(csp).not.toContain('unsafe-eval')
})

it('names no Worker when the build has none, or a URL that does not parse', () => {
  expect(viewerCsp({})).toContain("connect-src 'self' https://api.github.com;")
  expect(viewerCsp({ workerUrl: 'not a url' })).toContain("connect-src 'self' https://api.github.com;")
})

it('writes every header for every path, and a long cache for the hashed assets only', () => {
  const file = headersFile({ workerUrl: 'https://auth.example.com' })
  const [pages, assets] = file.split('\n\n')
  expect(pages!.split('\n')[0]).toBe('/*')
  for (const [name, value] of Object.entries(viewerHeaders({ workerUrl: 'https://auth.example.com' }))) {
    expect(pages).toContain(`  ${name}: ${value}`)
  }
  expect(pages).toContain('  Referrer-Policy: no-referrer')
  expect(pages).not.toContain('Cache-Control')
  expect(assets).toBe('/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n')
})
