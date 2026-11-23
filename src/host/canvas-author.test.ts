// @vitest-environment node
import { createFakeGh, TEST_REPO } from '../testing/fakes.js'
import { hasGithubRole, hasGitlabRole, isReviewAuthor } from './canvas-author.js'

it('takes the review author in any letter case', () => {
  expect(isReviewAuthor('Octocat', 'octocat')).toBe(true)
  expect(isReviewAuthor('mallory', 'octocat')).toBe(false)
})

// GitHub shows every deleted account as `ghost`. When the review's author deleted their account
// too, any other deleted account would otherwise pass as the author.
it('never takes a deleted account for the review author, even when the author was deleted too', async () => {
  expect(isReviewAuthor('ghost', 'ghost')).toBe(false)
  expect(hasGithubRole({ login: 'ghost' })).toBe(false)
  const gh = createFakeGh()
  expect(await hasGitlabRole(gh, TEST_REPO, { login: 'ghost' })).toBe(false)
  expect(gh.calls).toEqual([])
})

it('still takes a deleted account GitHub reports with a role on the repository', () => {
  expect(hasGithubRole({ login: 'ghost', association: 'MEMBER' })).toBe(true)
})
