// @vitest-environment node
import { createFakeGh, TEST_REPO } from '../testing/fakes.js'
import { githubTrustsCanvasAuthor, gitlabTrustsCanvasAuthor, isReviewAuthor } from './canvas-author.js'

it('takes the review author in any letter case', () => {
  expect(isReviewAuthor('Octocat', 'octocat')).toBe(true)
  expect(isReviewAuthor('mallory', 'octocat')).toBe(false)
})

// GitHub shows every deleted account as `ghost`. When the review's author deleted their account
// too, any other deleted account would otherwise pass as the author.
it('never takes a deleted account for the review author, even when the author was deleted too', async () => {
  expect(isReviewAuthor('ghost', 'ghost')).toBe(false)
  expect(await githubTrustsCanvasAuthor({ login: 'ghost' }, 'ghost')).toBe(false)
  const gh = createFakeGh()
  expect(await gitlabTrustsCanvasAuthor(gh, TEST_REPO, { login: 'ghost' }, 'ghost')).toBe(false)
  expect(gh.calls).toEqual([])
})

it('still takes a deleted account GitHub reports with a role on the repository', async () => {
  expect(await githubTrustsCanvasAuthor({ login: 'ghost', association: 'MEMBER' }, 'octocat')).toBe(true)
})
