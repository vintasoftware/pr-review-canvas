// The bundle the tour page opens with: the tour for the key, the reader's state, and who is reading.
import type { ChatStatus } from '../contract/api.js'
import type { TourBundle, TourPageLandmark, TourPageTour } from '../contract/tour-api.js'
import { isLocalKey, keyToString, type ReviewKey } from '../contract/review-key.js'
import type { TourArtifact } from '../contract/tour.js'
import { isAuthor } from '../review/self-review.js'
import type { PrLoader } from '../server/bundle.js'
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

export async function resolveTourBundle(
  ctx: AppContext,
  loader: PrLoader,
  key: ReviewKey,
  opts: { preview?: boolean | undefined } = {}
): Promise<TourBundle> {
  const found = await lookupTour(ctx, loader, key, opts)
  const reviewer = await tourReviewer(ctx, key, found.pr)
  const config = ctx.projectConfig.config.tour
  const base: TourBundle = {
    status: found.status,
    key,
    pr: found.pr,
    reader: {
      step: 0,
      picks: {},
      quiz: {},
      notes: {},
      codeOpen: {},
      codeView: {},
      returnTo: null,
      audioNoticeSeen: false,
      audioOff: false,
    },
    reviewer,
    preview: found.preview,
    shares: !isLocalKey(key) && !found.preview && (await tourSharingOn(ctx)),
    options: {
      finalQuiz: config.finalQuiz,
      reverseQuiz: config.reverseQuiz,
      grill: config.grill,
      audio: config.audio,
    },
    chat: await tourChatStatus(ctx),
    skillCommand: `/pr-tour ${keyToString(key)}`,
    warnings: [...ctx.projectConfig.warnings],
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
