import { parseUnifiedDiff, toFileEntry } from '../src/git/diff-collector.js'
import type { FakeGit } from '../src/testing/fakes.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_DIFF, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

const summary =
  '[File start](#file:src/app.ts) · [Later line](#line:src/app.ts:13) · [Later hunk](#hunk:src/app.ts#2)'

for (const layerView of ['all', 'one'] as const) {
  for (const target of ['line', 'hunk'] as const) {
    test(`${target} links reveal the later part of a file with ${layerView} layers`, async ({
      page,
      chatServer,
    }) => {
      const server = await chatServer({
        setup: async ({ ctx }) => {
          ctx.fixtureArtifact = { ...syntheticArtifact(), summary }
        },
      })
      await page.goto(server.url)
      if (layerView === 'one') {
        await page.locator('#settings').click()
        await page.locator('#set-layer-view').selectOption('one')
        await page.locator('[data-act="settings-save"]').click()
        await expect(page.locator('#settings-dialog')).toBeHidden()
      }
      // Other starts collapsed, with its diff undrawn.
      await expect(page.locator('#L-src_app_ts-new-13')).toHaveCount(0)
      await page
        .locator('#overview')
        .getByRole('link', { name: target === 'line' ? 'Later line' : 'Later hunk', exact: true })
        .click()
      const destination = page.locator(target === 'line' ? '#L-src_app_ts-new-13' : '#hunk-src_app_ts-2')
      await expect(destination).toHaveClass(/is-target/)
      await expect(destination).not.toHaveClass(/is-approx/)
      await expect(destination).toBeInViewport()
      await expect(page.locator('#layer-other')).toBeVisible()
      if (layerView === 'one') await expect(page.locator('#layer-run-path')).toBeHidden()
      await page.goBack()
      await expect(page).toHaveURL(server.url)
      await expect(page.locator('#overview')).toBeVisible()
      await page.goForward()
      await expect(destination).toBeInViewport()
      // A shared URL must find the same lazy card on a fresh page.
      await page.reload()
      await expect(destination).toHaveClass(/is-target/)
      await expect(destination).toBeInViewport()
    })
  }
}

for (const skin of ['terminal', 'github']) {
  test(`file links show the start of a tall diff in the ${skin} skin and support Back`, async ({
    page,
    chatServer,
  }) => {
    const server = await chatServer({
      setup: async ({ ctx }) => {
        const longDiff = [
          'diff --git a/src/large.ts b/src/large.ts',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/large.ts',
          '@@ -0,0 +1,150 @@',
          ...Array.from({ length: 150 }, (_, i) => `+export const value${i + 1} = ${i + 1}`),
          '',
        ].join('\n')
        const git = ctx.git as FakeGit
        git.options.diffs![`${BASE_SHA}..${HEAD_SHA}`] = SYNTHETIC_DIFF + longDiff
        const artifact = syntheticArtifact()
        artifact.files.push(...parseUnifiedDiff(longDiff).map(toFileEntry))
        artifact.layers[0]!.files.push({
          path: 'src/large.ts',
          hunks: ['src_large_ts#1'],
          isTest: false,
          annotations: [],
        })
        artifact.summary = '[Large file](#file:src/large.ts)'
        ctx.fixtureArtifact = artifact
      },
    })
    await page.goto(`${server.url}?skin=${skin}`)
    const link = page.locator('#overview').getByRole('link', { name: 'Large file', exact: true })
    await expect(link).toBeVisible()
    const before = await page.evaluate(() => scrollY)
    await link.click()
    const card = page.locator('#file-src_large_ts')
    await expect(card).toHaveClass(/is-target/)
    await expect(page.locator('#L-src_large_ts-new-1')).toBeInViewport()
    const top = await card.evaluate(el => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThan(-1)
    expect(top).toBeLessThan(100)
    await page.goBack()
    await expect(page).toHaveURL(`${server.url}?skin=${skin}`)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(before, 0)
    await page.goForward()
    await expect(page.locator('#L-src_large_ts-new-1')).toBeInViewport()
  })
}

test('settings returns keyboard focus to its opener after Escape, close, and save', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const opener = page.locator('#settings')
  for (const close of ['Escape', 'settings-close', 'settings-save']) {
    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#settings-dialog')).toBeVisible()
    if (close === 'Escape') await page.keyboard.press('Escape')
    else await page.locator(`[data-act="${close}"]`).click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
    await expect(opener).toBeFocused()
  }
})

