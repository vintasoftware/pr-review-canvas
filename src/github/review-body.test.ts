// @vitest-environment node
// The body of the sign-off review, and the check that decides whether approve is allowed.
import type { CommentsPayload } from '../contract/comments.js'
import { emptyState, type PrState } from '../contract/state.js'
import { HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { buildReviewBody, inlineText, REVIEW_BODY_FOOTER, unreviewedLayers } from './review-body.js'

const COMMENTS: CommentsPayload = {
  fetchedAt: '2026-09-10T12:00:00.000Z',
  headSha: HEAD_SHA,
  reviewComments: [
    {
      id: 5001,
      author: 'octocat',
      body: 'Look at this',
      path: 'src/app.ts',
      line: 4,
      originalLine: 4,
      side: 'new',
      outdated: false,
      commitId: HEAD_SHA,
      createdAt: '2026-09-10T12:00:00Z',
      updatedAt: '2026-09-10T12:00:00Z',
      url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
      resolved: false,
    },
  ],
  issueComments: [],
}

function stateWith(partial: Partial<PrState>): PrState {
  return { ...emptyState('2026-09-10T12:00:00.000Z'), ...partial }
}

describe('unreviewedLayers', () => {
  it('counts only the layers that are not Other', () => {
    const artifact = syntheticArtifact()
    expect(unreviewedLayers(artifact, emptyState('x')).map(l => l.id)).toEqual(['layer-1'])
    expect(unreviewedLayers(artifact, stateWith({ reviewed: { 'layer:layer-1': true } }))).toEqual([])
  })

  it('counts a layer as reviewed when every one of its files is', () => {
    const artifact = syntheticArtifact()
    const reviewed = {
      'layer:layer-1/file:src_app_ts': true,
      'layer:layer-1/file:src_new_name_ts': true,
      'layer:layer-1/file:src_app_test_ts': true,
    } as const
    expect(unreviewedLayers(artifact, stateWith({ reviewed: { ...reviewed } }))).toEqual([])
  })
})

describe('inlineText', () => {
  it('puts model text on one line and escapes what markdown would read', () => {
    expect(inlineText('  Sum\ninstead of *product*  ')).toBe('Sum instead of \\*product\\*')
    expect(inlineText('[link](x) `code` <b> # | _a_ \\')).toBe('\\[link\\](x) \\`code\\` \\<b\\> \\# \\| \\_a\\_ \\\\')
  })
})

describe('buildReviewBody', () => {
  it('lists the layers read, the points set aside, and the comments posted', () => {
    const artifact = syntheticArtifact()
    const state = stateWith({
      reviewed: { 'layer:layer-1': true },
      dismissed: { 'fp-3': { at: '2026-09-10T12:00:00.000Z' } },
      posted: [{ commentId: 5001, at: '2026-09-10T12:00:00.000Z' }],
    })
    expect(buildReviewBody({ artifact, state, comments: COMMENTS, headSha: HEAD_SHA })).toBe(
      [
        'Reviewed 1 of 1 layer on `aaaaaaa`.',
        '',
        '**Layers reviewed**',
        '- Run path',
        '',
        '**Attention points dismissed**',
        '- Deleted file had no owner',
        '',
        '**Comments posted from the canvas**',
        '- https://github.com/acme/widgets/pull/42#discussion_r5001',
        '',
        REVIEW_BODY_FOOTER,
        '',
      ].join('\n')
    )
  })

  it('counts more than one layer in the head line', () => {
    const artifact = syntheticArtifact()
    const first = artifact.layers[0]
    if (first === undefined) {
      throw new Error('no layer')
    }
    const two = { ...artifact, layers: [...artifact.layers, { ...first, id: 'layer-3', key: 'third', title: 'Third' }] }
    const body = buildReviewBody({ artifact: two, state: emptyState('x'), comments: COMMENTS, headSha: HEAD_SHA })
    expect(body.split('\n')[0]).toBe('Reviewed 0 of 2 layers on `aaaaaaa`.')
  })

  it('keeps the head line and the footer when nothing was reviewed', () => {
    const artifact = syntheticArtifact()
    expect(buildReviewBody({ artifact, state: emptyState('x'), comments: COMMENTS, headSha: HEAD_SHA })).toBe(
      `Reviewed 0 of 1 layer on \`aaaaaaa\`.\n\n${REVIEW_BODY_FOOTER}\n`
    )
  })

  it('names a posted comment by its id when its url is not cached', () => {
    const artifact = syntheticArtifact()
    const state = stateWith({ posted: [{ commentId: 9999, at: '2026-09-10T12:00:00.000Z' }] })
    expect(buildReviewBody({ artifact, state, comments: COMMENTS, headSha: HEAD_SHA })).toContain('- comment 9999')
  })
})
