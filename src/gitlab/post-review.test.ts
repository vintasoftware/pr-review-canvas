// @vitest-environment node
import { createFakeGh, ghPost, TEST_REPO } from '../testing/fakes.js'
import { HEAD_SHA } from '../testing/synthetic.js'
import { postGitlabReview } from './post-review.js'

const WEB = 'https://gitlab.com'

describe('postGitlabReview', () => {
  it('approves with the head sha and posts the body as a note', async () => {
    const gh = createFakeGh({
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/notes': ghPost(() => ({ id: 1, created_at: 't' })),
        'projects/acme%2Fwidgets/merge_requests/42/approve': ghPost(() => ({
          id: 99,
          iid: 42,
          approved: true,
          web_url: `${WEB}/acme/widgets/-/merge_requests/42`,
        })),
      },
    })
    expect(
      await postGitlabReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'looks good' }, WEB)
    ).toMatchObject({ id: 99, state: 'APPROVED' })
    expect(gh.calls.filter(c => c.kind === 'post').map(c => c.path)).toEqual([
      'projects/acme%2Fwidgets/merge_requests/42/notes',
      'projects/acme%2Fwidgets/merge_requests/42/approve',
    ])
    expect(gh.calls.find(c => c.path.endsWith('/approve'))?.body).toEqual({ sha: HEAD_SHA })
  })

  it('uses the iid when approve omits id', async () => {
    const gh = createFakeGh({
      postRoutes: { 'projects/acme%2Fwidgets/merge_requests/42/approve': ghPost(() => ({ iid: 42 })) },
    })
    expect(
      await postGitlabReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: '' }, WEB)
    ).toMatchObject({
      id: 42,
      url: `${WEB}/acme/widgets/-/merge_requests/42`,
    })
  })

  it.each(['nope', null, {}, { id: 'invalid', web_url: 'https://gitlab.com/ignored' }])(
    'falls back to the MR number and URL for approval response %j',
    async response => {
      const gh = createFakeGh({
        postRoutes: { 'projects/acme%2Fwidgets/merge_requests/42/approve': ghPost(() => response) },
      })
      expect(
        await postGitlabReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: '' }, WEB)
      ).toMatchObject({
        id: 42,
        state: 'APPROVED',
        url: `${WEB}/acme/widgets/-/merge_requests/42`,
      })
    }
  )

  it('approves without posting an empty body', async () => {
    const gh = createFakeGh({
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/approve': ghPost(() => ({ iid: 42 })),
      },
    })
    expect(
      await postGitlabReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: '   ' }, WEB)
    ).toMatchObject({ state: 'APPROVED', id: 42 })
    expect(gh.calls.filter(c => c.kind === 'post')).toHaveLength(1)
  })

  it('posts request-changes as an MR note', async () => {
    const gh = createFakeGh({
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/notes': ghPost(() => ({
          id: 8,
          created_at: '2026-09-10T12:00:00Z',
        })),
      },
    })
    expect(
      await postGitlabReview(
        gh,
        TEST_REPO,
        42,
        HEAD_SHA,
        { event: 'REQUEST_CHANGES', body: 'please fix' },
        WEB
      )
    ).toEqual({
      comments: [],
      warnings: [],
      id: 8,
      state: 'CHANGES_REQUESTED',
      url: `${WEB}/acme/widgets/-/merge_requests/42#note_8`,
      submittedAt: '2026-09-10T12:00:00Z',
    })
  })
})
