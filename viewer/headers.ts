// The response headers of the hosted viewer, written at build time to `_headers`, the file
// Cloudflare Pages reads them from. ADR 0005: the page holds a GitHub token, so it may load script
// only from its own origin and talk only to GitHub's API and the auth Worker.

/** Where GitHub serves the images a pull request shows: avatars, attachments, proxied images. */
const GITHUB_IMAGES = [
  'https://avatars.githubusercontent.com',
  'https://github.com',
  'https://*.githubusercontent.com',
]

/** The origin of the auth Worker's URL, or null when the build names none or a bad one. */
function originOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === '') return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The Content-Security-Policy. Inline styles are allowed, as the local app allows them: the page
 * sets progress widths and colors that way, and mermaid writes a style element per diagram.
 * Images come from GitHub only, so text in a pull request cannot make the page load a tracker.
 */
export function viewerCsp(opts: { workerUrl?: string | undefined }): string {
  const worker = originOf(opts.workerUrl)
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${GITHUB_IMAGES.join(' ')}`,
    "font-src 'self'",
    `connect-src 'self' https://api.github.com${worker === null ? '' : ` ${worker}`}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ')
}

/** Every header the viewer's pages carry, by name. */
export function viewerHeaders(opts: { workerUrl?: string | undefined }): Record<string, string> {
  return {
    'Content-Security-Policy': viewerCsp(opts),
    'X-Content-Type-Options': 'nosniff',
    // The address can hold a pull request's name, and holds GitHub's sign-in code on the way back.
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=31536000',
  }
}

/** The `_headers` file: the headers on every path, and a year's cache for the hashed assets. */
export function headersFile(opts: { workerUrl?: string | undefined }): string {
  const all = Object.entries(viewerHeaders(opts)).map(([name, value]) => `  ${name}: ${value}`)
  return ['/*', ...all, '', '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join(
    '\n'
  )
}
