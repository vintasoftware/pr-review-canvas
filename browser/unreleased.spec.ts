import { readFile } from 'node:fs/promises'
import { ghHandler, ghPost } from '../src/testing/fakes.js'
import { GH_ISSUE_COMMENTS, ghFor42, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

for (const skin of ['github', 'olive', 'terminal']) {
  test(`saves and resets the new reading and chat settings in the ${skin} skin`, async ({
    page,
    chatServer,
  }) => {
    const { url, ctx } = await chatServer()
    await page.goto(`${url}?skin=${skin}`)
    const point = page.locator('#layer-run-path li.finding[data-fingerprint="fp-1"]')
    const file = page.locator('#file-src_app_ts > .file-body')
    const prose = page.locator('#overview .summary, #layer-run-path .rationale, .pr-desc .prose')
    await expect(point.locator('.prose')).toBeVisible()
    await expect(file).toBeVisible()
    await page.locator('.pr-desc > summary').click()
    for (const block of await prose.all()) await expect(block).not.toHaveCSS('max-width', 'none')

    await page.locator('#settings').click()
    for (const id of ['start-collapsed', 'compact-points', 'full-width-text']) {
      await expect(page.locator(`#set-${id}`)).not.toBeChecked()
      await page.locator(`#set-${id}`).check()
    }
    await page.locator('#settings-dialog').getByRole('tab', { name: 'AI Chat', exact: true }).click()
    await expect(page.locator('#set-chat-start-minimized')).not.toBeChecked()
    await page.locator('#set-chat-start-minimized').check()
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
    for (const block of await prose.all()) await expect(block).toHaveCSS('max-width', 'none')
    const saved = await readFile(ctx.settings.file, 'utf8')
    for (const key of ['startCollapsed', 'compactPoints', 'fullWidthText', 'chatStartMinimized']) {
      expect(saved).toContain(`${key}: true`)
    }

    await page.reload()
    await expect(file).toBeHidden()
    await expect(page.locator('#layer-run-path > .layer-body')).toBeVisible()
    await expect(point.locator('.prose')).toBeHidden()
    await expect(page.locator('.chat')).toBeHidden()
    await page.locator('#chat-launcher').click()
    await expect(page.locator('#msg')).toBeFocused()
    if (await page.locator('#chat-dialog').isVisible()) {
      await page.locator('#chat-minimize').click()
    }

    await page.locator('#settings').click()
    await expect(page.locator('#set-chat-start-minimized')).toBeChecked()
    await page.locator('#set-chat-start-minimized').uncheck()
    await page.getByRole('tab', { name: 'Reading', exact: true }).click()
    for (const id of ['start-collapsed', 'compact-points', 'full-width-text']) {
      await expect(page.locator(`#set-${id}`)).toBeChecked()
      await page.locator(`#set-${id}`).uncheck()
    }
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
    await page.reload()
    await expect(file).toBeVisible()
    await expect(point.locator('.prose')).toBeVisible()
    await expect(point.locator('.p-toggle')).toBeHidden()
    await expect(page.locator('#layer-run-path [data-act="points-density"]')).toBeHidden()
    await expect(page.locator('#overview .summary')).not.toHaveCSS('max-width', 'none')
    if (page.viewportSize()!.width > 1360) await expect(page.locator('.layout > .chat')).toBeVisible()
    const reset = await readFile(ctx.settings.file, 'utf8')
    for (const key of ['startCollapsed', 'compactPoints', 'fullWidthText', 'chatStartMinimized']) {
      expect(reset).toContain(`${key}: false`)
    }
  })

  test(`shows distinct notification tones in light and dark ${skin}`, async ({ page, noChatUrl }) => {
    for (const theme of ['light', 'dark']) {
      await page.goto(`${noChatUrl}?skin=${skin}&theme=${theme}`)
      const toast = page.locator('pr-app > .toast')
      await page.locator('#fold-level').selectOption('moderate')
      await expect(toast).toHaveAttribute('data-tone', 'note')
      await expect(toast).toBeInViewport()
      const noteColor = await toast.evaluate(el => getComputedStyle(el).borderLeftColor)
      await toast.click()
      await expect(toast).toBeHidden()

      await page
        .locator('#layer-run-path li.finding[data-fingerprint="fp-1"] [data-act="point-dismiss"]')
        .click()
      await expect(toast).toHaveAttribute('data-tone', 'done')
      const doneColor = await toast.evaluate(el => getComputedStyle(el).borderLeftColor)
      await toast.click()
      const point = page.locator('#layer-run-path li.finding[data-fingerprint="fp-1"]')
      await point.locator('.p-toggle').click()
      await point.locator('[data-act="point-restore"]').click()
      await expect(point).toHaveAttribute('data-status', 'open')
      await toast.click()
      await page.route('**/api/appearance', route =>
        route.fulfill({ status: 400, json: { error: { code: 'SETTINGS_INVALID', message: 'Cannot save' } } })
      )
      await page.locator('#theme-toggle').click()
      await expect(toast).toHaveAttribute('data-tone', 'failed')
      await expect(toast).toHaveText('could not save the theme to settings.yml')
      const failedColor = await toast.evaluate(el => getComputedStyle(el).borderLeftColor)
      expect(new Set([noteColor, doneColor, failedColor]).size).toBe(3)
      await expect(toast).toBeInViewport()
      await page.unroute('**/api/appearance')
    }
  })
}

test('saves reading settings when the project turns AI Chat off', async ({ page, noChatUrl }) => {
  await page.goto(noChatUrl)
  await page.locator('#settings').click()
  await expect(page.getByRole('tab', { name: 'AI Chat', exact: true })).toHaveCount(0)
  await page.locator('#set-start-collapsed').check()
  await page.locator('#set-compact-points').check()
  await page.locator('#set-full-width-text').check()
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  await page.reload()
  await expect(page.locator('#file-src_app_ts > .file-body')).toBeHidden()
  await expect(page.locator('#layer-run-path li.finding .prose')).toBeHidden()
  await expect(page.locator('#overview .summary')).toHaveCSS('max-width', 'none')
})

test('full-width text widens rendered diagrams in the summary and rationale', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await page.setViewportSize({ width: 1800, height: 900 })
  const { url } = await chatServer({
    setup: async ({ ctx }) => {
      await ctx.settings.write({ chatStartMinimized: true })
      const artifact = syntheticArtifact()
      const diagram = '```mermaid\nflowchart LR\n A[Before] --> B[After]\n```'
      artifact.summary += `\n\n${diagram}`
      artifact.layers[0]!.rationale += `\n\n${diagram}`
      ctx.fixtureArtifact = artifact
    },
  })
  for (const skin of ['github', 'olive', 'terminal']) {
    await page.goto(`${url}?skin=${skin}`)
    const diagrams = page.locator('#overview .summary .diagram, #layer-run-path .rationale .diagram')
    await expect(diagrams.locator('svg')).toHaveCount(2)
    const widths = await diagrams.evaluateAll(elements =>
      elements.map(el => el.getBoundingClientRect().width)
    )
    await page.locator('#settings').click()
    await page.locator('#set-full-width-text').check()
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
    const wider = await diagrams.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width))
    for (let i = 0; i < widths.length; i++) expect(wider[i]! - widths[i]!).toBeGreaterThan(100)
    await page.locator('#settings').click()
    await page.locator('#set-full-width-text').uncheck()
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
  }
})

