import { buildCanvasZip } from '../src/canvas/zip.js'
import { artifactToModelOutput } from '../src/review/normalize.js'
import { TEST_REPO } from '../src/testing/fakes.js'
import { BASE_SHA, HEAD_SHA, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

const MODEL = JSON.stringify(artifactToModelOutput(syntheticArtifact()))

test('generates the first canvas from the empty screen and loads it', async ({ page, chatServer }) => {
  const server = await chatServer({
    noCanvas: true,
    runner: {
      delayMs: 150,
      script: [
        { type: 'tool', id: 't1', title: 'Read src/b.ts', status: 'completed' },
        { type: 'chunk', text: MODEL },
        { type: 'done', stopReason: 'end_turn' },
      ],
    },
  })
  await page.goto(server.url)
  await expect(page.locator('#es-h')).toHaveText('No review canvas for this PR yet')
  await expect(page.locator('#regenerate')).toHaveText('generate')
  await page.locator('#generate-start').click()

  const dialog = page.locator('#generate-dialog')
  await expect(dialog.locator('h2')).toHaveText('Generate the canvas')
  await expect(dialog).toContainText('shares the canvas as a comment on the pull request')
  await expect(dialog.locator('[data-copy]')).toHaveAttribute('data-copy', '/pr-review-canvas 42')
  // The test server's checkout has no skill installed, so the run follows the one the server ships.
  await expect(dialog.locator('.gen-skill')).toContainText('default skill of pr-review 0.0.0-test')
  await dialog.locator('[data-gen="start"]').click()

  await expect(page.locator('#regenerate')).toContainText('generating')
  await expect(dialog.locator('.gen-activity li')).toHaveText('Read src/b.ts')
  // The fake forge refuses the comment, so the dialog stays over the new canvas with the zip to upload.
  await expect(dialog).toContainText('Automatic canvas sharing failed', { timeout: 15_000 })
  await expect(dialog).toContainText('The ZIP: ')
  await expect(dialog.locator('h2')).toHaveText('Done')
  await dialog.locator('button[value="close"]').click()
  // The new canvas is current, so the header command regenerates it.
  await expect(page.locator('#regenerate')).toHaveText('regenerate')
  await expect(page.locator('section.layer').first()).toBeVisible()
})

test('shows a running generation on the header command and stops it', async ({ page, chatServer }) => {
  const server = await chatServer({
    noCanvas: true,
    runner: {
      // The fake agent ends a stopped turn at its next event, so the delay bounds how long a stop takes.
      delayMs: 4000,
      script: [
        { type: 'chunk', text: MODEL },
        { type: 'done', stopReason: 'end_turn' },
      ],
    },
  })
  await page.goto(server.url)
  await page.locator('#generate-start').click()
  const dialog = page.locator('#generate-dialog')
  await dialog.locator('[data-gen="start"]').click()
  await expect(dialog.locator('h2')).toHaveText('The agent is writing the canvas')
  // Before the agent says anything, the dialog says it waits for it, and how long it has.
  await expect(dialog.locator('.gen-pulse')).toContainText('Waiting for the agent to start · last activity')
  // The running job names the skill it was given.
  await expect(dialog.locator('.gen-skill')).toContainText('default skill')
  await dialog.locator('button[value="close"]').click()
  await expect(dialog).not.toBeVisible()

  // A reload finds the job the server still runs.
  await page.reload()
  await expect(page.locator('#regenerate')).toContainText('generating')
  await page.locator('#regenerate').click()
  await expect(dialog.locator('h2')).toHaveText('The agent is writing the canvas')
  await dialog.locator('[data-gen="stop"]').click()
  await expect(dialog.locator('h2')).toHaveText('Stopping…')
  await expect(dialog.locator('h2')).toHaveText('Generation stopped', { timeout: 10_000 })
  await expect(page.locator('#regenerate')).toHaveText('generate')
  await expect(dialog.locator('[data-gen="again"]')).toBeVisible()
  await dialog.locator('[data-gen="again"]').click()
  await expect(dialog.locator('h2')).toHaveText('Generate the canvas')
})

/** A canvas zip of PR 42 at its head, as a teammate would attach it. */
function canvasZip(): { name: string; mimeType: string; buffer: Buffer } {
  const artifact = syntheticArtifact()
  const bytes = buildCanvasZip(
    {
      formatVersion: 1,
      tool: { name: 'pr-review', version: '0.1.0' },
      repo: TEST_REPO,
      prNumber: 42,
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt: artifact.generatedAt,
      generator: artifact.generator,
    },
    artifact
  )
  return {
    name: `pr-42-20260910T110000Z-${HEAD_SHA.slice(0, 8)}-acme-widgets-canvas.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  }
}

test('imports a canvas zip on the empty screen that offers generation', async ({ page, chatServer }) => {
  const server = await chatServer({ noCanvas: true })
  await page.goto(server.url)
  await expect(page.locator('#generate-start')).toBeVisible()
  await expect(page.locator('#regenerate')).toHaveText('generate')
  await page.locator('#zip').setInputFiles(canvasZip())
  await expect(page.locator('section.layer').first()).toBeVisible()
  // The imported canvas is current, so the header command now regenerates it.
  await expect(page.locator('#regenerate')).toHaveText('regenerate')
})

test('imports a canvas zip while a generation runs, and keeps showing the run', async ({
  page,
  chatServer,
}) => {
  const server = await chatServer({
    noCanvas: true,
    runner: {
      delayMs: 4000,
      script: [
        { type: 'chunk', text: MODEL },
        { type: 'done', stopReason: 'end_turn' },
      ],
    },
  })
  await page.goto(server.url)
  await page.locator('#generate-start').click()
  const dialog = page.locator('#generate-dialog')
  await dialog.locator('[data-gen="start"]').click()
  await expect(dialog.locator('h2')).toHaveText('The agent is writing the canvas')
  await dialog.locator('button[value="close"]').click()

  await page.locator('#zip').setInputFiles(canvasZip())
  await expect(page.locator('section.layer').first()).toBeVisible()
  // The page drew a new header; the run is still on it, and its dialog still opens from there.
  await expect(page.locator('#regenerate')).toContainText('generating')
  await page.locator('#regenerate').click()
  await dialog.locator('[data-gen="stop"]').click()
  await expect(dialog.locator('h2')).toHaveText('Generation stopped', { timeout: 10_000 })
  await expect(page.locator('#regenerate')).toHaveText('regenerate')
})

test('opens the generation dialog from the home page form', async ({ page, chatServer }) => {
  const server = await chatServer({ noCanvas: true })
  await page.goto(new URL('../', server.url).href)
  await page.locator('input[name="n"]').fill('42')
  await page.locator('button[name="generate"]').click()
  await expect(page.locator('#generate-dialog h2')).toHaveText('Generate the canvas')
  expect(new URL(page.url()).search).toBe('')
})
