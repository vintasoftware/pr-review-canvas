import { expect, test } from './fixtures.js'

test('describes every header action and preserves tooltips after review progress changes', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  for (const button of await page.locator('.hdr button').all()) {
    await expect(button).toHaveAttribute('title', /\S.+/)
  }
  await page.locator('section.layer[data-layer="run-path"] [data-act="mark-layer"]').click()
  await expect(page.locator('#approve')).toBeEnabled()
  await expect(page.locator('#approve')).toHaveAttribute(
    'title',
    'Write and preview an approving review on GitHub'
  )
  await expect(page.locator('#request-changes')).toHaveAttribute(
    'title',
    'Write and preview a review requesting changes on GitHub'
  )
})

test('switches how much code is hidden from the control and from the keyboard', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const select = page.locator('#fold-level')
  const hint = page.locator('.reading .fold-hint')

  // The canvas opens at the level saved in settings.yml, light until changed; a change from the
  // control is page state and is not saved.
  await expect(select).toHaveValue('light')
  await expect(hint).toContainText('imports, whitespace, moved blocks, and generated files')

  await select.selectOption('moderate')
  await expect(page.locator('.toast')).toHaveText('hiding code: moderate')
  await expect(hint).toContainText('also test bodies, helpers, wiring, templates')

  await page.locator('body').press('f')
  await expect(select).toHaveValue('aggressive')
  await expect(hint).toContainText('only the code you have to judge')
  await page.locator('body').press('f')
  await expect(select).toHaveValue('light')

  await page.reload()
  await expect(page.locator('#fold-level')).toHaveValue('light')
})

test('offers the default reading level in the settings dialog and saves it', async ({ page, reviewUrl }) => {
  // The harness runs with chat off, which turns the settings routes off too, so the dialog's
  // requests are answered here. The store and the routes are covered by the unit tests.
  const response = {
    settings: {
      foldLevel: 'moderate',
      chatAgent: 'claude',
      chatModel: null,
      chatTimeoutSec: 600,
      maxTurns: null,
    },
    overrides: {},
    file: '/repo/.pr-review/settings.yml',
    project: {
      file: null,
      chatEnabled: true,
      rulebook: null,
      layers: 0,
      highRisk: 0,
      generationModels: { claude: 'opus' },
    },
  }
  await page.route('**/api/prs/42', async route => {
    const fetched = await route.fetch()
    const bundle = await fetched.json()
    bundle.chat.enabled = true
    await route.fulfill({ response: fetched, json: bundle })
  })
  await page.route('**/api/prs/42/chat/threads', route =>
    route.fulfill({ json: { threads: [], activeThread: null } })
  )
  await page.route('**/api/settings/agents', route =>
    route.fulfill({ json: { acpx: { installed: true, version: '0.13.2' }, agents: [] } })
  )
  const saved: unknown[] = []
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') {
      saved.push(route.request().postDataJSON())
    }
    await route.fulfill({ json: response })
  })

  await page.goto(reviewUrl)
  await page.locator('#settings').click()
  const level = page.locator('#settings-dialog #set-fold-level')
  await expect(level).toHaveValue('moderate')
  await level.selectOption('aggressive')
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ foldLevel: 'aggressive' })
})

test('keeps the header when the review fails to load, so the reader can leave for another', async ({
  page,
  reviewUrl,
}) => {
  await page.route('**/api/prs/42', route =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'PR_NOT_FOUND', message: 'pull request #42 not found' } },
    })
  )
  await page.goto(reviewUrl)
  await expect(page.locator('.error-card')).toBeVisible()
  await expect(page.locator('.hdr a.brand-wordmark')).toHaveAttribute('href', '/')
  await expect(page.locator('.hdr .brand a.mono')).toHaveText('acme/widgets')
})

test('shows the change totals of the header and each layer, and keeps them as review progresses', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  await expect(page.locator('.hdr .diffstat')).toHaveAttribute('title', 'code +5 −4 · tests +2 −1')
  const layer = page.locator('nav.rail a[href="#layer-run-path"]')
  await expect(layer.locator('.diffstat')).toHaveAttribute('title', 'code +3 −2 · tests +2 −1')
  await expect(layer.locator('.m')).toHaveText('3 files · +5 −3 (code +3 −2 · tests +2 −1) · schema')
  // Marking the layer redraws the rail, which keeps the totals counted from the patches.
  await page.locator('section.layer[data-layer="run-path"] [data-act="mark-layer"]').click()
  await expect(layer.locator('.dot')).toHaveClass('dot on')
  await expect(layer.locator('.m')).toHaveText('3 files · +5 −3 (code +3 −2 · tests +2 −1) · schema')
})
