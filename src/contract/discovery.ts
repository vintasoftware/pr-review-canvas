import { z } from 'zod'

export const SharedCanvasInfoSchema = z.object({
  url: z.string(),
  name: z.string(),
  matchesHead: z.boolean(),
  downloadable: z.boolean(),
  reason: z.enum(['auth-required', 'not-zip', 'too-large', 'network', 'name-mismatch']).optional(),
})

/**
 * The result of one attachment scan, kept next to the PR. `fingerprint` covers the PR body and
 * its comments: the scan runs again when one of them changes, or when the user asks for it.
 */
export const DiscoveryCacheSchema = z.object({
  fingerprint: z.string(),
  checkedAt: z.string(),
  sharedCanvas: SharedCanvasInfoSchema.nullable(),
})
export type DiscoveryCache = z.infer<typeof DiscoveryCacheSchema>
