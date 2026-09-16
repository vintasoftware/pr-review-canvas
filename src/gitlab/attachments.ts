import type { Repo } from '../contract/review-artifact.js'
import type { AttachmentLink } from '../github/attachments.js'
import type { HostInfo } from '../host/host.js'

const MARKDOWN_LINK_RE = /\[([A-Za-z0-9._-]+\.zip)\]\(([^)\s]+)\)/g
const BARE_UPLOAD_RE = /https?:\/\/[^\s)]+\/uploads\/[A-Za-z0-9/_-]+\/([A-Za-z0-9._-]+\.zip)/gi
const RELATIVE_UPLOAD_RE = /(?:^|[\s(])(\/uploads\/[A-Za-z0-9/_-]+\/([A-Za-z0-9._-]+\.zip))/g

function projectBase(host: HostInfo, repo: Repo): string {
  return `${host.webBase}/${repo.owner}/${repo.name}`
}

function resolveLink(raw: string, host: HostInfo, repo: Repo): string | null {
  try {
    const href = raw.startsWith('/uploads/') ? `${projectBase(host, repo)}${raw}` : raw
    const url = new URL(href, `${projectBase(host, repo)}/`)
    if (url.protocol !== 'https:') {
      return null
    }
    if (url.hostname.toLowerCase() !== host.hostname.toLowerCase()) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Zip links in GitLab markdown: `[name.zip](url)`, a `/uploads/.../name.zip` path, or a full
 * URL on this GitLab host.
 */
export function findGitlabAttachmentLinks(text: string, host: HostInfo, repo: Repo): AttachmentLink[] {
  const links: AttachmentLink[] = []
  const seen = new Set<string>()
  const add = (url: string, name: string) => {
    if (seen.has(url)) {
      return
    }
    seen.add(url)
    links.push({ url, name })
  }
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const name = m[1]
    const href = m[2]
    if (name === undefined || href === undefined) {
      continue
    }
    const url = resolveLink(href, host, repo)
    if (url !== null) {
      add(url, name)
    }
  }
  for (const m of text.matchAll(BARE_UPLOAD_RE)) {
    const url = m[0]
    const name = m[1]
    if (name === undefined) {
      continue
    }
    const resolved = resolveLink(url, host, repo)
    if (resolved !== null) {
      add(resolved, name)
    }
  }
  for (const m of text.matchAll(RELATIVE_UPLOAD_RE)) {
    const path = m[1]
    const name = m[2]
    if (path === undefined || name === undefined) {
      continue
    }
    const url = resolveLink(path, host, repo)
    if (url !== null) {
      add(url, name)
    }
  }
  return links
}

export function gitlabAttachmentHosts(host: HostInfo): Set<string> {
  return new Set([host.hostname])
}

export function gitlabAuthHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
