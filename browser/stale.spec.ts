import { ghJson, moveFakeHead, type FakeGit } from '../src/testing/fakes.js'
import {
  GH_PULL,
  ghFor42,
  HEAD_SHA,
  SYNTHETIC_DIFF_MOVED_BY_BASE,
  syntheticArtifact,
} from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

test('notes a canvas carried over to a head with the identical diff, without disabling posting', async ({
  page,
  reviewUrl,
}) => {
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.carriedOver = { canvasHeadSha: 'c'.repeat(40), currentHeadSha: bundle.pr.headSha }
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  const note = page.locator('#main > .stale-bar.carried-over-bar')
  await expect(note).toBeVisible()
  await expect(note).toContainText('Canvas still applies.')
  await expect(note).toContainText('generated for ccccccc')
  await expect(note).toContainText('has the identical diff')
  await expect(note).toHaveCSS('position', 'static')
  await expect(page.locator('section.layer').first()).toBeVisible()
  await expect(page.locator('#es-h')).toHaveCount(0)
})

test('warns above an outdated canvas and clears the warning after refresh', async ({ page, chatServer }) => {
  // Without acpx, generating means running the skill command the dialog gives.
  const reviewUrl = (await chatServer({ runner: { acpxVersion: null } })).url
  let outdated = true
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    if (outdated) {
      bundle.status = 'stale'
      bundle.skillCommand = '/pr-review-canvas 42'
      bundle.stale = {
        canvasHeadSha: bundle.pr.headSha,
        currentHeadSha: 'b'.repeat(40),
        relation: 'ancestor',
        commitsBehind: 1,
      }
    }
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  await expect(page.locator('#es-h')).toHaveText('Canvas is outdated')
  await expect(page.locator('.cmdbox code')).toHaveText('/pr-review-canvas 42')
  await page.locator('#view-stale').click()
  const warning = page.locator('#main > .outdated-bar')
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('Canvas is outdated.')
  await expect(warning).toContainText('1 commit behind')
  await expect(page.locator('#main > :first-child')).toHaveClass('stale-bar outdated-bar')
  await expect(warning).toHaveCSS('position', 'sticky')
  await warning.locator('#stale-generate').click()
  await expect(page.locator('#regenerate-dialog code')).toHaveText('/pr-review-canvas 42')
  await page.locator('#regenerate-dialog button[value="close"]').click()
  await page.locator('#regenerate').click()
  await expect(page.locator('#regenerate-dialog code')).toHaveText('/pr-review-canvas 42')
  await page.locator('#regenerate-dialog button[value="close"]').click()
  outdated = false
  await page.locator('#refresh').click()
  await expect(page.locator('section.layer').first()).toBeVisible()
  await expect(warning).toHaveCount(0)
  await expect(page.locator('html')).toHaveCSS('scroll-padding-top', 'auto')
})

test('a rail link stops the layer under the outdated bar, which hides what scrolls under it', async ({
  page,
  reviewUrl,
}) => {
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.status = 'stale'
    bundle.stale = {
      canvasHeadSha: bundle.pr.headSha,
      currentHeadSha: 'b'.repeat(40),
      relation: 'ancestor',
      commitsBehind: 1,
    }
    await route.fulfill({ response, json: bundle })
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(reviewUrl)
  await page.locator('#view-stale').click()
  const warning = page.locator('#main > .outdated-bar')
  await expect(warning).toBeVisible()
  await page.locator('nav.rail a[href="#layer-run-path"]').click()
  const title = page.locator('#layer-run-path > .layer-h')
  await expect
    .poll(async () => {
      const bar = await warning.boundingBox()
      const head = await title.boundingBox()
      return bar === null || head === null ? -1 : Math.round(head.y - (bar.y + bar.height))
    })
    .toBeGreaterThanOrEqual(0)
  // The dark tint is see-through on its own, so the bar paints the page color under it.
  await expect(warning).toHaveCSS('background-image', /linear-gradient/)
  await expect(warning).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('spans the reading column like the overview on a wide screen', async ({ page, reviewUrl }) => {
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.carriedOver = { canvasHeadSha: 'c'.repeat(40), currentHeadSha: bundle.pr.headSha }
    await route.fulfill({ response, json: bundle })
  })
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto(reviewUrl)
  const note = await page.locator('#main > .stale-bar').boundingBox()
  const overview = await page.locator('#overview').boundingBox()
  if (!note || !overview) throw new Error('missing bar or overview')
  expect(overview.width).toBeGreaterThan(1100)
  expect(Math.abs(note.x - overview.x)).toBeLessThan(1)
  expect(Math.abs(note.width - overview.width)).toBeLessThan(1)
})

