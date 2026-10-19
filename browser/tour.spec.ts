import { expect, test } from './fixtures.js'

test('walks the tour of PR 67: scenes size themselves, decisions settle, the quiz reopens, the plan is written', async ({
  page,
  tourUrl,
}) => {
  await page.goto(tourUrl)
  await expect(page).toHaveTitle(/^Tour · #42 /)
  await expect(page.locator('.tour-rail-group[data-kind="landmarks"] .tour-rail-label')).toHaveText(
    '6 landmarks'
  )
  for (const button of await page.locator('.hdr button').all()) {
    await expect(button).toHaveAttribute('title', /\S.+/)
  }
  await expect(page.locator('#canvas-link')).toHaveAttribute('href', '/r/acme/widgets/review/42')
  await page.locator('.tour-cover-actions [data-nav="next"]').click()
  await expect(page).toHaveURL(/#landmark-l0$/)
  await expect(page.locator('.tour-strip-what')).toHaveText('Before this change')

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
  await expect(page.locator('.tour-option[aria-checked="true"]')).toHaveCount(0)
  await page.locator('.tour-option[data-pick="keep"]').click()
  await expect(page.locator('.tour-state')).toHaveText('✓ kept')
  await page.locator('[data-nav="next"]').click()
  await page.keyboard.press('k')
  await page.locator('[data-nav="next"]').click()
  await page.locator('.tour-option[data-pick="keep"]').click()
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

  // The plan: the note, the kept decisions, and the prompt once confirmed. The record is shared.
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
  const bundle = await (await page.request.get(new URL('../api/tours/42', tourUrl).href)).json()
  expect(bundle.tour.record.touredBy.map((t: { login: string }) => t.login)).toEqual(['octocat'])
  expect(bundle.tour.record.author.picks['pipe-means-json']).toEqual({ pick: 'keep' })
})

test('takes something else through the drawer and stays on the decision it settled', async ({
  page,
  tourUrl,
}) => {
  await page.goto(`${tourUrl}#decision-pipe-means-json`)
  await page.locator('.tour-option[data-pick="other"]').click()
  const dialog = page.locator('#tour-grill')
  await expect(dialog).toBeVisible()
  await dialog.locator('textarea[name="what"]').fill('Only --json means JSON')
  await dialog.locator('textarea[name="unchanged"]').fill('Agents that pass --json.')
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/#decision-pipe-means-json$/)
  await expect(page.locator('.tour-state.change')).toContainText('change approved')
  await expect(page.locator('.tour-restated')).toContainText('Agents that pass --json.')
  await page.locator('[data-nav="next"]').click()
  await expect(page).toHaveURL(/#decision-handoff-passes-json$/)
})

test('the home page and the canvas header link to the tour', async ({ page, tourUrl }) => {
  await page.goto(new URL('../review/42', tourUrl).href)
  await expect(page.locator('#tour-link')).toHaveAttribute('href', '/r/acme/widgets/tour/42')
  await page.goto(new URL('../', tourUrl).href)
  await expect(page.locator('a[href="/r/acme/widgets/tour/42"]')).toBeVisible()
})

test('the tour wears its own look, offers only the theme, and paints its frames with it', async ({
  page,
  tourUrl,
}) => {
  await page.goto(`${tourUrl}#landmark-l0`)
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'tour')
  await expect(page.locator('#skin-toggle')).toHaveCount(0)
  const frame = page.locator('iframe.tour-frame')
  await expect(frame).toHaveAttribute('src', /\?theme=auto&/)
  await page.locator('#theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.frameLocator('iframe.tour-frame').locator('html')).toHaveAttribute('data-theme', 'light')
  // The fonts come from the app, as the page's policy allows only its own.
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.fonts.check('800 30px Archivo'))).toBe(true)
  expect(await page.evaluate(() => document.fonts.check('18px "Source Sans 3"'))).toBe(true)
})

test('on a phone the page never scrolls sideways: the rail scrolls in itself', async ({ page, tourUrl }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const hash of ['#cover', '#landmark-l0']) {
    await page.goto(`${tourUrl}${hash}`)
    await expect(page.locator('.tour-strip')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
  await expect(page.locator('.tour-rail-seg[aria-current="step"]')).toHaveAttribute('data-state', 'current')
})
