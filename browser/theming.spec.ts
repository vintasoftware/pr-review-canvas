import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

/**
 * What the page looks like right now: the two attributes that pick the look, plus one resolved
 * value per layer the skin repaints (page, card, card header, diff row, command, stripe).
 */
async function readLook(page: Page) {
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  // The folded noise rows carry the same class, so the probe reads a row that is on screen.
  await expect(page.locator('tr.add:not(.folded)').first()).toBeVisible()
  return page.evaluate(() => {
    const root = document.documentElement
    const at = (selector: string) => document.querySelector(selector)
    const style = (selector: string) => {
      const el = at(selector)
      return el === null ? null : getComputedStyle(el)
    }
    return {
      skin: root.getAttribute('data-skin'),
      theme: root.getAttribute('data-theme'),
      pageBg: getComputedStyle(root).backgroundColor,
      cardRadius: style('section.layer')?.borderTopLeftRadius ?? null,
      cardHeaderBg: style('section.layer > .layer-h')?.backgroundColor ?? null,
      addedLineBg: style('tr.add:not(.folded) > td')?.backgroundColor ?? null,
      stripeHeight: style('.stripe')?.height ?? null,
      commandBracket: (() => {
        const el = at('.hdr-actions .cmd')
        return el === null ? null : getComputedStyle(el, '::before').content
      })(),
    }
  })
}

/**
 * Clicks an appearance command and waits for the write to land. The page repaints under the click
 * and saves in the background, so a reload that overtook the write would come back in the old look.
 */
async function clickAppearance(page: Page, selector: string) {
  const saved = page.waitForResponse(
    response => new URL(response.url()).pathname === '/api/appearance' && response.request().method() === 'PUT'
  )
  await page.locator(selector).click()
  expect((await saved).ok()).toBe(true)
}

test('starts in the terminal skin, switches to github, and remembers the choice', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const root = page.locator('html')
  const toggle = page.locator('#skin-toggle')
  await expect(root).toHaveAttribute('data-skin', 'terminal')
  await expect(toggle).toHaveText('skin: terminal')
  expect(await readLook(page)).toMatchObject({
    cardRadius: '0px',
    stripeHeight: '6px',
    commandBracket: '"[ "',
  })

  await clickAppearance(page, '#skin-toggle')
  await expect(root).toHaveAttribute('data-skin', 'github')
  await expect(toggle).toHaveText('skin: github')
  expect(await readLook(page)).toMatchObject({
    cardRadius: '6px',
    stripeHeight: '1px',
    commandBracket: 'none',
  })

  // The choice is saved in .pr-review/settings.yml, and the server renders it onto <html>.
  await page.reload()
  await expect(root).toHaveAttribute('data-skin', 'github')
  await expect(page.locator('#skin-toggle')).toHaveText('skin: github')

  await clickAppearance(page, '#skin-toggle')
  await expect(root).toHaveAttribute('data-skin', 'terminal')
  await page.reload()
  await expect(root).toHaveAttribute('data-skin', 'terminal')
})

test('cycles the theme auto → light → dark and remembers it the same way', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const root = page.locator('html')
  const toggle = page.locator('#theme-toggle')
  await expect(root).toHaveAttribute('data-theme', 'auto')
  await expect(toggle).toHaveText('theme: auto')

  await clickAppearance(page, '#theme-toggle')
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('section.layer > .layer-h')).toHaveCSS('background-color', 'rgb(243, 243, 243)')
  await clickAppearance(page, '#theme-toggle')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('section.layer > .layer-h')).toHaveCSS('background-color', 'rgb(48, 51, 65)')

  // Saved in .pr-review/settings.yml next to the skin, and rendered onto <html> on the next load.
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('#theme-toggle')).toHaveText('theme: dark')

  // Back to auto, which is written too and follows the operating system again.
  await clickAppearance(page, '#theme-toggle')
  await expect(root).toHaveAttribute('data-theme', 'auto')
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'auto')
})

