import { expect, test } from './fixtures.js'

test('a short hunk under a long one spans the width the reader scrolls through', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  await file.scrollIntoViewIfNeeded()
  await file.locator('table.diff td.code').first().waitFor()
  const widths = await file
    .locator('.diff-wrap')
    .first()
    .evaluate(wrap => {
      // A second hunk, then one line in the first long enough to scroll.
      const first = wrap.querySelector('table.diff')
      if (first !== null) wrap.append(first.cloneNode(true))
      const code = [...wrap.querySelectorAll('td.code')].find(c => c.getBoundingClientRect().width > 0)
      if (code) code.textContent = `${code.textContent} ${'x'.repeat(300)}`
      return {
        scroll: wrap.scrollWidth,
        client: wrap.clientWidth,
        tables: [...wrap.querySelectorAll('table.diff')].map(t =>
          Math.round(t.getBoundingClientRect().width)
        ),
      }
    })
  expect(widths.scroll).toBeGreaterThan(widths.client)
  expect(new Set(widths.tables).size).toBe(1)
  expect(widths.tables[0]).toBeGreaterThanOrEqual(widths.scroll - 1)
})

test('a long point body wraps at the card and does not scroll a diff with no long line', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  await file.scrollIntoViewIfNeeded()
  await file.locator('tr.ifind').first().waitFor()
  const widths = await file
    .locator('.diff-wrap')
    .first()
    .evaluate(wrap => {
      wrap
        .querySelector('tr.ifind .f-title')
        ?.insertAdjacentHTML('afterend', `<p>${'a point body that goes on and on '.repeat(60)}</p>`)
      const card = wrap.querySelector('tr.ifind .x-in')
      const withCard = wrap.scrollWidth
      // The same diff without its wide rows: only code lines may set the scroll width.
      const wide = [...wrap.querySelectorAll('tr')].filter(r => r.querySelector('.x-in') !== null)
      for (const r of wide) r.hidden = true
      const codeOnly = wrap.scrollWidth
      for (const r of wide) r.hidden = false
      return { withCard, codeOnly, client: wrap.clientWidth, card: card?.getBoundingClientRect().width ?? 0 }
    })
  expect(widths.withCard).toBe(widths.codeOnly)
  expect(Math.abs(widths.card - widths.client)).toBeLessThanOrEqual(1)
})

test('under a long line, a point in a short hunk stays at the card width and in view', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  await file.scrollIntoViewIfNeeded()
  await file.locator('tr.ifind').first().waitFor()
  const wrap = file.locator('.diff-wrap').first()
  const before = await wrap.evaluate(el => {
    // A second hunk with a line long enough to scroll; the point stays in the short first one.
    const first = el.querySelector('table.diff')
    if (first === null) return null
    const second = first.cloneNode(true) as HTMLTableElement
    for (const r of second.querySelectorAll('tr:has(.x-in)')) r.remove()
    el.append(second)
    const code = [...second.querySelectorAll('tr.add td.code')].find(c => c.getBoundingClientRect().width > 0)
    if (code) code.textContent = `${code.textContent} ${'x'.repeat(300)}`
    return { scroll: el.scrollWidth, client: el.clientWidth }
  })
  expect(before).not.toBeNull()
  expect(before!.scroll).toBeGreaterThan(before!.client * 2)
  await wrap.evaluate(el => {
    el.scrollLeft = el.scrollWidth
  })
  const [card, box] = await Promise.all([
    file.locator('tr.ifind .x-in').first().boundingBox(),
    wrap.boundingBox(),
  ])
  expect(Math.abs(card!.width - before!.client)).toBeLessThanOrEqual(1)
  expect(Math.abs(card!.x - box!.x)).toBeLessThanOrEqual(1)
  await expect(file.locator('tr.ifind [data-act="point-dismiss"]').first()).toBeInViewport()
})
