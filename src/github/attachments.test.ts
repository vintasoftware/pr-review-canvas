// @vitest-environment node
import { buildCanvasZip } from '../canvas/zip.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { CommentsPayload } from '../contract/comments.js'
import { emptyComments } from '../contract/comments.js'
import type { Pr } from '../contract/review-artifact.js'
import { AppError } from '../server/errors.js'
import { createFakeGit, makeTestContext, TEST_REPO, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_DIFF, syntheticArtifact } from '../testing/synthetic.js'
import {
  collectCandidates,
  discoverSharedCanvas,
  discoveryFingerprint,
  downloadAttachment,
  findAttachmentLinks,
  importFailureReason,
  rankCandidates,
} from './attachments.js'

const FILE_URL = 'https://github.com/user-attachments/files/12345/pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'
const ASSET_URL = 'https://github.com/user-attachments/assets/6e9d2b7c-1f2a-4c3d-9a8b-0f1e2d3c4b5a'
const SIGNED_URL = 'https://objects.githubusercontent.com/canvas.zip?sig=abc'

function comments(over: Partial<CommentsPayload> = {}): CommentsPayload {
  return { ...emptyComments(HEAD_SHA, '2026-09-10T12:00:00.000Z'), ...over }
}

function issue(
  id: number,
  body: string,
  times: { createdAt?: string; updatedAt?: string } = {}
): CommentsPayload['issueComments'][number] {
  const createdAt = times.createdAt ?? '2026-09-09T10:00:00Z'
  return { id, author: 'octocat', body, createdAt, updatedAt: times.updatedAt ?? createdAt, url: `u${id}` }
}

function pr(over: Partial<Pr> = {}): Pr {
  return { ...syntheticArtifact().pr, ...over }
}

function manifest(): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: TEST_REPO,
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
  }
}

function canvasBytes(): Uint8Array {
  return buildCanvasZip(manifest(), { ...syntheticArtifact(), generatedAt: '2026-09-10T11:00:00.000Z' })
}

/** A fetch that answers the same way however often it is called, and counts the calls. */
function alwaysFetch(make: () => Response): { impl: typeof fetch; count: () => number } {
  let count = 0
  return {
    impl: async () => {
      count++
      return make()
    },
    count: () => count,
  }
}

/** A fetch that answers from a list of responses in call order and records what it was asked. */
function fakeFetch(responses: Response[]): { impl: typeof fetch; calls: Array<{ url: string; auth: string | null }> } {
  const calls: Array<{ url: string; auth: string | null }> = []
  let at = 0
  const impl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), auth: headers.get('authorization') })
    const res = responses[at++]
    if (res === undefined) {
      throw new Error('no more fake responses')
    }
    return res
  }
  return { impl, calls }
}

function zipResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status })
}

