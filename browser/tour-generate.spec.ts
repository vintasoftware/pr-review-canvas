import { rm } from 'node:fs/promises'
import { HEAD_SHA } from '../src/testing/synthetic.js'
import { syntheticTour, writeTourFiles } from '../src/testing/synthetic-tour.js'
import { zipStoredTour } from '../src/tour/share.js'
import { expect, test } from './fixtures.js'

test('generates the first tour from the empty tour page and walks into it', async ({ page, chatServer }) => {
  let tourDir = ''
  let scenesDir = ''
  const server = await chatServer({
    runner: {
      delayMs: 150,
      script: [
        { type: 'tool', id: 't1', title: 'Write tour-model.json', status: 'completed' },
        { type: 'chunk', text: 'done' },
        { type: 'done', stopReason: 'end_turn' },
      ],
      // The fake agent writes the tour as the skill does, before its turn ends.
      beforeEvent: event => {
        if (event.type === 'done') void writeTourFiles(tourDir, scenesDir)
      },
    },
  })
  tourDir = server.ctx.tours.tourDir(HEAD_SHA)
  scenesDir = server.ctx.tours.scenesDir(HEAD_SHA)
  await page.goto(server.url.replace(/review\/42$/, 'tour/42'))
  await expect(page.locator('#missing-h')).toHaveText('No tour yet for this pull request')
  await expect(page.locator('#regenerate')).toHaveText('generate')
  await page.locator('#generate-start').click()

  const dialog = page.locator('#generate-dialog')
  await expect(dialog.locator('h2')).toHaveText('Generate the tour')
  await expect(dialog).toContainText('with every permission approved')
  await expect(dialog.locator('.gen-skill')).toContainText('default skill of pr-review 0.0.0-test')
  await dialog.locator('[data-gen="start"]').click()

  await expect(page.locator('#regenerate')).toContainText('generating')
  await expect(dialog.locator('.gen-activity li')).toHaveText('Write tour-model.json')
  await expect(dialog.locator('h2')).toHaveText('Done', { timeout: 15_000 })
  await dialog.locator('button[value="close"]').click()
  // The published tour replaced the empty screen, and the header command regenerates it.
  await expect(page.locator('#regenerate')).toHaveText('regenerate')
  await expect(page.locator('.tour-cover-actions [data-nav="next"]')).toBeVisible()
})

test('exports the tour as a zip, and imports it on a page with none', async ({ page, chatServer }) => {
  const server = await chatServer()
  const tourUrl = server.url.replace(/review\/42$/, 'tour/42')
  await page.goto(tourUrl)
  await expect(page.locator('#missing-h')).toBeVisible()
  // No tour yet, so nothing to export; the empty page takes one a teammate shared.
  await expect(page.locator('#export-zip')).toHaveCount(0)
  await server.ctx.tours.write(HEAD_SHA, syntheticTour())
  const { zip } = await zipStoredTour(server.ctx, HEAD_SHA, 42)
  await rm(server.ctx.tours.tourDir(HEAD_SHA), { recursive: true })
  await page
    .locator('#zip')
    .setInputFiles({ name: zip.name, mimeType: 'application/zip', buffer: Buffer.from(zip.bytes) })
  await expect(page.locator('.tour-cover-actions [data-nav="next"]')).toBeVisible()

  const download = page.waitForEvent('download')
  await page.locator('#export-zip').click()
  expect((await download).suggestedFilename()).toBe(zip.name)
})
