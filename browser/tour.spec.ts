import { expect, test } from './fixtures.js'

test('walks the tour of PR 67: scenes size themselves, decisions settle, the quiz reopens, the plan is written', async ({
  page,
  tourUrl,
}) => {
  await page.goto(tourUrl)
  await expect(page).toHaveTitle(/^Tour · #42 /)
  await expect(page.locator('.tour-budget b').first()).toHaveText('6')
  for (const button of await page.locator('.hdr button').all()) {
    await expect(button).toHaveAttribute('title', /\S.+/)
  }
  await expect(page.locator('#canvas-link')).toHaveAttribute('href', '/review/42')
  await page.locator('.tour-cover-actions [data-nav="next"]').click()
  await expect(page).toHaveURL(/#landmark-l0$/)
  await expect(page.locator('.tour-stage-tag')).toHaveText('Before this change')

  // The scene's runtime tells the page how tall it is, and the frame follows.
  const frame = page.locator('iframe.tour-frame[title="scene"]')
  await expect(frame).toHaveAttribute('data-sized', 'true')
  const height = await frame.evaluate(el => el.getBoundingClientRect().height)
  expect(height).toBeGreaterThan(60)
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.frameLocator('iframe.tour-frame').locator('.scene-root')).toBeVisible()

  // Keys and the browser's history move through the landmarks.
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/#landmark-l1$/)
  await page.keyboard.press('i')
  await expect(page.locator('.tour-code')).toBeVisible()
  await expect(page.locator('.tour-literate .tour-diff').first()).toBeVisible()
  await page.locator('.tour-code-tab[data-view="raw"]').click()
  await expect(page.locator('.tour-code-tab[aria-selected="true"]')).toHaveText('raw diff')
  await page.goBack()
  await expect(page).toHaveURL(/#landmark-l0$/)
  await page.goForward()
  await expect(page).toHaveURL(/#landmark-l1$/)
  await page.locator('textarea[data-act="note"]').fill('the pipe rule surprised me')

  // The micro-world's controls work inside the sandbox: a pipe turns the output into JSON.
  await page.goto(`${tourUrl}#landmark-l3`)
  const micro = page.frameLocator('iframe.tour-frame[title="micro-world"]')
  await expect(micro.locator('[data-role="stdout"]')).toContainText('Copied the pr-review-canvas skill')
  await micro.locator('input[name="sc-sim-out"][value="pipe"]').check()
  await expect(micro.locator('[data-role="stdout"]')).toContainText('{"skill":"pr-review-canvas"')

  // Two decisions wait on the third landmark; a chip jumps there and offers the way back.
  await page.goto(`${tourUrl}#landmark-l2`)
  await expect(page.locator('.tour-chip').first()).toHaveText('2 decisions wait here')
  await page.locator('.tour-chip.link').first().click()
  await expect(page).toHaveURL(/#decision-pipe-means-json$/)
  await expect(page.locator('.tour-return')).toContainText('Jumped from landmark 3')
  await page.locator('[data-act="return"]').click()
  await expect(page).toHaveURL(/#landmark-l2$/)

  // The reader keeps every decision; the second one through the keyboard.
  await page.goto(`${tourUrl}#decision-pipe-means-json`)
  await expect(page.locator('.tour-option[aria-checked="true"]')).toHaveAttribute('data-pick', 'keep')
  await page.locator('[data-act="keep"]').click()
  await expect(page.locator('.tour-state')).toContainText('kept · reason PR comment')
  await page.locator('[data-nav="next"]').click()
  await page.keyboard.press('k')
  await page.locator('[data-nav="next"]').click()
  await page.locator('[data-act="keep"]').click()
  await page.locator('[data-nav="next"]').click()

  // A wrong answer reopens the landmark; the right one moves on.
  await expect(page).toHaveURL(/#quiz-q1$/)
  await page.keyboard.press('1')
  await expect(page.locator('.tour-quiz-why.wrong')).toBeVisible()
  await page.locator('[data-act="reopen"]').click()
  await expect(page).toHaveURL(/#landmark-l2$/)
  await page.locator('[data-act="return"]').click()
  await page.locator('.tour-quiz-opt[data-i="1"]').click()
  await expect(page.locator('.tour-quiz-why.right')).toBeVisible()
  await page.locator('[data-nav="next"]').click()
  await page.locator('.tour-quiz-opt[data-i="1"]').click()
  await page.locator('[data-nav="next"]').click()
  await page.locator('.tour-quiz-opt[data-i="1"]').click()
  await page.locator('[data-nav="next"]').click()

  // The plan: the note, the kept reasons, and the prompt once confirmed. The record is shared.
  await expect(page).toHaveURL(/#plan$/)
  await expect(page.locator('.tour-title')).toHaveText('Nothing to change. 3 decisions kept.')
  await expect(page.locator('.tour-kept').first()).toContainText('the pipe rule surprised me')
  await page.locator('[data-act="confirm"]').click()
  await expect(page.locator('#prompt')).toContainText('# Keep PR #42 as the tour settled it')
  await expect(page.locator('.tour-sharing')).toContainText('Record shared on the pull request')
  await expect(page.locator('.toast')).toContainText('record shared')

  // A reload lands where the reader was, with everything they answered.
  await page.reload()
  await expect(page).toHaveURL(/#plan$/)
  await expect(page.locator('#prompt')).toContainText('the pipe rule surprised me')
  const bundle = await (await page.request.get(`${new URL(tourUrl).origin}/api/tours/42`)).json()
  expect(bundle.tour.record.touredBy.map((t: { login: string }) => t.login)).toEqual(['octocat'])
  expect(bundle.tour.record.author.picks['pipe-means-json']).toEqual({ pick: 'keep', place: 'pr' })
})

test('takes a change through the drawer and lists it in the plan', async ({ page, tourUrl }) => {
  await page.goto(`${tourUrl}#decision-pipe-means-json`)
  await page.locator('.tour-option[data-pick="change"]').click()
  await page.locator('[data-act="grill"]').click()
  const dialog = page.locator('#tour-grill')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('textarea[name="what"]')).toHaveValue('Only --json means JSON')
  await dialog.locator('textarea[name="unchanged"]').fill('Agents that pass --json.')
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.tour-state.change')).toContainText('change approved')
  await expect(page.locator('.tour-restated')).toContainText('Agents that pass --json.')
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/#decision-handoff-passes-json$/)
})

test('the home page and the canvas header link to the tour', async ({ page, tourUrl }) => {
  const origin = new URL(tourUrl).origin
  await page.goto(`${origin}/review/42`)
  await expect(page.locator('#tour-link')).toHaveAttribute('href', '/tour/42')
  await page.goto(`${origin}/`)
  await expect(page.locator('a[href="/tour/42"]')).toBeVisible()
})

test('the tour offers the github and olive skins and paints its frames with the theme', async ({
  page,
  tourUrl,
}) => {
  await page.goto(`${tourUrl}#landmark-l0`)
  const frame = page.locator('iframe.tour-frame')
  await expect(frame).toHaveAttribute('src', /skin=github&theme=auto/)
  await page.locator('#theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.frameLocator('iframe.tour-frame').locator('html')).toHaveAttribute('data-theme', 'light')
  await page.locator('#skin-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'olive')
  await expect(page.locator('iframe.tour-frame')).toHaveAttribute('src', /skin=olive&theme=light/)
  await page.locator('#skin-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'github')
})
