import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { test as base, expect, type Page } from '@playwright/test'
import { createApp } from '../src/server/app.js'
import { resolveVendorRoots } from '../src/server/context.js'
import { ghHandler, ghPost, makeTestContext } from '../src/testing/fakes.js'
import {
  GH_ISSUE_COMMENTS,
  GH_REVIEW_COMMENTS,
  ghFor42,
  gitFor42,
  syntheticArtifact,
} from '../src/testing/synthetic.js'

export { expect } from '@playwright/test'

type TestContext = Awaited<ReturnType<typeof makeTestContext>>

/** Serves the app of `t` on a free port and hands `use` the URL of PR #42, failing on page errors. */
async function serveReview(page: Page, t: TestContext, use: (url: string) => Promise<void>): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 500) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
  const server = serve({ fetch: createApp(t.ctx).fetch, port: 0, hostname: '127.0.0.1' })
  try {
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not bind a port')
    }
    await use(`http://127.0.0.1:${address.port}/review/42`)
    expect(errors).toEqual([])
  } finally {
    try {
      if ('closeAllConnections' in server) {
        server.closeAllConnections()
      }
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    } finally {
      await t.cleanup()
    }
  }
}

const POSTED_INLINE = ghPost(body => ({
  ...GH_REVIEW_COMMENTS[0],
  ...(body as Record<string, unknown>),
  id: 5001,
  html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
}))

export const test = base.extend<{ reviewUrl: string; selfReviewUrl: string }>({
  reviewUrl: async ({ page }, use) => {
    let submitted: Array<Record<string, unknown>> = []
    const t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42({
        routes: { 'repos/acme/widgets/pulls/42/reviews/7001/comments': ghHandler(() => submitted) },
        postRoutes: {
          'repos/acme/widgets/pulls/42/reviews': ghPost(body => {
            const input = body as {
              comments?: Array<Record<string, unknown>>
              event: string
              commit_id: string
            }
            submitted = (input.comments ?? []).map((comment, index) => ({
              ...GH_REVIEW_COMMENTS[0],
              ...comment,
              id: 8001 + index,
              commit_id: input.commit_id,
              original_line: comment['line'],
              html_url: `https://github.com/acme/widgets/pull/42#discussion_r${8001 + index}`,
            }))
            return {
              id: 7001,
              state: 'COMMENTED',
              html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
            }
          }),
          'repos/acme/widgets/pulls/42/comments': POSTED_INLINE,
        },
      }),
      fixtureArtifact: syntheticArtifact(),
      vendorRoots: resolveVendorRoots(),
    })
    await serveReview(page, t, use)
  },
  /** PR #42 with a published canvas, served to its author, who may settle its points. */
  selfReviewUrl: async ({ page }, use) => {
    const t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42({
        postRoutes: {
          'repos/acme/widgets/pulls/42/comments': POSTED_INLINE,
          'repos/acme/widgets/issues/42/comments': ghPost(() => ({
            ...GH_ISSUE_COMMENTS[0],
            id: 6001,
            html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
          })),
        },
      }),
      vendorRoots: resolveVendorRoots(),
    })
    // The drawn point, fp-1, is marked for the author so it can be settled.
    const synthetic = syntheticArtifact()
    const artifact = {
      ...synthetic,
      points: synthetic.points.map(p =>
        p.fingerprint === 'fp-1' ? { ...p, audience: 'author' as const } : p
      ),
    }
    await t.ctx.canvases.write(artifact.pr.headSha, artifact, {
      formatVersion: 1,
      tool: { name: 'pr-review', version: '0.0.0-test' },
      repo: artifact.pr.repo,
      prNumber: 42,
      headSha: artifact.pr.headSha,
      mergeBaseSha: artifact.pr.mergeBaseSha,
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt: artifact.generatedAt,
      generator: artifact.generator,
    })
    await serveReview(page, t, use)
  },
})
