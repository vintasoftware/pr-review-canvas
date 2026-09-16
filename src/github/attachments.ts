import type { AttachmentLink } from '../host/attachments.js'
import type { HostAttachments } from '../host/host.js'

const FILE_LINK_RE = /https:\/\/github\.com\/user-attachments\/files\/\d+\/([A-Za-z0-9._-]+\.zip)/g
const ASSET_LINK_RE =
  /\[([A-Za-z0-9._-]+\.zip)\]\((https:\/\/github\.com\/user-attachments\/assets\/[0-9a-fA-F-]{36})\)/g

/**
 * Zip links in one markdown text. GitHub serves an attachment either under `files/<id>/<name>`,
 * where the name is in the URL, or under `assets/<uuid>`, where only the markdown label has it.
 */
export function findGithubAttachmentLinks(text: string): AttachmentLink[] {
  const links: AttachmentLink[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(FILE_LINK_RE)) {
    const [url, name] = [m[0], m[1]]
    if (name !== undefined && !seen.has(url)) {
      seen.add(url)
      links.push({ url, name })
    }
  }
  for (const m of text.matchAll(ASSET_LINK_RE)) {
    const [, name, url] = m
    if (name !== undefined && url !== undefined && !seen.has(url)) {
      seen.add(url)
      links.push({ url, name })
    }
  }
  return links
}

/**
 * github.com answers an attachment request with a redirect to signed object storage, which must
 * not see the token: the header is for github.com alone.
 */
export const GITHUB_ATTACHMENTS: HostAttachments = {
  findLinks: findGithubAttachmentLinks,
  allowedHosts: new Set(['github.com', 'objects.githubusercontent.com']),
  authHeader: token => ({ authorization: `token ${token}` }),
}
