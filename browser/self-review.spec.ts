import { TEXT_CAPS } from '../src/contract/review-artifact.js'
import { toPatchMap } from '../src/git/diff-collector.js'
import { artifactToModelOutput, normalize } from '../src/review/normalize.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

test('the author settles a reviewer point with a reason, reads it after a reload, and reopens it', async ({
  page,
  selfReviewUrl,
}) => {
  await page.goto(selfReviewUrl)
  await expect(page.locator('.self-review-note')).toContainText('2 points are marked yours')
  const railCount = page.locator('nav.rail a[href="#overview"] .m')
  await expect(railCount).toHaveText('3 attention points')
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await expect(card.locator('.pill.audience')).toHaveText('reviewer')
  await card.locator('[data-act="point-settle"]').click()
  const box = card.locator('.settle-box')
  await expect(box.locator('textarea')).toBeFocused()
  await box.locator('textarea').fill('The spec says sum; see the linked issue.')
  await box.locator('[data-act="settle-save"]').click()
  await expect(card).toBeHidden()
  await expect(page.locator('.toast')).toContainText('canvas comment is updated')
  await expect(railCount).toHaveText('2 attention points')
  await expect(page.locator('.conversation')).toContainText('For the reviewer: no open attention points')

  await page.reload()
  await expect(page.locator('.conversation')).toContainText('For the reviewer: no open attention points')
  await expect(page.locator('.conversation')).toContainText('Resolved by the author: 1')
  const settled = page.locator('.settled-list')
  await expect(settled.locator('.dismissed-line')).toContainText('1 resolved by the author')
  await expect(card).toBeHidden()
  await settled.locator('[data-act="show-settled"]').click()
  await expect(settled.locator('.settled-reason')).toContainText('The spec says sum')
  await expect(settled.locator('a[href$="#discussion_r5001"]')).toHaveCount(1)
  await settled.locator('[data-act="point-unsettle"]').click()
  await expect(card).toBeVisible()
  await expect(railCount).toHaveText('3 attention points')
  await expect(card.locator('[data-act="point-settle"]')).toBeVisible()
  await expect(settled).toBeHidden()
  await expect(page.locator('.conversation')).toContainText('For the reviewer: 1 attention point to judge')
  await page.reload()
  await expect(page.locator('.conversation')).toContainText('For the reviewer: 1 attention point to judge')
})

test('completed self-review leaves only the done sentence and reviewer count', async ({
  page,
  selfReviewUrl,
}) => {
  await page.goto(selfReviewUrl)
  await page.evaluate(async () => {
    const bundle = await (await fetch('../api/prs/42')).json()
    for (const point of bundle.artifact.points) {
      if (point.audience !== 'author') continue
      const answer = await fetch(`../api/prs/42/points/${point.fingerprint}/settled`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settled: true, reason: 'Verified locally.', comment: false }),
      })
      if (!answer.ok) throw new Error('resolution failed')
    }
  })
  await page.reload()
  await expect(page.locator('.self-review-note')).toHaveText(
    'Self-review done: nothing marked yours is open. 1 point goes to the reviewer.'
  )
})

test('generated missing-test points use reviewer routing, changed code, and a word-boundary title', async ({
  page,
  chatServer,
}) => {
  const source = syntheticArtifact()
  const model = artifactToModelOutput(source)
  model.points = []
  model.layers[0]!.tests = [{ status: 'missing', behavior: 'A missing behavior '.repeat(6).trim() }]
  const artifact = normalize(model, {
    pr: source.pr,
    files: source.files,
    patches: toPatchMap(SYNTHETIC_FILES),
    caps: TEXT_CAPS,
    highRisk: [],
    generatedAt: source.generatedAt,
    generator: source.generator,
  })
  const point = artifact.points[0]!
  const server = await chatServer({
    setup: async t => {
      t.ctx.fixtureArtifact = artifact
    },
  })
  await page.goto(server.url)
  const card = page.locator(`section.layer li.finding[data-fingerprint="${point.fingerprint}"]`)
  await expect(card.locator('.pill.audience')).toHaveText('reviewer')
  await expect(card.locator('.f-title > span').first()).toHaveText(point.title)
  await expect(card.locator('[data-act="point-settle"]')).toHaveCount(0)
  expect(point.title).toMatch(/(?:A|missing|behavior)…$/)
  expect(point.title.length).toBeLessThanOrEqual(90)
  expect(point).toMatchObject({ path: 'src/app.ts', line: 2, side: 'new' })
  await page.reload()
  await expect(card.locator('.pill.audience')).toHaveText('reviewer')
})
