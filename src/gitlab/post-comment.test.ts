// @vitest-environment node
import { createFakeGh, ghJson, ghPost, TEST_REPO } from '../testing/fakes.js'
import { HEAD_SHA } from '../testing/synthetic.js'
import { postGitlabComment } from './post-comment.js'

const WEB = 'https://gitlab.com'
const MR = {
  iid: 42,
  title: 't',
  description: '',
  web_url: `${WEB}/acme/widgets/-/merge_requests/42`,
  state: 'opened',
  updated_at: '2026-09-09T09:00:00Z',
  target_branch: 'main',
  source_branch: 'feat',
  sha: HEAD_SHA,
  author: { username: 'octocat' },
  diff_refs: { base_sha: 'b'.repeat(40), head_sha: HEAD_SHA, start_sha: 'b'.repeat(40) },
}

const NOTE = {
  id: 5001,
  body: 'Look at this',
  author: { username: 'octocat' },
  created_at: '2026-09-10T12:00:00Z',
  position: {
    new_path: 'src/app.ts',
    old_path: 'src/app.ts',
    new_line: 4,
    old_line: null,
    head_sha: HEAD_SHA,
  },
}

describe('postGitlabComment', () => {
  it('posts an inline discussion with GitLab position SHAs', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson(MR) },
      graphql: [{ project: { mergeRequest: { diffStatsSummary: null } } }],
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/discussions': ghPost(() => ({ id: 'd1', notes: [NOTE] })),
      },
    })
    const posted = await postGitlabComment(
      gh,
      TEST_REPO,
      42,
      HEAD_SHA,
      { kind: 'inline', path: 'src/app.ts', line: 4, side: 'new', body: 'Look at this' },
      { webBase: WEB }
    )
    expect(posted.kind).toBe('review')
    expect(posted.comment.id).toBe(5001)
    expect(gh.calls.find(c => c.kind === 'post')?.body).toMatchObject({
      body: 'Look at this',
      position: {
        position_type: 'text',
        new_path: 'src/app.ts',
        new_line: 4,
        head_sha: HEAD_SHA,
      },
    })
  })

  it('replies through the discussion that holds the parent note', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets/merge_requests/42/discussions': ghJson([
          { id: 'abc', notes: [{ id: 1001, body: 'root', created_at: 't' }] },
        ]),
      },
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/discussions/abc/notes': ghPost(() => ({
          id: 1002,
          body: 'reply',
          author: { username: 'octocat' },
          created_at: '2026-09-10T12:00:00Z',
        })),
      },
    })
    const posted = await postGitlabComment(
      gh,
      TEST_REPO,
      42,
      HEAD_SHA,
      { kind: 'reply', inReplyToId: 1001, body: 'reply' },
      { webBase: WEB }
    )
    expect(posted.kind).toBe('review')
    expect(posted.comment.id).toBe(1002)
    expect(posted.kind === 'review' && posted.comment.inReplyToId).toBe(1001)
  })

  it('includes a line range and old-side position', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42': ghJson(MR) },
      graphql: [{ project: { mergeRequest: { diffStatsSummary: null } } }],
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/discussions': ghPost(() => ({
          id: 'd1',
          notes: [
            {
              ...NOTE,
              position: {
                new_path: 'src/app.ts',
                old_path: 'src/app.ts',
                old_line: 3,
                new_line: null,
                head_sha: HEAD_SHA,
              },
            },
          ],
        })),
      },
    })
    await postGitlabComment(
      gh,
      TEST_REPO,
      42,
      HEAD_SHA,
      { kind: 'inline', path: 'src/app.ts', line: 3, startLine: 1, side: 'old', body: 'old' },
      { webBase: WEB }
    )
    expect(gh.calls.find(c => c.kind === 'post')?.body).toMatchObject({
      position: { old_line: 3, line_range: { start: { type: 'old' }, end: { type: 'old' } } },
    })
  })

  it('refuses a reply when the parent note is not in any discussion', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42/discussions': ghJson([]) },
    })
    await expect(
      postGitlabComment(
        gh,
        TEST_REPO,
        42,
        HEAD_SHA,
        { kind: 'reply', inReplyToId: 99, body: 'x' },
        { webBase: WEB }
      )
    ).rejects.toThrow(/no GitLab discussion/)
  })

  it('posts an MR-level note', async () => {
    const gh = createFakeGh({
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/notes': ghPost(() => ({
          id: 6001,
          body: 'Overall looks fine',
          author: { username: 'octocat' },
          created_at: '2026-09-10T12:00:00Z',
        })),
      },
    })
    const posted = await postGitlabComment(
      gh,
      TEST_REPO,
      42,
      HEAD_SHA,
      { kind: 'issue', body: 'Overall looks fine' },
      { webBase: WEB }
    )
    expect(posted).toMatchObject({ kind: 'issue', comment: { id: 6001, body: 'Overall looks fine' } })
  })
})
