import { expect, test } from '@playwright/test'

test('built site loads under the Pages subpath with working assets and section links', async ({ page }) => {
  const errors = []
  const failed = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) failed.push(response.url())
  })
  await page.goto('./')
  await expect(page).toHaveTitle('PR Review Canvas — Open-source AI code review tool')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Big PR.Clear picture.')
  await expect(page.getByRole('link', { name: '#9612', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/TanStack/query/pull/9612'
  )
  const brokenAnchors = await page
    .locator('a[href^="#"]')
    .evaluateAll(links =>
      links
        .map(link => link.getAttribute('href'))
        .filter(href => href !== '#' && !document.querySelector(href))
    )
  expect(brokenAnchors).toEqual([])
  expect(await page.locator('.brand img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
  await page.locator('.footer-vinta').scrollIntoViewIfNeeded()
  await expect(page.locator('.footer-vinta img')).toBeVisible()
  await expect
    .poll(() => page.locator('.footer-vinta img').evaluate(img => img.complete && img.naturalWidth > 0))
    .toBe(true)
  expect(errors).toEqual([])
  expect(failed).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('layers change the real source excerpt and retain separate review progress', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'sample layers' })).toHaveText(
    '1 of 3 sample layers reviewed'
  )
  await page.getByRole('button', { name: 'Query lifecycle', exact: true }).click()
  await expect(page.locator('#sample-code')).toContainText('timeoutManager.setTimeout')
  await expect(page.locator('#sample-source')).toHaveAttribute('href', /7922966.*queryObserver.ts/)
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await page.getByRole('button', { name: 'Next-tick scheduling', exact: true }).click()
  await expect(page.locator('#sample-code')).toContainText('systemSetTimeoutZero')
  await page.getByRole('button', { name: 'Timer provider, reviewed', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reviewed ✓', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.getByRole('button', { name: 'Reviewed ✓', exact: true }).click()
  await expect(page.locator('#sample-progress')).toHaveText('0 of 3 sample layers reviewed')
})

test('fold expands from the keyboard without changing review progress', async ({ page }) => {
  await page.goto('./')
  const fold = page.locator('.code-fold')
  await expect(fold.locator('pre')).toBeHidden()
  await fold.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(fold.locator('pre')).toBeVisible()
  await expect(fold.locator('pre')).toContainText('+import type { ManagedTimerId }')
  await expect(page.locator('#sample-progress')).toHaveText('0 of 3 sample layers reviewed')
  await page.keyboard.press('Enter')
  await expect(fold.locator('pre')).toBeHidden()
})

test('scripted chat switches questions and links to the evidence', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: 'Switching providers', exact: true }).click()
  await expect(page.locator('#chat-answer')).toContainText('neither migrates timers nor blocks the switch')
  await expect(page.locator('#chat-reference')).toHaveAttribute('href', /timeoutManager.ts#L72-L109$/)
  await page.getByRole('button', { name: 'Notification scheduling', exact: true }).click()
  await expect(page.locator('#chat-answer')).toContainText('setTimeout(callback, 0)')
  await expect(page.locator('.chat-demo:not(.canvas-chat-panel) .chat-disclosure')).toContainText(
    'not a live agent conversation'
  )
})

test('installation commands can be copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('./')
  await page.getByRole('button', { name: 'Copy installation commands' }).click()
  await expect(page.locator('#copy-status')).toHaveText('Commands copied to clipboard.')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('npm install -g @vintasoftware/pr-review-canvas\n')
  expect(copied).toContain('pr-review install-skill')
})

test('documentation and real source remain readable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:4173/pr-review-canvas/')
  const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent())
  expect(schema['@graph'].find(entity => entity['@id'].endsWith('#software')).name).toBe('PR Review Canvas')
  await expect(page.locator('.hero-intro')).toContainText('guided canvas')
  await expect(page.locator('#sample-code')).toContainText('this.#provider.setTimeout')
  await page.locator('.faq-list summary').filter({ hasText: 'How much does it cost?' }).click()
  await expect(page.locator('.faq-list details[open]')).toContainText('no separate Canvas subscription')
  await expect(page.locator('#get-started')).toContainText('pr-review serve')
  await context.close()
})

test('PR demo chat opens, answers questions, and returns focus when closed', async ({ page }) => {
  await page.goto('./')
  const launcher = page.getByRole('button', { name: 'AI Chat', exact: true })
  const panel = page.getByRole('dialog', { name: 'AI Chat about this PR' })
  await expect(panel).toBeHidden()
  await launcher.click()
  await expect(panel).toBeVisible()
  await expect(launcher).toHaveAttribute('aria-expanded', 'true')
  await panel.getByRole('button', { name: 'Switching providers' }).click()
  await expect(panel.locator('.agent-message')).toContainText('neither migrates timers nor blocks the switch')
  await expect(page.locator('#chat-answer')).toContainText('zero-delay scheduling')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(launcher).toBeFocused()
  await launcher.click()
  await expect(panel.locator('.agent-message')).toContainText('neither migrates timers nor blocks the switch')
  await panel.getByRole('button', { name: 'Close AI chat' }).click()
  await expect(panel).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
