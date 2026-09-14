import { expect, test } from './fixtures.js'

test('renders avatars, safe GitHub Markdown, and comments missing from current files', async ({ page, reviewUrl }) => {
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=', 'base64'),
  }))
  await page.route('**/api/prs/42', async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.comments.issueComments.push({ id: 9001, author: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1', body: '<details><summary>Evidence</summary><p>Passed</p></details><script>alert(1)</script><iframe src="https://example.com"></iframe>', createdAt: '2026-09-10T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z', url: 'https://github.com/comment/9001' })
    bundle.comments.reviews = [{ ...bundle.comments.issueComments.at(-1), id: 9002, body: '**Reviewed**', state: 'APPROVED' }]
    bundle.comments.reviewComments.push({ ...bundle.comments.reviewComments[0], id: 9003, path: 'removed.ts', body: 'A comment on a removed file', outdated: true, line: null })
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  const avatar = page.locator('.conversation img.av').first()
  await expect(avatar).toBeVisible()
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  await expect(page.locator('.conversation summary').filter({ hasText: 'Evidence' })).toBeVisible()
  await expect(page.locator('#overview iframe, #overview script')).toHaveCount(0)
  await expect(page.locator('#overview strong').filter({ hasText: 'Reviewed' })).toBeVisible()
  await page.locator('.all-review-comments > summary').click()
  await expect(page.getByText('A comment on a removed file', { exact: true })).toBeVisible()
})
