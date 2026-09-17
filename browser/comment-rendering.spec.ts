import { expect, test } from './fixtures.js'

test('links PR screenshots to GitHub and loads external bot images under the canvas CSP', async ({
  page,
  reviewUrl,
}) => {
  const screenshot = 'https://github.com/user-attachments/assets/test-screenshot'
  const botAsset = 'https://assets.coderabbit.ai/test-review.png'
  await page.route(botAsset, route =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=',
        'base64'
      ),
    })
  )
  await page.route('**/api/prs/42', async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.pr.body = `![Self-QA screenshot](${screenshot})`
    bundle.comments.issueComments.push({
      id: 9010,
      author: 'coderabbitai',
      body: `![Bot evidence](${botAsset})`,
      createdAt: '2026-09-10T12:00:00Z',
      updatedAt: '2026-09-10T12:00:00Z',
      url: 'https://github.com/comment/9010',
    })
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  await page.locator('.pr-desc > summary').click()
  const screenshotLink = page.getByRole('link', { name: 'View image on GitHub: Self-QA screenshot' })
  await expect(screenshotLink).toHaveAttribute('href', screenshot)
  await expect(screenshotLink).toHaveAttribute('target', '_blank')
  await expect(page.getByRole('img', { name: 'Self-QA screenshot', exact: true })).toHaveCount(0)
  const img = page.getByRole('img', { name: 'Bot evidence', exact: true })
  await img.scrollIntoViewIfNeeded()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
})

test('renders avatars, safe GitHub Markdown, and comments missing from current files', async ({
  page,
  reviewUrl,
}) => {
  await page.route('https://avatars.githubusercontent.com/**', route =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=',
        'base64'
      ),
    })
  )
  await page.route('**/api/prs/42', async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.comments.issueComments.push({
      id: 9001,
      author: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      body: '<details><summary>Evidence</summary><p>Passed</p></details><script>alert(1)</script><iframe src="https://example.com"></iframe>',
      createdAt: '2026-09-10T12:00:00Z',
      updatedAt: '2026-09-10T12:00:00Z',
      url: 'https://github.com/comment/9001',
    })
    bundle.comments.reviews = [
      { ...bundle.comments.issueComments.at(-1), id: 9002, body: '**Reviewed**', state: 'APPROVED' },
    ]
    bundle.comments.reviewComments.push({
      ...bundle.comments.reviewComments[0],
      id: 9003,
      path: 'removed.ts',
      body: 'A comment on a removed file',
      outdated: true,
      line: null,
    })
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  const avatar = page.locator('.conversation img.av').first()
  await expect(avatar).toBeVisible()
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  await expect(page.locator('.conversation summary').filter({ hasText: 'Evidence' })).toBeVisible()
  await expect(page.locator('#overview iframe, #overview script')).toHaveCount(0)
  const history = page.locator('.review-history')
  await expect(history.locator('summary')).toContainText('Review history · 1')
  await expect(history.locator('strong').filter({ hasText: 'Reviewed' })).toBeHidden()
  await history.locator('summary').click()
  await expect(history.locator('strong').filter({ hasText: 'Reviewed' })).toBeVisible()
  await expect(page.locator('.all-review-comments')).toHaveCount(0)
  await page.locator('.review-history + .outdated-comments > summary .chev').click()
  await expect(page.getByText('A comment on a removed file', { exact: true })).toBeVisible()
})
