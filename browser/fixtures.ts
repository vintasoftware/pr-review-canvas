import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { test as base, expect } from '@playwright/test'
import { createApp } from '../src/server/app.js'
import { resolveVendorRoots } from '../src/server/context.js'
import { ghHandler, ghPost, makeTestContext } from '../src/testing/fakes.js'
import { GH_REVIEW_COMMENTS, ghFor42, gitFor42, syntheticArtifact } from '../src/testing/synthetic.js'

export { expect } from '@playwright/test'

export const test = base.extend<{ reviewUrl: string }>({
  reviewUrl: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 500) {
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
      }
    })
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
          'repos/acme/widgets/pulls/42/comments': ghPost(body => ({
            ...GH_REVIEW_COMMENTS[0],
            ...(body as Record<string, unknown>),
            id: 5001,
            html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
          })),
        },
      }),
      fixtureArtifact: syntheticArtifact(),
      vendorRoots: resolveVendorRoots(),
    })
    const server = serve({ fetch: createApp(t.ctx).fetch, port: 0, hostname: '127.0.0.1' })
    try {
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('test server did not bind a port')
      }
      const origin = `http://127.0.0.1:${address.port}`
      await use(`${origin}/review/42`)
      expect(errors).toEqual([])
    } finally {
      try {
        if ('closeAllConnections' in server) {
          server.closeAllConnections()
        }
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      } finally {
        await t.cleanup()
      }
    }
  },
})
