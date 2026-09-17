import type { Repo } from '../contract/review-artifact.js'
import type { HostAttachments } from '../host/host.js'

const MARKDOWN_LINK_RE = /\[([A-Za-z0-9._-]+\.zip)\]\(([^)\s]+)\)/g
const UPLOAD_URL_RE = /https?:\/\/[^\s)]+\/uploads\/[A-Za-z0-9/_-]+\/([A-Za-z0-9._-]+\.zip)/gi
const UPLOAD_PATH_RE = /(?:^|[\s(])(\/uploads\/[A-Za-z0-9/_-]+\/([A-Za-z0-9._-]+\.zip))/g

/**
 * Zip links in GitLab markdown: `[name.zip](url)`, a project-relative `/uploads/.../name.zip`
 * path as the editor inserts it, or a full URL on this instance. The instance serves its uploads
 * itself, so that one hostname is the whole allow list and the token goes in a Bearer header.
 */
export function gitlabAttachments(hostname: string, webBase: string): HostAttachments {
  const resolve = (raw: string, repo: Repo): string | null => {
    const projectBase = `${webBase}/${repo.owner}/${repo.name}`
    try {
      const url = new URL(raw.startsWith('/uploads/') ? `${projectBase}${raw}` : raw, `${projectBase}/`)
      return url.protocol === 'https:' && url.host === hostname ? url.toString() : null
    } catch {
      return null
    }
  }
  return {
    findLinks(text, repo) {
      const found = new Map<string, string>()
      const add = (href: string | undefined, name: string | undefined): void => {
        const url = href === undefined || name === undefined ? null : resolve(href, repo)
        if (url !== null && !found.has(url)) {
          found.set(url, name as string)
        }
      }
      for (const m of text.matchAll(MARKDOWN_LINK_RE)) add(m[2], m[1])
      for (const m of text.matchAll(UPLOAD_URL_RE)) add(m[0], m[1])
      for (const m of text.matchAll(UPLOAD_PATH_RE)) add(m[1], m[2])
      return [...found].map(([url, name]) => ({ url, name }))
    },
    allowedHosts: new Set([hostname]),
    authHeader: token => ({ authorization: `Bearer ${token}` }),
  }
}
