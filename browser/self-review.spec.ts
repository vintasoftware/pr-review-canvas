import { TEXT_CAPS } from '../src/contract/review-artifact.js'
import { toPatchMap } from '../src/git/diff-collector.js'
import { artifactToModelOutput, normalize } from '../src/review/normalize.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../src/testing/synthetic.js'
import { SETTLED_POLL_MS } from '../static/js/api.js'
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
  // The point the author just resolved stays in place, collapsed to its title and the reason.
  await expect(card).toHaveAttribute('data-status', 'resolved')
  await expect(card).toBeVisible()
  await expect(card.locator('.p-summary')).toHaveText(
    'Resolved by the author: The spec says sum; see the linked issue.'
  )
  await expect(page.locator('.toast')).toContainText('canvas comment is updated')
  await expect(railCount).toHaveText('2 attention points')
  await expect(page.locator('.conversation')).toContainText('For the reviewer: no open attention points')

  await page.reload()
  await expect(page.locator('.conversation')).toContainText('For the reviewer: no open attention points')
  await expect(page.locator('.conversation')).toContainText('Resolved by the author: 1')
  await expect(page.locator('.point-statuses')).toContainText('1 resolved by the author')
  await expect(card).toHaveAttribute('data-status', 'resolved')
  // Every reader loads a resolved point off the page, until they show the resolved ones.
  await expect(card).toBeHidden()
  const showResolved = page.locator('[data-act="toggle-resolved"]')
  await expect(showResolved).toHaveText('show the 1 resolved')
  await showResolved.click()
  await expect(card).toBeVisible()
  await card.locator('[data-act="point-expand"]').click()
  await expect(card.locator('.settled-reason')).toContainText('The spec says sum')
  await expect(card.locator('a[href$="#discussion_r5001"]')).toHaveCount(1)
  await card.locator('[data-act="point-unsettle"]').click()
  await expect(card).toHaveAttribute('data-status', 'open')
  await expect(railCount).toHaveText('3 attention points')
  await expect(card.locator('[data-act="point-settle"]')).toBeVisible()
  await expect(page.locator('.point-statuses')).not.toContainText('resolved')
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

test('a reviewer loads the author’s resolved points off the page, and the layer they emptied without its heading', async ({
  page,
  chatServer,
}) => {
  const artifact = {
    ...syntheticArtifact(),
    settled: { 'fp-1': { reason: 'The spec says sum.', at: '2026-09-10T12:00:00.000Z' } },
  }
  const server = await chatServer({
    setup: async t => {
      t.ctx.fixtureArtifact = artifact
    },
  })
  await page.goto(server.url)
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  const heading = page
    .locator('section.layer')
    .filter({ has: page.locator('li.finding[data-fingerprint="fp-1"]') })
    .locator('.lbl.sub', { hasText: 'Attention points' })
  await expect(page.locator('.point-statuses')).toContainText('2 open · 1 resolved by the author')
  await expect(card).toBeHidden()
  await expect(heading).toBeHidden()
  await page.locator('[data-act="toggle-resolved"]').click()
  await expect(card).toBeVisible()
  await expect(heading).toBeVisible()
  await expect(card.locator('.p-summary')).toHaveText('Resolved by the author: The spec says sum.')
  await expect(card.locator('[data-act="point-unsettle"]')).toHaveCount(0)
})

test('a reviewer whose queued point the author resolves keeps the draft, and is told so where it shows', async ({
  page,
  chatServer,
}, testInfo) => {
  // Narrower screens float the pane, minimized, over the canvas; the wide one docks its tabs.
  test.skip(testInfo.project.name !== 'desktop')
  const artifact = syntheticArtifact()
  const server = await chatServer({
    setup: async t => {
      t.ctx.fixtureArtifact = artifact
    },
  })
  await page.clock.install()
  await page.goto(server.url)
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await card.locator('[data-act="point-queue"]').click()
  await expect(card).toHaveAttribute('data-status', 'queued')
  // The author resolves the point; the reviewer's page reads it on its next poll.
  server.ctx.fixtureArtifact = {
    ...artifact,
    settled: { 'fp-1': { reason: 'The spec says sum.', at: '2026-09-10T12:00:00.000Z' } },
  }
  await page.clock.runFor(SETTLED_POLL_MS)
  await expect(page.locator('.toast')).toContainText(
    'the author resolved a point; your review keeps your draft on it'
  )
  await expect(card).toBeHidden()
  await expect(page.locator('.point-statuses')).toContainText(
    '1 resolved by the author (1 with your draft in the review)'
  )
  const note = 'The author resolved this point. Your draft stays in your review until you send or delete it.'
  await expect(page.locator('tr.pending-row .pending-resolved')).toHaveText(note)
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
  await page
    .locator('aside.chat')
    .getByRole('tab', { name: /Your review/ })
    .click()
  await expect(page.locator('#review-panel .pending-resolved')).toHaveText(note)
  await page.locator('[data-act="toggle-resolved"]').click()
  await expect(card.locator('.p-summary')).toHaveText(
    'Resolved by the author: The spec says sum. · your draft still waits in your review'
  )
})

test('the author reopens a settled decision, which then gives the commit’s answer as context', async ({
  page,
  chatServer,
}) => {
  const base = syntheticArtifact()
  const commit = 'c'.repeat(40)
  const decision = {
    ...base.points[0]!,
    id: 'p-4',
    fingerprint: 'fp-4',
    kind: 'decision' as const,
    level: 'fyi' as const,
    title: 'Should run() multiply?',
    body: 'Commit `ccccccc` answered this on 2026-10-13: No: the spec says sum.',
    audience: 'author' as const,
    decisionCommit: commit,
  }
  const { impact: _impact, ...point } = decision
  const artifact = {
    ...base,
    points: [...base.points, point],
    settled: { 'fp-4': { reason: 'No: the spec says sum.', at: '2026-10-13T10:00:00.000Z', commit } },
  }
  const server = await chatServer({
    setup: async t => {
      t.ctx.fixtureArtifact = null
      await t.ctx.canvases.write(artifact.pr.headSha, artifact, {
        formatVersion: 1,
        tool: { name: 'pr-review', version: '0.0.0-test' },
        repo: artifact.pr.repo,
        prNumber: 42,
        headSha: artifact.pr.headSha,
        mergeBaseSha: artifact.pr.mergeBaseSha,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: artifact.generatedAt,
        generator: artifact.generator,
      })
    },
  })
  await page.goto(server.url)
  await page.locator('[data-act="toggle-resolved"]').click()
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-4"]')
  await card.locator('[data-act="point-expand"]').click()
  await card.locator('[data-act="point-unsettle"]').click()
  await expect(card).toHaveAttribute('data-status', 'open')
  await expect(card.locator('.p-summary')).toHaveText(
    'The author reopened this on the canvas; the commit’s answer below no longer settles it.'
  )
  await expect(card.locator('.prose').first()).toHaveText(
    'Commit ccccccc answered this on 2026-10-13: No: the spec says sum.'
  )
  const stored = await server.ctx.canvases.readArtifact(artifact.pr.headSha)
  expect(stored?.reopened).toEqual({ 'fp-4': { commit, at: expect.any(String) } })
  await page.reload()
  await expect(card).toHaveAttribute('data-status', 'open')
})