describe('findAttachmentLinks', () => {
  it('reads the files form and the markdown-labelled assets form once each', () => {
    const text = `see ${FILE_URL} and [pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip](${ASSET_URL})\nand ${FILE_URL}`
    expect(findAttachmentLinks(text)).toEqual([
      { url: FILE_URL, name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip' },
      { url: ASSET_URL, name: 'pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip' },
    ])
  })

  it('deduplicates repeated asset URLs even when their labels differ', () => {
    const name = 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'
    const text = `[${name}](${ASSET_URL}) and [copy.zip](${ASSET_URL})`
    expect(findAttachmentLinks(text)).toEqual([{ url: ASSET_URL, name }])
  })

  it('ignores links that are not zip attachments on github', () => {
    const text = [
      'https://evil.example/user-attachments/files/1/pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      'https://github.com/user-attachments/files/1/notes.pdf',
      '[canvas.zip](https://github.com/acme/widgets/files/1/canvas.zip)',
    ].join('\n')
    expect(findAttachmentLinks(text)).toEqual([])
  })
})

describe('candidate collection and ranking', () => {
  it('keeps only names that parse for this repo, across body and comments', () => {
    const payload = comments({
      issueComments: [issue(1, `[pr-42-20260910T110000Z-aaaaaaaa-other-repo-canvas.zip](${ASSET_URL})`), issue(2, FILE_URL)],
    })
    const found = collectCandidates(
      { body: 'nothing here', bodyUpdatedAt: '2026-09-09T09:00:00Z', comments: payload },
      TEST_REPO
    )
    expect(found.map(c => [c.name, c.order])).toEqual([['pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip', 0]])
  })

  it('uses all eight commit characters when ranking attachments', () => {
    const name = 'pr-42-20260910T110000Z-aaaaaaab-acme-widgets-canvas.zip'
    const candidates = collectCandidates({
      body: FILE_URL,
      bodyUpdatedAt: '2026-09-09T09:00:00Z',
      comments: comments({ issueComments: [issue(1, `https://github.com/user-attachments/files/2/${name}`)] }),
    }, TEST_REPO)
    const ranked = rankCandidates(candidates, { headSha: HEAD_SHA, prNumber: 42 })
    expect(ranked).toHaveLength(2)
    expect(ranked[0]?.parsed.shaPrefix).toBe('aaaaaaaa')
  })

  it('puts the canvas for the head first, then this PR, then the newest link', () => {
    const url = (n: string) => `https://github.com/user-attachments/files/1/${n}`
    const forHead = `pr-42-20260910T110000Z-${HEAD_SHA.slice(0, 8)}-acme-widgets-canvas.zip`
    const payload = comments({
      issueComments: [
        issue(1, url('ref-20260910T110000Z-cccccccc-acme-widgets-canvas.zip')),
        issue(2, url('pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip')),
        issue(3, url('ref-20260910T110000Z-dddddddd-acme-widgets-canvas.zip')),
        issue(4, url(forHead)),
      ],
    })
    const ranked = rankCandidates(
      collectCandidates({ body: '', bodyUpdatedAt: '2026-09-09T09:00:00Z', comments: payload }, TEST_REPO),
      { headSha: HEAD_SHA, prNumber: 42 }
    )
    expect(ranked.map(c => c.name)).toEqual([
      forHead,
      'pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip',
      'ref-20260910T110000Z-dddddddd-acme-widgets-canvas.zip',
      'ref-20260910T110000Z-cccccccc-acme-widgets-canvas.zip',
    ])
  })
})

describe('ranking by edit time', () => {
  it('prefers the attachment added last, counting an edit as the moment it appeared', () => {
    const url = (n: string) => `https://github.com/user-attachments/files/1/${n}`
    const edited = 'pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip'
    const newer = 'pr-42-20260910T110000Z-cccccccc-acme-widgets-canvas.zip'
    const payload = comments({
      issueComments: [
        // Monday's comment, edited on Wednesday to carry a canvas.
        issue(1, url(edited), { createdAt: '2026-09-07T10:00:00Z', updatedAt: '2026-09-09T10:00:00Z' }),
        // Tuesday's comment, never edited.
        issue(2, url(newer), { createdAt: '2026-09-08T10:00:00Z' }),
      ],
    })
    const sources = { body: '', bodyUpdatedAt: '2026-09-01T00:00:00Z', comments: payload }
    const ranked = rankCandidates(collectCandidates(sources, TEST_REPO), { headSha: HEAD_SHA, prNumber: 42 })
    expect(ranked.map(c => c.name)).toEqual([edited, newer])
  })
})

describe('discoveryFingerprint', () => {
  it('changes with the body, a new comment, an edited comment, and a moved head', () => {
    const one = comments({ issueComments: [issue(1, 'a')] })
    const base = discoveryFingerprint('body', one, HEAD_SHA)
    expect(discoveryFingerprint('body', comments({ issueComments: [issue(1, 'a')] }), HEAD_SHA)).toBe(base)
    expect(discoveryFingerprint('other', one, HEAD_SHA)).not.toBe(base)
    expect(
      discoveryFingerprint('body', comments({ issueComments: [issue(1, 'a'), issue(2, 'b')] }), HEAD_SHA)
    ).not.toBe(base)
    // An edit that keeps the length, such as swapping one zip link for another, still counts.
    expect(discoveryFingerprint('body', comments({ issueComments: [issue(1, 'b')] }), HEAD_SHA)).not.toBe(base)
    expect(discoveryFingerprint('body', one, BASE_SHA)).not.toBe(base)
  })
})

describe('downloadAttachment', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('follows the signed redirect without carrying the token to storage', async () => {
    const bytes = canvasBytes()
    const fetches = fakeFetch([
      new Response(null, { status: 302, headers: { location: SIGNED_URL } }),
      zipResponse(bytes),
    ])
    t = await makeTestContext({ fetch: fetches.impl })
    const result = await downloadAttachment(t.ctx, FILE_URL)
    expect(result).toEqual({ ok: true, bytes })
    expect(fetches.calls).toEqual([
      { url: FILE_URL, auth: 'token gh-test-token' },
      { url: SIGNED_URL, auth: null },
    ])
  })

  it('reports auth-required for 404 without a login and when gh has no token', async () => {
    const fetches = fakeFetch([new Response('', { status: 404 })])
    t = await makeTestContext({ fetch: fetches.impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'auth-required' })
    await t.cleanup()
    const { createFakeGh } = await import('../testing/fakes.js')
    t = await makeTestContext({ gh: createFakeGh({ token: null }), fetch: fetches.impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'auth-required' })
  })

  it('never sends the token to storage, even when the link points there', async () => {
    const bytes = canvasBytes()
    const fetches = fakeFetch([zipResponse(bytes)])
    t = await makeTestContext({ fetch: fetches.impl })
    expect(await downloadAttachment(t.ctx, SIGNED_URL)).toEqual({ ok: true, bytes })
    expect(fetches.calls).toEqual([{ url: SIGNED_URL, auth: null }])
  })

  it('refuses a redirect that leaves the allowed hosts, and a URL that is not one of them', async () => {
    const fetches = fakeFetch([new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })])
    t = await makeTestContext({ fetch: fetches.impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'network' })
    expect(await downloadAttachment(t.ctx, 'http://github.com/user-attachments/files/1/a.zip')).toEqual({
      ok: false,
      reason: 'network',
    })
    expect(await downloadAttachment(t.ctx, 'not a url')).toEqual({ ok: false, reason: 'network' })
  })

  it('reports a body that is not a zip, one that is too large, and a request that throws', async () => {
    const notZip = fakeFetch([zipResponse(new Uint8Array([1, 2, 3, 4]))])
    t = await makeTestContext({ fetch: notZip.impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'not-zip' })
    await t.cleanup()

    const huge = new Response('x', { headers: { 'content-length': String(21 * 1024 * 1024) } })
    t = await makeTestContext({ fetch: fakeFetch([huge]).impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'too-large' })
    await t.cleanup()

    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(11 * 1024 * 1024))
          controller.enqueue(new Uint8Array(11 * 1024 * 1024))
          controller.close()
        },
      })
    )
    t = await makeTestContext({ fetch: fakeFetch([streamed]).impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'too-large' })
    await t.cleanup()

    const failing: typeof fetch = () => Promise.reject(new Error('socket hang up'))
    t = await makeTestContext({ fetch: failing })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'network' })
  })

  it('reports a download interrupted after the ZIP header as a network failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
      },
      pull(controller) {
        controller.error(new Error('connection closed during download'))
      },
    })
    t = await makeTestContext({ fetch: fakeFetch([new Response(body)]).impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'network' })
  })

  it('treats a redirect without a location as a network failure', async () => {
    t = await makeTestContext({ fetch: fakeFetch([new Response(null, { status: 302 })]).impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'network' })
  })

  it('reports a server error and a redirect loop as network failures', async () => {
    t = await makeTestContext({ fetch: fakeFetch([new Response('', { status: 500 })]).impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'network' })
    await t.cleanup()
    const loop = Array.from({ length: 5 }, () => new Response(null, { status: 302, headers: { location: SIGNED_URL } }))
    t = await makeTestContext({ fetch: fakeFetch(loop).impl })
    expect(await downloadAttachment(t.ctx, FILE_URL)).toEqual({ ok: false, reason: 'network' })
  })
})

