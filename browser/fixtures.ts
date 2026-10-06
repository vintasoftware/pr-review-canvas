import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { test as base, expect, type Page } from '@playwright/test'
import { createHubApp } from '../src/hub/hub-app.js'
import { createHub } from '../src/hub/hub.js'
import { resolveVendorRoots } from '../src/server/context.js'
import { DEFAULT_PROJECT_CONFIG } from '../src/project-config.js'
import { createFakeRunner, type FakeRunnerOptions } from '../src/testing/fake-runner.js'
import {
  createFakeCheckoutGit,
  ghHandler,
  ghPost,
  makeTestContext,
  type TestContext,
  type TestContextOptions,
} from '../src/testing/fakes.js'
import {
  GH_ISSUE_COMMENTS,
  GH_REVIEW_COMMENTS,
  ghFor42,
  gitFor42,
  syntheticArtifact,
} from '../src/testing/synthetic.js'

export { expect } from '@playwright/test'

/** What a chat-enabled server is built with: how the fake agent and the fake checkout behave. */
export interface ChatServerOptions {
  runner?: FakeRunnerOptions
  checkout?: { delayMs?: number; fail?: string }
  /** Runs against the server's context before the page loads, e.g. to save settings. */
  setup?: (t: TestContext) => Promise<void>
  /** Serve PR 42 with no canvas, so the page starts on the empty screen. */
  noCanvas?: boolean
}

/** A review server with AI Chat on, driven by a fake agent and fake review checkouts. */
export interface ChatServer {
  url: string
  ctx: TestContext['ctx']
}

const POSTED_INLINE = ghPost(body => ({
  ...GH_REVIEW_COMMENTS[0],
  ...(body as Record<string, unknown>),
  id: 5001,
  html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
}))

export const test = base.extend<{
  reviewUrl: string
  selfReviewUrl: string
  chatServer: (options?: ChatServerOptions) => Promise<ChatServer>
}>({
  chatServer: async ({ page }, use) => {
    const stops: Array<() => Promise<void>> = []
    await use(async (options = {}) => {
      const server = await startServer(page, {
        projectConfig: {
          config: { ...DEFAULT_PROJECT_CONFIG, chat: { ...DEFAULT_PROJECT_CONFIG.chat, enabled: true } },
          warnings: [],
          source: null,
        },
        runner: createFakeRunner(options.runner),
        checkoutGit: createFakeCheckoutGit(options.checkout),
        ...(options.noCanvas ? { fixtureArtifact: null } : {}),
      })
      stops.push(server.stop)
      await options.setup?.(server.t)
      return { url: server.url, ctx: server.t.ctx }
    })
    for (const stop of stops) {
      await stop()
    }
  },
  reviewUrl: async ({ page }, use) => {
    const server = await startServer(page)
    try {
      await use(server.url)
    } finally {
      await server.stop()
    }
  },
  /** PR #42 with a published canvas, served to its author, who may settle its points. */
  selfReviewUrl: async ({ page }, use) => {
    let shared: Record<string, unknown> | null = null
    const share = ghPost(body => {
      shared = {
        ...GH_ISSUE_COMMENTS[0],
        ...(body as object),
        id: 6001,
        html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
      }
      return shared
    })
    const server = await startServer(page, {
      gh: ghFor42({
        routes: {
          'repos/acme/widgets/issues/42/comments': ghHandler(() =>
            shared === null ? GH_ISSUE_COMMENTS : [...GH_ISSUE_COMMENTS, shared]
          ),
        },
        postRoutes: {
          'repos/acme/widgets/pulls/42/comments': POSTED_INLINE,
          'repos/acme/widgets/issues/42/comments': share,
          'repos/acme/widgets/issues/comments/6001': share,
        },
      }),
      fixtureArtifact: null,
    })
    try {
      const artifact = syntheticArtifact()
      await server.t.ctx.canvases.write(artifact.pr.headSha, artifact, {
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
      await use(server.url)
    } finally {
      await server.stop()
    }
  },
})

/** Serves PR 42 on a free port; `stop` fails the test if the page threw or a request 500ed. */
async function startServer(
  page: Page,
  extra: Partial<TestContextOptions> = {}
): Promise<{ url: string; t: TestContext; stop: () => Promise<void> }> {
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
      routes: {
        'repos/acme/widgets/pulls/42/reviews/7001/comments': ghHandler(() =>
          submitted.map(
            ({ line: _line, start_line: _start, side: _side, original_line: _original, ...c }) => ({
              ...c,
              position: 17,
            })
          )
        ),
        'repos/acme/widgets/pulls/42/comments': ghHandler(() => [...GH_REVIEW_COMMENTS, ...submitted]),
        'repos/acme/widgets/pulls/comments/8001': ghHandler(() => submitted[0]),
        'repos/acme/widgets/pulls/comments/8002': ghHandler(() => submitted[1]),
      },
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
            pull_request_review_id: 7001,
            commit_id: input.commit_id,
            original_line: comment['line'],
            original_start_line: comment['start_line'] ?? null,
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
    ...extra,
  })
  // Closing the server drops the sockets, not the handlers: a request the page fired and the test
  // never waited for (a rebuild of `derived/` behind a reload or refresh) keeps writing into the
  // data dir. `stop` waits for every handler to return before that dir is removed, or `rm` races
  // the write and fails with ENOTEMPTY.
  // Served as the shared server serves it: under the project's base path, behind the hub's front.
  let port = 0
  const hub = await createHub({ registry: t.dataDir, load: async () => t.ctx, log: () => undefined })
  await hub.register({ repoRoot: t.ctx.config.repoRoot })
  const app = createHubApp({
    hub,
    home: t.dataDir,
    token: 'test-token',
    version: t.ctx.version,
    port: () => port,
    staticDir: t.ctx.staticDir,
    vendorRoots: t.ctx.vendorRoots,
    log: () => undefined,
  })
  const inFlight = new Set<Request>()
  const settled: Array<() => void> = []
  const fetch = async (request: Request): Promise<Response> => {
    inFlight.add(request)
    try {
      return await app.fetch(request)
    } finally {
      inFlight.delete(request)
      if (inFlight.size === 0) settled.splice(0).forEach(resolve => resolve())
    }
  }
  const server = serve({ fetch, port: 0, hostname: '127.0.0.1' })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind a port')
  }
  port = address.port
  const origin = `http://127.0.0.1:${address.port}`
  const stop = async (): Promise<void> => {
    try {
      hub.close()
      if ('closeAllConnections' in server) {
        server.closeAllConnections()
      }
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
      if (inFlight.size > 0) {
        await new Promise<void>(resolve => settled.push(resolve))
      }
    } finally {
      await t.cleanup()
    }
    expect(errors).toEqual([])
  }
  return { url: `${origin}${t.ctx.config.basePath}review/42`, t, stop }
}
