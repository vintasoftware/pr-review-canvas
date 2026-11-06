import { expect, test } from './fixtures.js'

test('keeps a file collapsed when lazy rendering completes after the click', async ({ page, reviewUrl }) => {
  await page.addInitScript(() => {
    window.IntersectionObserver = class extends IntersectionObserver {
      override observe(target: Element) {
        if (target.tagName === 'PR-FILE') {
          window.addEventListener('render-test-files', () => super.observe(target), { once: true })
        } else {
          super.observe(target)
        }
      }
    }
  })
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  const body = file.locator(':scope > .file-body')
  const toggle = file.locator(':scope > .file-h > .chev')
  await expect(file.locator('.diff-host .loading')).toBeVisible()
  await toggle.click()
  await expect(body).toBeHidden()

  await page.evaluate(() => window.dispatchEvent(new Event('render-test-files')))
  await expect(file.locator('tr.ifind[data-fingerprint="fp-1"]')).toHaveCount(1)
  await expect(body).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await toggle.click()
  await expect(body).toBeVisible()
  await expect(file.locator('tr.ifind[data-fingerprint="fp-1"]')).toBeVisible()
})