test('dismisses the outdated bar for its pair of commits, and shows it again for a newer head', async ({
  page,
  reviewUrl,
}) => {
  let head = 'b'.repeat(40)
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.status = 'stale'
    bundle.stale = {
      canvasHeadSha: bundle.pr.headSha,
      currentHeadSha: head,
      relation: 'ancestor',
      commitsBehind: 1,
    }
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  await page.locator('#view-stale').click()
  const warning = page.locator('#main > .outdated-bar')
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: 'dismiss' }).click()
  await expect(warning).toHaveCount(0)
  // Nothing sticks to the top any more, so a jump stops at the top of the screen again.
  await expect(page.locator('html')).toHaveCSS('scroll-padding-top', /^(0px|auto)$/)
  await page.locator('nav.rail a[href="#layer-run-path"]').click()
  await expect
    .poll(async () => Math.round((await page.locator('#layer-run-path > .layer-h').boundingBox())?.y ?? -1))
    .toBeLessThan(8)

  await page.reload()
  await page.locator('#view-stale').click()
  await expect(page.locator('section.layer').first()).toBeVisible()
  await expect(warning).toHaveCount(0)
  // The regenerate command stays in the header.
  await expect(page.locator('#regenerate')).toBeEnabled()

  head = 'd'.repeat(40)
  await page.reload()
  await page.locator('#view-stale').click()
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('ddddddd')
})

test('dismisses each carried-over note on its own, and keeps it dismissed after a reload', async ({
  page,
  reviewUrl,
}) => {
  await page.route(/\/api\/prs\/42(?:\?.*)?$/, async route => {
    const response = await route.fetch()
    const bundle = await response.json()
    bundle.carriedOver = { canvasHeadSha: 'c'.repeat(40), currentHeadSha: bundle.pr.headSha }
    bundle.marksCarriedFrom = 'c'.repeat(40)
    await route.fulfill({ response, json: bundle })
  })
  await page.goto(reviewUrl)
  const applies = page.locator('#main > .carried-over-bar', { hasText: 'Canvas still applies.' })
  const marks = page.locator('#main > .carried-over-bar', { hasText: 'Review progress carried over.' })
  await expect(applies).toBeVisible()
  await expect(marks).toBeVisible()
  await applies.getByRole('button', { name: 'dismiss' }).click()
  await expect(applies).toHaveCount(0)
  await expect(marks).toBeVisible()

  await page.reload()
  await expect(page.locator('section.layer').first()).toBeVisible()
  await expect(applies).toHaveCount(0)
  await expect(marks).toBeVisible()
  await marks.getByRole('button', { name: 'dismiss' }).click()
  await expect(marks).toHaveCount(0)
  await expect(page.locator('#main > :first-child')).toHaveAttribute('id', 'overview')
})

test('reads the canvas as outdated after the pull request moved to another base under the same head', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const { url, ctx } = await chatServer({
    setup: async t => {
      t.ctx.fixtureArtifact = null
      const artifact = syntheticArtifact()
      await t.ctx.canvases.write(
        artifact.pr.headSha,
        artifact,
        {
          formatVersion: 1,
          tool: { name: 'pr-review', version: '0.8.0' },
          repo: artifact.pr.repo,
          prNumber: 42,
          headSha: artifact.pr.headSha,
          mergeBaseSha: artifact.pr.mergeBaseSha,
          baseRef: 'main',
          headRef: 'feat/b',
          generatedAt: artifact.generatedAt,
          generator: artifact.generator,
        },
        42
      )
    },
  })
  await page.goto(url)
  await expect(page.locator('section.layer').first()).toBeVisible()
  const release = '9'.repeat(40)
  const git = ctx.git as FakeGit
  git.options.refs = { ...git.options.refs, 'refs/heads/release': release }
  moveFakeHead(git, {
    headRef: 'pull/42/head',
    baseRef: 'refs/pr/42/base',
    headSha: HEAD_SHA,
    mergeBaseSha: release,
    diff: SYNTHETIC_DIFF_MOVED_BY_BASE,
  })
  ctx.gh = ghFor42({
    routes: { 'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, base: { ref: 'release' } }) },
  })
  await page.reload()
  await expect(page.locator('#es-h')).toHaveText('Canvas is outdated')
  await expect(page.locator('#empty-state .hint').first()).toContainText('the pull request changed its base')
  await page.locator('#view-stale').click()
  await expect(page.locator('#main > .outdated-bar')).toContainText('You are reading an older diff.')
  // Refresh reads the new base again and keeps the canvas marked outdated.
  const refreshed = page.waitForResponse(/\/api\/prs\/42\?refresh=1/)
  await page.locator('#refresh').click()
  expect((await (await refreshed).json()).status).toBe('stale')
  await expect(page.locator('#main > .outdated-bar')).toContainText('You are reading an older diff.')
})
