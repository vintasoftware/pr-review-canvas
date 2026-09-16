// Finding the canvas zip a human attached to the pull request and downloading it with the gh
// token. The token is read per request, passed to github.com only, and never logged or stored.
import { createHash } from 'node:crypto'
import { importCanvas } from '../canvas/import.js'
import { type ParsedCanvasName, parseCanvasZipName } from '../canvas/name.js'
import { CANVAS_ZIP_MAX_BYTES, hasZipMagic } from '../canvas/zip.js'
import type { ImportResult, SharedCanvasInfo } from '../contract/api.js'
import type { CommentsPayload } from '../contract/comments.js'
import type { Pr, Repo } from '../contract/review-artifact.js'
import { BodyTooLargeError, readCappedBody } from '../server/capped-body.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'

/** Where an attachment may be served from. Everything else is refused before any request. */
export const ALLOWED_ATTACHMENT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com'])
export const MAX_REDIRECTS = 3
export const DOWNLOAD_TIMEOUT_MS = 30_000

export type DownloadFailure = NonNullable<SharedCanvasInfo['reason']>

export interface AttachmentLink {
  url: string
  name: string
}

const FILE_LINK_RE = /https:\/\/github\.com\/user-attachments\/files\/\d+\/([A-Za-z0-9._-]+\.zip)/g
const ASSET_LINK_RE =
  /\[([A-Za-z0-9._-]+\.zip)\]\((https:\/\/github\.com\/user-attachments\/assets\/[0-9a-fA-F-]{36})\)/g

/**
 * Zip links in one markdown text. GitHub serves an attachment either under `files/<id>/<name>`,
 * where the name is in the URL, or under `assets/<uuid>`, where only the markdown label has it.
 */
export function findAttachmentLinks(text: string): AttachmentLink[] {
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

export interface AttachmentCandidate extends AttachmentLink {
  parsed: ParsedCanvasName
  /**
   * When the text carrying the link was last edited. A link added to an old comment counts from
   * the edit, which is when the attachment appeared.
   */
  postedAt: string
  /** Position in the scan, used when two links carry the same time. */
  order: number
}

export interface DiscoverySources {
  /** The PR body and the time the pull request was last edited. */
  body: string
  bodyUpdatedAt: string
  comments: CommentsPayload
}

/** Every link in the PR body and its comments whose name is a canvas zip of this repository. */
export function collectCandidates(sources: DiscoverySources, repo: Repo): AttachmentCandidate[] {
  const texts: Array<{ text: string; postedAt: string }> = [
    { text: sources.body, postedAt: sources.bodyUpdatedAt },
    ...sources.comments.issueComments.map(c => ({ text: c.body, postedAt: c.updatedAt })),
    ...sources.comments.reviewComments.map(c => ({ text: c.body, postedAt: c.updatedAt })),
  ]
  const candidates: AttachmentCandidate[] = []
  let order = 0
  for (const { text, postedAt } of texts) {
    for (const link of findAttachmentLinks(text)) {
      const parsed = parseCanvasZipName(link.name, repo)
      if (parsed !== null) {
        candidates.push({ ...link, parsed, postedAt, order: order++ })
      }
    }
  }
  return candidates
}

/** The canvas for this head wins, then one exported for this PR, then the one attached last. */
export function rankCandidates(
  candidates: AttachmentCandidate[],
  target: { headSha: string; prNumber: number }
): AttachmentCandidate[] {
  const shaPrefix = target.headSha.slice(0, 8)
  const score = (c: AttachmentCandidate): number =>
    (c.parsed.shaPrefix === shaPrefix ? 2 : 0) + (c.parsed.prNumber === target.prNumber ? 1 : 0)
  return [...candidates].sort(
    (a, b) => score(b) - score(a) || b.postedAt.localeCompare(a.postedAt) || b.order - a.order
  )
}

/** How many attachments one scan tries before it reports the best one as unusable. */
export const MAX_CANDIDATES_TRIED = 3

/**
 * A fingerprint of everything discovery reads, so an unchanged pull request is not scanned again.
 * It covers the text of every comment, because an edit can swap one zip link for another, and the
 * head sha, because the ranking and `matchesHead` are answers about that commit.
 */
export function discoveryFingerprint(body: string, comments: CommentsPayload, headSha: string): string {
  const hash = createHash('sha1')
  hash.update(`${headSha}\n${body}`)
  for (const c of [...comments.issueComments, ...comments.reviewComments]) {
    hash.update(`\u0000${c.id}:${c.createdAt}:${c.body}`)
  }
  return hash.digest('hex')
}

export type DownloadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: DownloadFailure }

function allowedUrl(raw: string, base?: string): URL | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  return url.protocol === 'https:' && ALLOWED_ATTACHMENT_HOSTS.has(url.hostname) ? url : null
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Downloads one attachment. GitHub answers the first request with a redirect to a signed storage
 * URL; that request carries no Authorization header, because storage refuses a request holding
 * both a signature and a token.
 */