test('lets the query pick the look for one load of a page that runs no app module', async ({ page, reviewUrl }) => {
  const { origin } = new URL(reviewUrl)
  const root = page.locator('html')
  const panel = page.locator('main.home .panel').first()
  await page.goto(`${origin}/?skin=github&theme=dark`)
  await expect(root).toHaveAttribute('data-skin', 'github')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(panel).toHaveCSS('border-top-left-radius', '6px')
  await expect(panel).toHaveCSS('background-color', 'rgb(34, 39, 46)')

  // Nothing was saved, so the next load is the default again.
  await page.goto(`${origin}/`)
  await expect(root).toHaveAttribute('data-skin', 'terminal')
  await expect(root).toHaveAttribute('data-theme', 'auto')
  await expect(panel).toHaveCSS('border-top-left-radius', '0px')
})

const COMBINATIONS = [
  {
    skin: 'terminal',
    theme: 'light',
    pageBg: 'rgb(255, 255, 255)',
    cardHeaderBg: 'rgb(243, 243, 243)',
    addedLineBg: 'rgb(230, 255, 236)',
    cardRadius: '0px',
  },
  {
    skin: 'terminal',
    theme: 'dark',
    pageBg: 'rgb(30, 31, 43)',
    cardHeaderBg: 'rgb(48, 51, 65)',
    addedLineBg: 'rgba(186, 215, 97, 0.14)',
    cardRadius: '0px',
  },
  {
    skin: 'github',
    theme: 'light',
    pageBg: 'rgb(255, 255, 255)',
    cardHeaderBg: 'rgb(246, 248, 250)',
    addedLineBg: 'rgb(230, 255, 236)',
    cardRadius: '6px',
  },
  {
    skin: 'github',
    theme: 'dark',
    pageBg: 'rgb(34, 39, 46)',
    cardHeaderBg: 'rgb(45, 51, 59)',
    addedLineBg: 'rgba(87, 171, 90, 0.15)',
    cardRadius: '6px',
  },
] as const

for (const want of COMBINATIONS) {
  test(`paints the page, the cards, and the diff for the ${want.skin} skin in ${want.theme}`, async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(`${reviewUrl}?skin=${want.skin}&theme=${want.theme}`)
    expect(await readLook(page)).toEqual({
      skin: want.skin,
      theme: want.theme,
      pageBg: want.pageBg,
      cardHeaderBg: want.cardHeaderBg,
      addedLineBg: want.addedLineBg,
      cardRadius: want.cardRadius,
      stripeHeight: want.skin === 'github' ? '1px' : '6px',
      commandBracket: want.skin === 'github' ? 'none' : '"[ "',
    })
  })
}

for (const skin of ['terminal', 'github'] as const) {
  test(`keeps collapse and dismissal working in the ${skin} skin`, async ({ page, reviewUrl }) => {
    await page.goto(`${reviewUrl}?skin=${skin}`)
    const layer = page.locator('section.layer[data-layer="layer-1"]')
    const file = layer.locator('article.file[data-path="src/app.ts"]')
    const fileBody = file.locator(':scope > .file-body')
    const fileToggle = file.locator(':scope > .file-h > .chev')
    await file.scrollIntoViewIfNeeded()
    await expect(fileBody).toBeVisible()
    await fileToggle.click()
    await expect(fileBody).toBeHidden()
    await fileToggle.click()
    await expect(fileBody).toBeVisible()

    const card = layer.locator('li.finding[data-fingerprint="fp-1"]')
    const inline = page.locator('tr.ifind[data-fingerprint="fp-1"]')
    await expect(card).toBeVisible()
    await expect(inline).toBeVisible()
    await card.locator('[data-act="point-dismiss"]').click()
    await expect(card).toBeHidden()
    await expect(inline).toBeHidden()
    await expect(page.locator('.toast')).toHaveText('attention point dismissed')

    const dismissed = page.locator('.dismissed-list')
    await dismissed.locator('[data-act="show-dismissed"]').click()
    await expect(dismissed.locator('li.finding')).toBeVisible()
    await dismissed.locator('[data-act="point-restore"]').click()
    await expect(card).toBeVisible()
  })
}
