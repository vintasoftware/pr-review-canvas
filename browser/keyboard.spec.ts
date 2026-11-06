import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

/** Where an element's top sits in the viewport, in CSS pixels. */
async function topOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate(el => el.getBoundingClientRect().top)
}

test('j and k bring the top of each layer to the top of the screen', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  await expect(page.locator('#layer-run-path')).toBeVisible()
  await page.keyboard.press('j')
  await expect(page.locator('#layer-run-path')).toBeFocused()
  // The layer is taller than the screen, so centering it would hide its heading above the fold.
  expect(await topOf(page, '#layer-run-path')).toBeGreaterThanOrEqual(0)
  expect(await topOf(page, '#layer-run-path')).toBeLessThan(80)
  await page.keyboard.press('n')
  await expect(page.locator('#file-src_app_ts')).toBeFocused()
  expect(await topOf(page, '#file-src_app_ts')).toBeGreaterThanOrEqual(0)
  expect(await topOf(page, '#file-src_app_ts')).toBeLessThan(80)
  await page.keyboard.press('k')
  await expect(page.locator('#layer-run-path')).toBeFocused()
  expect(await topOf(page, '#layer-run-path')).toBeLessThan(80)
})

test('after a scroll, the keys step from the card at the top of the screen', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  await expect(page.locator('#layer-run-path')).toBeVisible()
  await page.keyboard.press('j')
  await expect(page.locator('#layer-run-path')).toBeFocused()
  // The reader scrolls down to the first file with the wheel, leaving the layer's top behind.
  await page.locator('#file-src_app_ts').evaluate(el => el.scrollIntoView({ block: 'start' }))
  await expect.poll(() => topOf(page, '#layer-run-path')).toBeLessThan(0)
  // n steps from the file on screen, not from the layer the ring was left on.
  await page.keyboard.press('n')
  await expect(page.locator('#file-src_new_name_ts')).toBeFocused()
  // The focused card is on screen, so the next key steps from it.
  await page.keyboard.press('p')
  await expect(page.locator('#file-src_app_ts')).toBeFocused()
  expect(await topOf(page, '#file-src_app_ts')).toBeLessThan(80)
})

test('] brings a point of the closed Other layer into view', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  await expect(page.locator('#layer-run-path')).toBeVisible()
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  const row = page.locator('#layer-other tr[data-point="p-2"]')
  await expect(row).toBeFocused()
  await expect(row).toBeInViewport()
})
