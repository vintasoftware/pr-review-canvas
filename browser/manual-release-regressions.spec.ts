import { syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

test('the chat shortcut focuses its input without inserting a slash', async ({ page, chatServer }) => {
  const { url } = await chatServer()
  await page.goto(url)
  await expect(page.locator('#layer-run-path')).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.locator('#msg')).toBeFocused()
  await expect(page.locator('#msg')).toHaveValue('')
  await page.locator('#msg').fill('Keep this draft intact.')
  await page.locator('#chat-minimize').click()
  await page.keyboard.press('/')
  await expect(page.locator('#msg')).toBeFocused()
  await expect(page.locator('#msg')).toHaveValue('Keep this draft intact.')
})

test('saving reading preferences keeps the displayed stop and its URL together across reload', async ({
  page,
  chatServer,
}) => {
  const { url } = await chatServer({
    setup: async ({ ctx }) => {
      const artifact = syntheticArtifact()
      artifact.layers[1]!.kind = 'layer'
      ctx.fixtureArtifact = artifact
    },
  })
  await page.goto(url + '#layer-other')
  await expect(page.locator('#layer-other')).toBeVisible()
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption('one')
  await page.locator('#set-read-by-points').check()
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  const stop = page.locator('[data-lens]')
  await expect(stop).toHaveCount(1)
  const id = await stop.getAttribute('id')
  await expect(page).toHaveURL(new RegExp(`#${id}$`))
  await page.reload()
  await expect(page.locator(`#${id}`)).toHaveAttribute('data-lens', 'layer')
})

test('a review posted with a receipt warning cannot be submitted again from the same dialog', async ({
  page,
  chatServer,
}) => {
  const { url } = await chatServer({
    setup: async ({ ctx }) => {
      const api = ctx.gh.api.bind(ctx.gh)
      ctx.gh.api = (path, params) => {
        if (path.endsWith('/reviews/7001/comments')) throw new Error('Receipt unavailable')
        return api(path, params)
      }
    },
  })
  let submissions = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/review')) submissions++
  })
  await page.goto(url)
  await page.locator('#point-p-1 [data-act="point-queue"]').click()
  await page.locator('.pending-bar [data-act="pending-finish"]').click()
  const post = page.locator('#signoff-dialog [data-act="signoff-post"]')
  await post.click()
  await expect(page.locator('.signoff-result')).toContainText('review posted with 1 comment')
  await expect(page.locator('.signoff-result')).toContainText('Receipt unavailable')
  await expect(post).toBeDisabled()
  await expect(post).toHaveText('posted')
  await post.dispatchEvent('click')
  expect(submissions).toBe(1)
  await page.locator('[data-act="signoff-close"]').click()
  await page.locator('#comment-review').click()
  await expect(post).toBeEnabled()
})

test('resizing chat from a floating pane through desktop to phone keeps sign-off in front', async ({
  page,
  chatServer,
}) => {
  const { url } = await chatServer()
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(url)
  await page.locator('#chat-launcher').click()
  await page.locator('#msg').fill('Keep this chat draft while I write the review.')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('#comment-review').click()
  const dialog = page.locator('#signoff-dialog')
  await expect(dialog.locator('textarea')).toBeEnabled()
  await dialog.locator('textarea').fill('Review body survives resizing.')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('#chat-dialog')).not.toHaveAttribute('open')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('textarea')).toHaveValue('Review body survives resizing.')
  await dialog.locator('[data-act="signoff-post"]').click({ trial: true })
  await dialog.locator('[data-act="signoff-close"]').click()
  await page.locator('#chat-launcher').click()
  await expect(page.locator('#msg')).toHaveValue('Keep this chat draft while I write the review.')
})