describe('discoverSharedCanvas', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  function localClone(fetchImpl: typeof fetch): Promise<TestContext> {
    return makeTestContext({
      fetch: fetchImpl,
      git: createFakeGit({
        refs: { head: HEAD_SHA, base: BASE_SHA },
        mergeBases: { [`${BASE_SHA}..${HEAD_SHA}`]: BASE_SHA },
        diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF },
      }),
    })
  }

  it('imports the best attachment and reports it as downloadable', async () => {
    const bytes = canvasBytes()
    t = await localClone(fakeFetch([zipResponse(bytes)]).impl)
    const outcome = await discoverSharedCanvas(t.ctx, pr({ body: FILE_URL }), comments())
    expect(outcome.sharedCanvas).toEqual({
      url: FILE_URL,
      name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      matchesHead: true,
      downloadable: true,
    })
    expect(outcome.imported?.status).toBe('ready')
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
  })

  it('reports a failed download with its reason and imports nothing', async () => {
    t = await localClone(fakeFetch([new Response('', { status: 403 })]).impl)
    const outcome = await discoverSharedCanvas(t.ctx, pr({ body: FILE_URL }), comments())
    expect(outcome.sharedCanvas).toEqual({
      url: FILE_URL,
      name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      matchesHead: true,
      downloadable: false,
      reason: 'auth-required',
    })
    expect(outcome.imported).toBeNull()
  })

  it('falls through to the next attachment when the best one cannot be downloaded', async () => {
    // The link named for the head ranks first and is broken; the other one is the real canvas.
    const other = 'https://github.com/user-attachments/files/2/pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip'
    const fetches = fakeFetch([new Response('', { status: 404 }), zipResponse(canvasBytes())])
    t = await localClone(fetches.impl)
    const payload = comments({
      issueComments: [issue(1, FILE_URL), issue(2, other)],
    })
    const outcome = await discoverSharedCanvas(t.ctx, pr({ body: '' }), payload)
    expect(fetches.calls.map(c => c.url)).toEqual([FILE_URL, other])
    expect(outcome.imported?.status).toBe('ready')
    expect(outcome.sharedCanvas).toEqual({
      url: other,
      name: 'pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip',
      matchesHead: false,
      downloadable: true,
    })
  })

  it('tries at most three attachments and reports the first failure', async () => {
    const url = (n: number) =>
      `https://github.com/user-attachments/files/${n}/pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip`
    const fetches = alwaysFetch(() => new Response('', { status: 404 }))
    t = await localClone(fetches.impl)
    const payload = comments({
      issueComments: [1, 2, 3, 4].map(n => issue(n, url(n), { createdAt: `2026-09-0${n}T10:00:00Z` })),
    })
    const outcome = await discoverSharedCanvas(t.ctx, pr({ body: '' }), payload)
    expect(fetches.count()).toBe(3)
    expect(outcome.imported).toBeNull()
    expect(outcome.sharedCanvas).toEqual({
      url: url(4),
      name: 'pr-42-20260910T110000Z-bbbbbbbb-acme-widgets-canvas.zip',
      matchesHead: false,
      downloadable: false,
      reason: 'auth-required',
    })
  })

  it('reports a downloaded zip that import refuses', async () => {
    const foreign = buildCanvasZip(
      { ...manifest(), repo: { owner: 'other', name: 'repo' } },
      { ...syntheticArtifact(), generatedAt: '2026-09-10T11:00:00.000Z' }
    )
    t = await localClone(fakeFetch([zipResponse(foreign)]).impl)
    const outcome = await discoverSharedCanvas(t.ctx, pr({ body: FILE_URL }), comments())
    expect(outcome.sharedCanvas?.downloadable).toBe(false)
    expect(outcome.sharedCanvas?.reason).toBe('name-mismatch')
    expect(outcome.warnings[0]).toContain('other/repo')
  })

  it('does nothing for a PR with no attachment and for a change set without a number', async () => {
    t = await makeTestContext()
    expect(await discoverSharedCanvas(t.ctx, pr({ body: 'no zip here' }), comments())).toEqual({
      sharedCanvas: null,
      imported: null,
      warnings: [],
    })
    expect(await discoverSharedCanvas(t.ctx, pr({ number: null, body: FILE_URL }), comments())).toEqual({
      sharedCanvas: null,
      imported: null,
      warnings: [],
    })
  })
})

describe('importFailureReason', () => {
  it('names the reason for every way an import can refuse a downloaded file', () => {
    expect(importFailureReason(new Error('boom'))).toBe('not-zip')
    expect(importFailureReason(new AppError('CANVAS_TOO_LARGE', 'big', 413))).toBe('too-large')
    expect(importFailureReason(new AppError('CANVAS_REPO_MISMATCH', 'elsewhere', 400))).toBe('name-mismatch')
    expect(importFailureReason(new AppError('CANVAS_INVALID', 'broken', 400))).toBe('not-zip')
  })
})
