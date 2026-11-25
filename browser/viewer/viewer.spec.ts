import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE_SHA, GH_PULL, HEAD_SHA } from '../../src/testing/synthetic.js'
import { canvasComment, expect, ghStatus, test, VIEWER_BUILD_DIR } from './fixtures.js'

const reviewed = (text: string) => `${text} layers reviewed`

test('asks for a pull request and says which address it could not read', async ({ page, open }) => {
  await open()
  await expect(page.getByRole('heading', { name: 'PR review canvas viewer' })).toBeVisible()

  await page.getByLabel('Pull request').fill('not a pull request')
  await page.getByRole('button', { name: 'open' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    '"not a pull request" is not a GitHub pull request; use owner/repo/123 or its URL'
  )

  await page.getByLabel('Pull request').fill('https://github.com/acme/widgets/pull/42/files')
  await page.getByRole('button', { name: 'open' }).click()
  await expect(page).toHaveTitle('PR #42 · acme/widgets · review canvas')
})

test('opens the canvas comment the author published, under the CSP Pages sends', async ({
  page,
  open,
  github,
}) => {
  github.comment(canvasComment())
  const document = page.waitForResponse(response => new URL(response.url()).search.startsWith('?pr='))
  await open('acme/widgets#42')

  const csp = (await document).headers()['content-security-policy']
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain('connect-src')
  await expect(page.locator('section.layer[data-layer="run-path"]')).toContainText('Run path')
  await expect(page.getByText(reviewed('0 of 1'))).toBeVisible()
  await expect(page.getByText('Reading anonymously: public pull requests only.')).toBeVisible()
  await expect(page.getByText(/^pr-review \d+\.\d+\.\d+\S*\+[0-9a-f]{7}$/)).toBeVisible()
  // Anonymous: every call went without a token, and nothing was written.
  expect(github.requests.every(r => r.authorization === null && r.method === 'GET')).toBe(true)
})

test('shows how to make a canvas when the pull request has none', async ({ page, open }) => {
  await open('acme/widgets/42')
  await expect(page.getByText('No review canvas for this PR yet')).toBeVisible()
  await expect(page.getByText('/pr-review-canvas 42')).toBeVisible()
})

test('words a pull request it cannot read for the viewer, with no local app to point at', async ({
  page,
  open,
}) => {
  await open('acme/private/7')
  const card = page.locator('section.error-card')
  await expect(card).toContainText('acme/private#7 was not found, or is not public')
  await expect(card).toContainText('Check the owner, the repository, and the number.')
  await expect(card).not.toContainText('clone')
  await expect(page.locator('footer')).toContainText('hosted viewer')
  await expect(page.locator('footer')).not.toContainText('local review app')
})

test("skips a stranger's canvas comment and names who posted it", async ({ page, open, github }) => {
  github.comment(canvasComment({ login: 'mallory', association: 'NONE' }))
  await open('acme/widgets/42')

  await expect(page.locator('.banner')).toContainText(
    "is by @mallory, who is neither the pull request's author nor an owner, member, or collaborator of acme/widgets; skipped"
  )
  await expect(page.getByText('No review canvas for this PR yet')).toBeVisible()
})

test('takes the canvas from a collaborator who did not open the pull request', async ({
  page,
  open,
  github,
}) => {
  github.comment(canvasComment({ login: 'teammate', association: 'COLLABORATOR' }))
  await open('acme/widgets/42')
  await expect(page.getByText(reviewed('0 of 1'))).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
})

test('rebuilds a diff GitHub refuses to send from the file list, and says what is missing', async ({
  page,
  open,
  github,
}) => {
  github.routes[`diff:${BASE_SHA}...${HEAD_SHA}`] = ghStatus(
    422,
    'Sorry, this diff is taking too long to generate.'
  )
  github.routes['repos/acme/widgets/pulls/42/files'] = [
    {
      filename: 'src/app.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch:
        "@@ -1,4 +1,5 @@\n import { a } from './a'\n+import { b } from './b'\n export function run() {\n-  return a()\n+  return a() + b()\n }",
    },
    // Too large for GitHub to send a patch.
    { filename: 'data/huge.json', status: 'modified', additions: 90_000, deletions: 80_000 },
  ]
  github.routes['repos/acme/widgets/pulls/42'] = { ...GH_PULL, changed_files: 2 }
  await open('acme/widgets/42')

  await expect(page.getByText('No review canvas for this PR yet')).toBeVisible()
  await expect(page.locator('.banner')).toHaveText(
    'GitHub sent no changes for 1 file too large to diff (data/huge.json), so the page lists it without its lines. Read them on GitHub, or in the local app (pr-review serve), which diffs a clone.'
  )
  expect(github.requests.map(r => r.path)).toContain('repos/acme/widgets/pulls/42/files')
})

test("says when GitHub's anonymous rate limit is used up", async ({ page, open, github }) => {
  github.routes['repos/acme/widgets/pulls/42'] = ghStatus(403, 'API rate limit exceeded', {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
  })
  await open('acme/widgets/42')
  await expect(
    page.getByText(/anonymous rate limit of 60 requests an hour is used up; sign in, or wait until/)
  ).toBeVisible()
  // GitHub's words only: the page runs no CLI to name.
  await expect(page.locator('section.error-card')).not.toContainText('gh api')
})

test('keeps review marks in this browser across a reload', async ({ page, open, github }) => {
  github.comment(canvasComment())
  await open('acme/widgets/42')
  await page.locator('[data-act="mark-layer"][data-reviewed-id="layer:run-path"]').first().click()
  await expect(page.getByText(reviewed('1 of 1'))).toBeVisible()

  await page.reload()
  await expect(page.getByText(reviewed('1 of 1'))).toBeVisible()
})

test('signs in through GitHub with PKCE and reads as the reader', async ({ page, open, github, signIn }) => {
  github.comment(canvasComment())
  await open('acme/widgets/42')
  await page.getByRole('button', { name: 'sign in with GitHub' }).click()

  await expect(page.getByText('Signed in to GitHub as @reviewer.')).toBeVisible()
  // Back on the pull request it started from, with GitHub's code gone from the address.
  await expect(page).toHaveURL(/\?pr=acme%2Fwidgets%2F42$/)
  expect(signIn.verifierMatches()).toBe(true)
  await expect(page.getByText(reviewed('0 of 1'))).toBeVisible()
  const bearer = `Bearer ${signIn.token}`
  expect(github.requests.filter(r => r.authorization === bearer).map(r => r.path)).toContain('user')
  // The token lives in this tab's sessionStorage, never in localStorage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  expect(stored).not.toContain(signIn.token)

  await page.getByRole('button', { name: 'sign out' }).click()
  await expect(page.getByText('Reading anonymously: public pull requests only.')).toBeVisible()
  const session = await page.evaluate(() => JSON.stringify({ ...sessionStorage }))
  expect(session).not.toContain(signIn.token)
})

test('says the sign-in was cancelled when the reader declines on GitHub', async ({ page, open, signIn }) => {
  signIn.outcome = 'deny'
  await open('acme/widgets/42')
  await page.getByRole('button', { name: 'sign in with GitHub' }).click()
  await expect(page.getByRole('alert')).toHaveText('GitHub sign-in was cancelled')
  await expect(page.getByRole('button', { name: 'sign in with GitHub' })).toBeVisible()
})

test('the build carries its headers and no inline script', async () => {
  const headers = await readFile(join(VIEWER_BUILD_DIR, '_headers'), 'utf8')
  expect(headers).toContain("Content-Security-Policy: default-src 'none'")
  expect(headers).toContain('https://auth.viewer.test')
  const index = await readFile(join(VIEWER_BUILD_DIR, 'index.html'), 'utf8')
  expect(index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
})