test('a review receipt link opens the posted review when its notification is dismissed by the click', async ({
  page,
  context,
  noChatUrl,
}) => {
  await context.route('https://github.com/**', route => route.fulfill({ body: 'Posted review' }))
  await page.goto(noChatUrl)
  await page.locator('#layer-run-path li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]').click()
  await page.locator('.pending-bar [data-act="pending-finish"]').click()
  await page.locator('[data-act="signoff-post"]').click()
  await expect(page.locator('#signoff-dialog')).toBeHidden()
  const toast = page.locator('pr-app > .toast')
  await expect(toast).toHaveText('review posted with 1 comment · see it on GitHub')
  const opened = page.waitForEvent('popup')
  await toast.getByRole('link', { name: 'see it on GitHub' }).click()
  const review = await opened
  await expect(review).toHaveURL('https://github.com/acme/widgets/pull/42#pullrequestreview-7001')
  await expect(toast).toBeHidden()
})

for (const [statuses, label] of [
  [['covered', 'not-needed'], 'fully covered'],
  [['covered', 'missing', 'not-needed'], '1 of 2 covered'],
  [['missing', 'not-needed'], 'not covered'],
  [['not-needed'], 'no tests needed'],
] as const) {
  test(`starts Tests closed with ${label}, excluding behaviors needing no test`, async ({
    page,
    chatServer,
  }) => {
    const { url } = await chatServer({
      setup: async ({ ctx }) => {
        await ctx.settings.write({ startCollapsed: true })
        const artifact = syntheticArtifact()
        const tests = artifact.layers[0]!.tests
        artifact.layers[0]!.tests = tests.filter(t => statuses.some(status => status === t.status))
        ctx.fixtureArtifact = artifact
      },
    })
    await page.goto(url)
    const tests = page.locator('#layer-run-path details.test-map')
    await expect(tests).not.toHaveAttribute('open')
    await expect(tests.locator('summary')).toHaveText(`Tests${label}`)
    await expect(tests.locator('table')).toBeHidden()
    await tests.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(tests.locator('table')).toBeVisible()
    await expect(tests.locator('tbody tr')).toHaveCount(statuses.length)
    if (statuses.some(status => status === 'covered')) {
      await tests.getByRole('link', { name: 'src/app.test.ts', exact: true }).click()
      await expect(page.locator('#file-src_app_test_ts > .file-body')).toBeVisible()
      await expect(page.locator('#file-src_app_test_ts')).toBeInViewport()
    }
  })
}