export async function downloadAttachment(ctx: AppContext, rawUrl: string): Promise<DownloadResult> {
  const first = allowedUrl(rawUrl)
  if (first === null) {
    return { ok: false, reason: 'network' }
  }
  const token = await ctx.gh.authToken()
  if (token === null) {
    return { ok: false, reason: 'auth-required' }
  }
  let url = first
  // Storage refuses a request that carries both a signature and a token, and the token has no
  // business there anyway: only github.com is ever asked with it.
  let withToken = url.hostname === 'github.com'
  // One deadline for the redirects and the body together, so three slow hops cannot add up.
  const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const accept = 'application/octet-stream'
      const headers = withToken ? { accept, authorization: `token ${token}` } : { accept }
      const res: Response = await ctx.fetch(url, {
        headers,
        redirect: 'manual',
        signal: deadline,
      })
      if (REDIRECT_STATUSES.has(res.status)) {
        const next = allowedUrl(res.headers.get('location') ?? '', url.toString())
        if (next === null) {
          return { ok: false, reason: 'network' }
        }
        url = next
        withToken = false
        continue
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { ok: false, reason: 'auth-required' }
      }
      if (res.status !== 200) {
        return { ok: false, reason: 'network' }
      }
      let bytes: Uint8Array
      try {
        bytes = await readCappedBody(res, CANVAS_ZIP_MAX_BYTES)
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return { ok: false, reason: 'too-large' }
        }
        throw err
      }
      return hasZipMagic(bytes) ? { ok: true, bytes } : { ok: false, reason: 'not-zip' }
    }
  } catch {
    // A network failure, a timeout, or a body that stopped mid-stream all read the same here.
    return { ok: false, reason: 'network' }
  }
  return { ok: false, reason: 'network' }
}

/** A downloaded zip that import refused, told in the words the callout uses. */
export function importFailureReason(err: unknown): DownloadFailure {
  if (!(err instanceof AppError)) {
    return 'not-zip'
  }
  if (err.code === 'CANVAS_TOO_LARGE') {
    return 'too-large'
  }
  if (err.code === 'CANVAS_PR_MISMATCH') {
    return 'pr-mismatch'
  }
  return err.code === 'CANVAS_REPO_MISMATCH' ? 'name-mismatch' : 'not-zip'
}

export interface DiscoveryOutcome {
  sharedCanvas: SharedCanvasInfo | null
  imported: ImportResult | null
  warnings: string[]
}

/**
 * Looks for a canvas attached to the PR and imports the best one. A found-but-unusable zip is
 * reported to the page, which offers the link and the drop zone instead.
 */
export async function discoverSharedCanvas(
  ctx: AppContext,
  pr: Pr,
  comments: CommentsPayload
): Promise<DiscoveryOutcome> {
  if (pr.number === null) {
    return { sharedCanvas: null, imported: null, warnings: [] }
  }
  const sources: DiscoverySources = { body: pr.body, bodyUpdatedAt: pr.updatedAt ?? '', comments }
  const ranked = rankCandidates(collectCandidates(sources, ctx.config.repo), {
    headSha: pr.headSha,
    prNumber: pr.number,
  })
  const best = ranked[0]
  if (best === undefined) {
    return { sharedCanvas: null, imported: null, warnings: [] }
  }
  const warnings: string[] = []
  const first = await tryCandidate(ctx, pr, pr.number, best)
  warnings.push(...first.warnings)
  if (first.imported !== null) {
    return { ...first, warnings }
  }
  // A broken attachment must not hide a good one behind it, so the next ones are tried too.
  for (const candidate of ranked.slice(1, MAX_CANDIDATES_TRIED)) {
    const attempt = await tryCandidate(ctx, pr, pr.number, candidate)
    warnings.push(...attempt.warnings)
    if (attempt.imported !== null) {
      return { ...attempt, warnings }
    }
  }
  // Every attachment failed; the page shows the best one, its reason, and the drop zone.
  return { ...first, warnings }
}

/** One attachment: download it and import it, or say why that did not work. */
async function tryCandidate(
  ctx: AppContext,
  pr: Pr,
  prNumber: number,
  candidate: AttachmentCandidate
): Promise<DiscoveryOutcome> {
  const shared = {
    url: candidate.url,
    name: candidate.name,
    matchesHead: candidate.parsed.shaPrefix === pr.headSha.slice(0, 8),
  }
  // A name that carries another pull request's number is a zip attached to the wrong PR. Import
  // would refuse it anyway, so it is reported without spending a download on it.
  if (candidate.parsed.prNumber !== undefined && candidate.parsed.prNumber !== prNumber) {
    return {
      sharedCanvas: { ...shared, downloadable: false, reason: 'pr-mismatch' },
      imported: null,
      warnings: [`${candidate.name} was exported for #${candidate.parsed.prNumber}, not #${prNumber}`],
    }
  }
  const download = await downloadAttachment(ctx, candidate.url)
  if (!download.ok) {
    return {
      sharedCanvas: { ...shared, downloadable: false, reason: download.reason },
      imported: null,
      warnings: [],
    }
  }
  try {
    const imported = await importCanvas(ctx, {
      bytes: download.bytes,
      prNumber,
      currentHeadSha: pr.headSha,
    })
    return { sharedCanvas: { ...shared, downloadable: true }, imported, warnings: imported.warnings }
  } catch (err) {
    return {
      sharedCanvas: { ...shared, downloadable: false, reason: importFailureReason(err) },
      imported: null,
      warnings: [err instanceof Error ? err.message : String(err)],
    }
  }
}
