// The bundle the tour page opens with: the tour for the key, the reader's state, and who is reading.
import type { ChatStatus } from '../contract/api.js'
import {
  freshReaderState,
  type TourBundle,
  type TourGeneratePermission,
  type TourPageLandmark,
  type TourPageTour,
} from '../contract/tour-api.js'
import { isLocalKey, keyToString, type ReviewKey } from '../contract/review-key.js'
import type { TourArtifact } from '../contract/tour.js'
import { isAuthor } from '../review/self-review.js'
import type { CommentsPayload } from '../contract/comments.js'
import type { Pr } from '../contract/review-artifact.js'
import { discoveryFingerprint } from '../host/attachments.js'
import type { BundleOptions, PrLoader } from '../server/bundle.js'
import { fetchSharedTour } from './import.js'
import type { AppContext } from '../server/context.js'
import { lookupTour } from './lookup.js'
import { readReaderState } from './reader.js'
import { tourSharingOn } from './share.js'

/** The tour without its scenes' HTML: the page frames those from their own route. */
export function pageTour(artifact: TourArtifact): TourPageTour {
  return {
    ...artifact,
    landmarks: artifact.landmarks.map(({ scene, micro, ...rest }): TourPageLandmark => ({
      ...rest,
      scene: typeof scene === 'string',
      micro: typeof micro === 'string',
    })),
  }
}

/** Who reads: the login the server runs as, and whether it wrote the change. Local work is one's own. */
export async function tourReviewer(
  ctx: AppContext,
  key: ReviewKey,
  pr: { author: string }
): Promise<TourBundle['reviewer']> {
  if (isLocalKey(key)) return { login: null, author: true }
  const { login } = await ctx.capabilities.get()
  return { login, author: isAuthor(login, pr) }
}

/**
 * Whether this reader may start a tour generation from the review app, by `tour.generate`. The
 * agent runs with every permission while it reads the diff, so a diff someone else wrote could
 * steer it: by default only the author, or the owner of local work, may.
 */
export function tourGeneratePermission(
  ctx: AppContext,
  reviewer: TourBundle['reviewer']
): TourGeneratePermission {
  const rule = ctx.projectConfig.config.tour.generate
  if (rule === 'off') return 'off'
  return rule === 'on' || reviewer.author ? 'allowed' : 'not-author'
}

/** Whether the grilling can run: chat is on for the project and acpx is on the PATH. */
export async function tourChatStatus(ctx: AppContext): Promise<ChatStatus> {
  const enabled = ctx.projectConfig.config.chat.enabled
  if (!enabled) return { enabled: false, acpx: false }
  const [acpx, settings] = await Promise.all([ctx.preflight.get(), ctx.chat.effectiveSettings()])
  return {
    enabled: acpx.installed,
    acpx: acpx.installed,
    agent: settings.chatAgent,
    model: settings.chatModel,
  }
}

/**
 * The head the page shows, resolved as the review page resolves it: a pull request's asks the forge
 * whether it moved (on a poll, the one last read), and local work is read again, so a tour whose
 * head moved since it was generated shows as outdated. A pull request's comments come with it.
 */
async function currentHead(
  loader: PrLoader,
  key: ReviewKey,
  opts: BundleOptions
): Promise<{ pr: Pr; comments: CommentsPayload | null; warnings: string[] }> {
  if (isLocalKey(key)) return { pr: await loader.localHead(key, opts), comments: null, warnings: [] }
  return loader.load(key, opts)
}

/**
 * The comments each pull request's shared tours were last looked for in, by a fingerprint of them
 * and the head, so the page looks again only when someone commented or pushed.
 */
const lookedAt = new Map<string, string>()

/**
 * Looks on the pull request for a tour someone shared, as the review page does for a canvas, when the
 * page has no tour of the head: imports the best one and says whether it did.
 */
async function discoverSharedTour(
  ctx: AppContext,
  pr: Pr,
  comments: CommentsPayload,
  refresh: boolean
): Promise<{ imported: boolean; warnings: string[] }> {
  const memo = `${ctx.tours.root}#${String(pr.number)}`
  const fingerprint = discoveryFingerprint('', comments, pr.headSha)
  if (!refresh && lookedAt.get(memo) === fingerprint) return { imported: false, warnings: [] }
  lookedAt.set(memo, fingerprint)
  const { imported, warnings } = await fetchSharedTour(ctx, pr, comments)
  return { imported, warnings }
}

export async function resolveTourBundle(
  ctx: AppContext,
  loader: PrLoader,
  key: ReviewKey,
  opts: { preview?: boolean | undefined; refresh?: boolean | undefined; poll?: boolean | undefined } = {}
): Promise<TourBundle> {
  const load: BundleOptions = { refresh: opts.refresh === true, poll: opts.poll === true }
  const head = await currentHead(loader, key, load)
  const warnings = [...ctx.projectConfig.warnings, ...head.warnings]
  const lookup = { preview: opts.preview, pr: head.pr }
  let found = await lookupTour(ctx, loader, key, lookup)
  if (head.comments !== null && !found.preview && found.status !== 'ready') {
    const shared = await discoverSharedTour(ctx, head.pr, head.comments, load.refresh)
    warnings.push(...shared.warnings)
    if (shared.imported) found = await lookupTour(ctx, loader, key, lookup)
  }
  const reviewer = await tourReviewer(ctx, key, found.pr)
  const config = ctx.projectConfig.config.tour
  const base: TourBundle = {
    status: found.status,
    key,
    pr: found.pr,
    reader: freshReaderState(),
    reviewer,
    preview: found.preview,
    shares: !isLocalKey(key) && !found.preview && (await tourSharingOn(ctx)),
    options: {
      finalQuiz: config.finalQuiz,
      grill: config.grill,
      audio: config.audio,
    },
    chat: await tourChatStatus(ctx),
    generate: tourGeneratePermission(ctx, reviewer),
    skillCommand: `/pr-tour ${keyToString(key)}`,
    warnings,
  }
  if (isLocalKey(key)) base.local = key
  if (found.status === 'missing') return base
  const bundle: TourBundle = { ...base, tour: pageTour(found.artifact) }
  if (!found.preview)
    bundle.reader = await readReaderState(ctx, found.headSha, found.artifact, reviewer.author)
  if (found.status === 'stale') bundle.stale = found.stale
  if (found.preview) bundle.warnings.push('previewing tour-model.json as written: nothing is saved')
  return bundle
}
