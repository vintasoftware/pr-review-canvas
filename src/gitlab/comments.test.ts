// @vitest-environment node
import { createFakeGh, ghJson, TEST_REPO } from '../testing/fakes.js'
import { HEAD_SHA } from '../testing/synthetic.js'
import { fetchGitlabComments, findDiscussionId, mapGitLabReviewComment } from './comments.js'

const WEB = 'https://gitlab.com'
const now = () => new Date('2026-09-10T12:00:00.000Z')

const DIFF_NOTE = {
  id: 1001,
  type: 'DiffNote',
  body: 'Why not this?',
  author: { username: 'reviewer', avatar_url: 'https://gitlab.com/u.png' },
  created_at: '2026-09-09T10:00:00Z',
  updated_at: '2026-09-09T10:00:00Z',
  resolved: true,
  position: {
    new_path: 'src/app.ts',
    old_path: 'src/app.ts',
    new_line: 4,
    old_line: null,
    head_sha: HEAD_SHA,
  },
}

describe('mapGitLabReviewComment', () => {
  it('maps a new-side diff note', () => {
    expect(
      mapGitLabReviewComment(DIFF_NOTE, { webBase: WEB, repo: TEST_REPO, iid: 42, headSha: HEAD_SHA })
    ).toMatchObject({
      id: 1001,
      author: 'reviewer',
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      outdated: false,
      resolved: true,
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/42#note_1001',
    })
  })

  it('maps an old-side range and an outdated note', () => {
    const old = {
      ...DIFF_NOTE,
      id: 3,
      resolved: false,
      position: {
        new_path: 'src/app.ts',
        old_path: 'src/app.ts',
        new_line: null,
        old_line: 8,
        head_sha: 'c'.repeat(40),
        line_range: { start: { old_line: 6, new_line: null } },
      },
    }
    expect(
      mapGitLabReviewComment(old, { webBase: WEB, repo: TEST_REPO, iid: 42, headSha: HEAD_SHA })
    ).toMatchObject({
      side: 'old',
      line: 8,
      startLine: 6,
      outdated: true,
    })
  })
})

describe('fetchGitlabComments', () => {
  it('splits diff threads from MR notes and skips system notes', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets/merge_requests/42/discussions': ghJson([
          {
            id: 'disc-1',
            notes: [
              DIFF_NOTE,
              {
                id: 1002,
                type: 'DiffNote',
                body: 'reply',
                author: { username: 'octocat' },
                created_at: '2026-09-09T11:00:00Z',
                position: DIFF_NOTE.position,
                resolved: true,
              },
            ],
          },
          {
            id: 'disc-2',
            individual_note: true,
            notes: [
              {
                id: 2001,
                type: null,
                body: 'Looks good',
                author: { username: 'reviewer' },
                created_at: '2026-09-09T12:00:00Z',
                system: false,
              },
            ],
          },
          {
            id: 'disc-3',
            notes: [
              {
                id: 9,
                system: true,
                body: 'assigned to x',
                author: { username: 'gitlab' },
                created_at: '2026-09-09T09:00:00Z',
              },
            ],
          },
        ]),
      },
    })
    const { payload } = await fetchGitlabComments(gh, TEST_REPO, 42, HEAD_SHA, now, WEB)
    expect(payload.reviewComments).toHaveLength(2)
    expect(payload.reviewComments[1]?.inReplyToId).toBe(1001)
    expect(payload.issueComments).toEqual([
      expect.objectContaining({ id: 2001, body: 'Looks good', author: 'reviewer' }),
    ])
  })
})

describe('findDiscussionId', () => {
  it('returns the discussion that holds the note', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets/merge_requests/42/discussions': ghJson([
          { id: 'abc', notes: [{ id: 1001, body: 'x', created_at: 't' }] },
        ]),
      },
    })
    expect(await findDiscussionId(gh, TEST_REPO, 42, 1001)).toBe('abc')
    expect(await findDiscussionId(gh, TEST_REPO, 42, 9)).toBeNull()
  })

  it('skips discussion payloads that are not objects', async () => {
    const gh = createFakeGh({
      routes: { 'projects/acme%2Fwidgets/merge_requests/42/discussions': ghJson(['nope', { id: 1 }]) },
    })
    const { payload } = await fetchGitlabComments(gh, TEST_REPO, 42, HEAD_SHA, now, WEB)
    expect(payload.reviewComments).toEqual([])
    expect(await findDiscussionId(gh, TEST_REPO, 42, 1)).toBeNull()
  })
})
