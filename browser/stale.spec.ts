import { expect, test } from './fixtures.js'

test('notes a canvas that still applies after merge commits, without disabling posting', async ({
  page,
  reviewUrl,
}) => {
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.mergesSince = {
      canvasHeadSha: 'c'.repeat(40),
      currentHeadSha: bundle.pr.headSha,
      commitsBehind: 2,
    }
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  const note = page.locator('#main > .stale-bar.merges-bar')
  await expect(note).toBeVisible()
  await expect(note).toContainText('Canvas still applies.')
  await expect(note).toContainText('generated for ccccccc')
  await expect(note).toContainText('the 2 commits since left the diff unchanged')
  await expect(page.locator('section.layer').first()).toBeVisible()
  await expect(page.locator('#es-h')).toHaveCount(0)
})

test('warns above an outdated canvas and clears the warning after refresh', async ({ page, reviewUrl }) => {
  let outdated = true
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    if (outdated) {
      bundle.status = 'stale'
      bundle.stale = {
        canvasHeadSha: bundle.pr.headSha,
        currentHeadSha: 'b'.repeat(40),
        relation: 'ancestor',
        commitsBehind: 1,
      }
    }
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  await expect(page.locator('#es-h')).toHaveText('Canvas is outdated')
  await page.locator('#view-stale').click()
  const warning = page.locator('#main > .stale-bar')
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('Canvas is outdated.')
  await expect(warning).toContainText('1 commit behind')
  await expect(page.locator('#main > :first-child')).toHaveClass('stale-bar')
  outdated = false
  await page.locator('#refresh').click()
  await expect(page.locator('section.layer').first()).toBeVisible()
  await expect(warning).toHaveCount(0)
})