test('refresh protects unfinished text, including edits made while patches are loading', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const file = page.locator('#file-src_app_ts')
  await file.scrollIntoViewIfNeeded()
  await file.locator('#L-src_app_ts-new-4 .plus').click()
  const editor = file.locator('tr.composer textarea')
  await editor.fill('Keep this unfinished comment')
  page.once('dialog', dialog => dialog.dismiss())
  await page.locator('#refresh').click()
  await expect(page.locator('#refresh')).toBeEnabled()
  await expect(editor).toHaveValue('Keep this unfinished comment')
  // The original screen must still work after cancelling the refresh.
  await file.locator('[data-act="composer-queue"]').click()
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
  await file.locator('[data-act="pending-edit"]').click()
  const pendingEditor = file.locator('.pending-cmt textarea')
  await pendingEditor.fill('An unsaved edit')
  page.once('dialog', dialog => dialog.dismiss())
  await page.locator('#refresh').click()
  await expect(page.locator('#refresh')).toBeEnabled()
  await expect(pendingEditor).toHaveValue('An unsaved edit')
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#refresh').click()
  await expect(page.locator('#refresh')).toBeEnabled()
  await file.scrollIntoViewIfNeeded()
  await expect(file.locator('.pending-cmt .prose')).toContainText('Keep this unfinished comment')
  await expect(file.locator('textarea')).toHaveCount(0)

  await file.locator('#L-src_app_ts-new-5 .plus').click()
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  await page.route('**/api/prs/42/patches', async route => {
    const response = await route.fetch()
    await waiting
    await route.fulfill({ response })
  })
  const request = page.waitForRequest('**/api/prs/42/patches')
  await page.locator('#refresh').click()
  await request
  await editor.fill('Typed during refresh')
  page.once('dialog', dialog => dialog.dismiss())
  release()
  await expect(page.locator('#refresh')).toBeEnabled()
  await expect(editor).toHaveValue('Typed during refresh')
})

for (const activation of ['click', 'Enter'] as const) {
  test(`diagram links preserve history on ${activation}`, async ({ page, chatServer }) => {
    const server = await chatServer({
      setup: async ({ ctx }) => {
        const artifact = syntheticArtifact()
        artifact.layers[0]!.diagram = {
          mermaid: 'flowchart LR\n  A[Later change]',
          links: { A: '#line:src/app.ts:13' },
        }
        ctx.fixtureArtifact = artifact
      },
    })
    await page.goto(server.url)
    const node = page.locator('.diagram-body [data-link]').first()
    await expect(node).toBeVisible()
    if (activation === 'click') await node.click()
    else await node.press('Enter')
    await expect(page).toHaveURL(`${server.url}#line:src/app.ts:13`)
    await expect(page.locator('#L-src_app_ts-new-13')).toBeInViewport()
    await page.goBack()
    await expect(page).toHaveURL(server.url)
    await expect(node).toBeInViewport()
    await page.goForward()
    await expect(page.locator('#L-src_app_ts-new-13')).toBeInViewport()
  })
}

for (const bodyState of ['generated', 'edited', 'posted'] as const) {
  test(`refresh protects only unfinished review bodies: ${bodyState}`, async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl)
    let release!: () => void
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    await page.route('**/api/prs/42/patches', async route => {
      const response = await route.fetch()
      await waiting
      await route.fulfill({ response })
    })
    const request = page.waitForRequest('**/api/prs/42/patches')
    await page.locator('#refresh').click()
    await request
    await page.locator('#comment-review').click()
    const dialog = page.locator('#signoff-dialog')
    const post = dialog.locator('[data-act="signoff-post"]')
    await expect(post).toBeEnabled()
    if (bodyState !== 'generated') {
      await page.locator('#signoff-body').fill('My review comment')
    }
    if (bodyState === 'posted') {
      await post.click()
      await expect(dialog.locator('.signoff-result')).toContainText('Posted')
    }
    let confirmations = 0
    page.on('dialog', async prompt => {
      confirmations++
      await prompt.dismiss()
    })
    release()
    await expect(page.locator('#refresh')).toBeEnabled()
    expect(confirmations).toBe(bodyState === 'edited' ? 1 : 0)
    if (bodyState === 'edited') {
      await expect(page.locator('#signoff-body')).toHaveValue('My review comment')
      await dialog.locator('[data-act="signoff-close"]').click()
      await page.locator('#refresh').click()
      await expect(page.locator('#refresh')).toBeEnabled()
      expect(confirmations).toBe(1)
    }
    await expect(dialog).toHaveCount(0)
  })
}

test('refresh stops regeneration polling before waiting for patches', async ({ page, chatServer }) => {
  // Without acpx the page gives the skill command and polls for the canvas it publishes.
  const server = await chatServer({ runner: { acpxVersion: null } })
  await page.clock.install()
  await page.goto(server.url)
  await page.locator('#regenerate').click()
  await page.locator('#regenerate-dialog button[value="close"]').click()
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  await page.route('**/api/prs/42/patches', async route => {
    const response = await route.fetch()
    await waiting
    await route.fulfill({ response })
  })
  let polls = 0
  page.on('request', request => {
    if (request.url().endsWith('?poll=1')) polls++
  })
  const request = page.waitForRequest('**/api/prs/42/patches')
  await page.locator('#refresh').click()
  await request
  const newer = syntheticArtifact()
  newer.generatedAt = '2026-09-27T15:00:00.000Z'
  newer.summary = 'Newly regenerated canvas'
  server.ctx.fixtureArtifact = newer
  await page.clock.runFor(5001)
  release()
  await expect(page.locator('#refresh')).toBeEnabled()
  expect(polls).toBe(0)
  await page.locator('#refresh').click()
  await expect(page.locator('#overview .summary')).toHaveText(newer.summary)
})