test('starts Conversation closed with a count and keeps it open after a comment is posted', async ({
  page,
  chatServer,
}) => {
  const comments = [...GH_ISSUE_COMMENTS]
  const { url } = await chatServer({
    setup: async ({ ctx }) => {
      ctx.gh = ghFor42({
        routes: { 'repos/acme/widgets/issues/42/comments': ghHandler(() => comments) },
        postRoutes: {
          'repos/acme/widgets/issues/42/comments': ghPost(body => {
            const comment = {
              ...GH_ISSUE_COMMENTS[0]!,
              id: 2003,
              user: { login: 'octocat' },
              body: (body as { body: string }).body,
              html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-2003',
            }
            comments.push(comment)
            return comment
          }),
        },
      })
    },
  })
  await page.goto(url)
  const conversation = page.locator('.pr-conversation')
  await expect(conversation).not.toHaveAttribute('open')
  await expect(conversation.locator(':scope > summary')).toHaveText('Conversation · 2')
  await conversation.locator(':scope > summary').click()
  await conversation.locator('[data-act="pr-comment"]').click()
  await conversation.locator('textarea').fill('Ready for the release checks.')
  await conversation.locator('[data-act="composer-post"]').click()
  await expect(conversation.locator(':scope > summary')).toHaveText('Conversation · 3')
  await expect(conversation).toHaveAttribute('open')
  await expect(
    conversation.locator('.cmt').filter({ hasText: 'Ready for the release checks.' })
  ).toBeVisible()
  await page.reload()
  await expect(conversation).not.toHaveAttribute('open')
  await expect(conversation.locator(':scope > summary')).toHaveText('Conversation · 3')
})

test.describe('with collapsed files and compact points', () => {
  test.use({ settings: { startCollapsed: true, compactPoints: true, chatStartMinimized: true } })

  test('reads a point and its code with the new reading preferences enabled together', async ({
    page,
    chatServer,
  }) => {
    const { url } = await chatServer({
      setup: async ({ ctx }) => {
        await ctx.settings.write({ readByPoints: true, fullWidthText: true })
      },
    })
    await page.goto(url + '#point-p-1')
    const layer = page.locator('#layer-run-path')
    await expect(layer).toHaveAttribute('data-lens', 'point')
    await expect(layer.locator('#point-p-1 .prose')).toBeVisible()
    await expect(layer.locator('table.diff:visible')).toHaveCount(1)
    await expect(page.locator('.chat')).toBeHidden()
    await page.locator('nav.rail .rail-view [data-view="layers"]').click()
    await expect(page.locator('#point-p-1')).toBeInViewport()
    await page.locator('nav.rail .rail-view [data-view="points"]').click()
    await expect(layer).toHaveAttribute('data-lens', 'point')
    await page.reload()
    await expect(layer.locator('#point-p-1 .prose')).toBeVisible()
    await expect(layer.locator('table.diff:visible')).toHaveCount(1)
  })

  for (const layerView of ['all', 'one'] as const) {
    test(`opens closed targets through keys, links and the rail with ${layerView} layers`, async ({
      page,
      chatServer,
    }) => {
      const { url } = await chatServer({
        setup: async ({ ctx }) => {
          await ctx.settings.write({ layerView })
          const artifact = syntheticArtifact()
          artifact.layers[1]!.kind = 'layer'
          ctx.fixtureArtifact = artifact
        },
      })
      await page.goto(url)
      const layer = page.locator('#layer-run-path')
      const file = page.locator('#file-src_app_ts')
      await expect(page.locator('#layer-other > .layer-body')).toBeHidden()
      await page.locator('nav.rail a[href="#layer-run-path"]').click()
      await expect(layer.locator(':scope > .layer-body')).toBeVisible()
      await page.keyboard.press('n')
      await expect(file).toBeFocused()
      await expect(file.locator(':scope > .file-body')).toBeVisible()
      await page.keyboard.press('n')
      await expect(page.locator('#file-src_new_name_ts > .file-body')).toBeVisible()
      await page.keyboard.press('p')
      await expect(file).toBeFocused()
      const point = layer.locator('li.finding[data-fingerprint="fp-1"]')
      await page.keyboard.press('k')
      await page.keyboard.press(']')
      await expect(point).toBeFocused()
      await page.keyboard.press('o')
      await expect(point.locator('.prose')).toBeVisible()
      await page.keyboard.press('o')
      await expect(point.locator('.prose')).toBeHidden()
      await page.locator('nav.rail a[href="#layer-other"]').click()
      await expect(page.locator('#layer-other > .layer-body')).toBeVisible()
      await page.keyboard.press('k')
      await expect(layer.locator(':scope > .layer-body')).toBeVisible()
      await page.locator('nav.rail a[href="#overview"]').click()
      await page.getByRole('link', { name: 'app.ts', exact: true }).first().click()
      await expect(page.locator('#hunk-src_app_ts-1')).toBeInViewport()
      await page.reload()
      await expect(file.locator(':scope > .file-body')).toBeVisible()
      await expect(page.locator('#hunk-src_app_ts-1')).toBeInViewport()
    })
  }

  test('raising Hide code closes whole hidden files and lowering it leaves them closed', async ({
    page,
    chatServer,
  }) => {
    const { url } = await chatServer({
      setup: async ({ ctx }) => {
        const artifact = syntheticArtifact()
        artifact.layers[0]!.files.find(file => file.path === 'src/app.test.ts')!.collapsed = 'moderate'
        ctx.fixtureArtifact = artifact
      },
    })
    await page.goto(url)
    const testFile = page.locator('#file-src_app_test_ts')
    const otherFile = page.locator('#file-src_new_name_ts > .file-body')
    await testFile.locator('.file-h > .path').click()
    await expect(testFile.locator(':scope > .file-body')).toBeVisible()
    await expect(otherFile).toBeHidden()
    await page.locator('#fold-level').selectOption('moderate')
    await expect(testFile.locator(':scope > .file-body')).toBeHidden()
    await expect(otherFile).toBeHidden()
    await page.locator('#fold-level').selectOption('light')
    await expect(testFile.locator(':scope > .file-body')).toBeHidden()
    await expect(otherFile).toBeHidden()
    await page.locator('.toast').click()
    await testFile.locator('.file-h > .path').click()
    await expect(testFile.locator(':scope > .file-body')).toBeVisible()
  })
})
