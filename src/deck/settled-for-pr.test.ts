// @vitest-environment node
// What a pull request's self-review decks hand to it: the decisions its canvas does not ask again,
// and the justifications posted as the author's own review when the canvas is published.
import { readFile } from 'node:fs/promises'
import type { DecisionCard, Deck, Pick } from '../contract/deck.js'
import { GenerationContextSchema } from '../contract/generation-context.js'
import type { ReviewKey } from '../contract/review-key.js'
import { artifactToModelOutput } from '../review/normalize.js'
import { prepare } from '../review/prepare.js'
import { ModelInvalidError, publish } from '../review/publish.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import {
  BASE_SHA,
  GH_PULL,
  ghFor42,
  gitFor42,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF_MOVED_BY_BASE,
  syntheticArtifact,
} from '../testing/synthetic.js'
import {
  createFakeGh,
  ghJson,
  ghPost,
  makeTestContext,
  moveFakeHead,
  type TestContext,
} from '../testing/fakes.js'
import { decisionsForPr } from './settled-for-pr.js'

const OPTS = { agent: 'claude', harness: 'claude-code' as const, allowStale: false }

function card(key: string, over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    key,
    bucket: 'trade-off',
    topic: 'Rare case vs simplify',
    title: `Title ${key}`,
    context: 'c',
    // The synthetic diff's second chunk of src/app.ts, away from the canvas's own decide point.
    path: 'src/app.ts',
    line: 12,
    current: 'a',
    a: { label: 'Keep', consequence: 'c', why: `why ${key} A`, record: 'pr-comment' },
    b: { label: 'Change', consequence: 'c', why: `why ${key} B`, record: 'none' },
    ...over,
  }
}

function pick(choice: Pick['choice'], pickedAt = '2026-09-10T12:00:00.000Z'): Pick {
  return { choice, pickedAt }
}

async function deal(
  t: TestContext,
  review: ReviewKey,
  cards: DecisionCard[],
  picks: Record<string, Pick>,
  over: Partial<Deck> = {}
) {
  await t.ctx.decks.writeDeck(review, {
    version: 1,
    review,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T12:00:00.000Z',
    generator: { agent: 'claude' },
    cards,
    settled: [],
    ...over,
  })
  for (const [key, p] of Object.entries(picks)) await t.ctx.decks.setPick(review, key, p)
}

describe('the decisions a pull request inherits from its decks', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('takes its own deck and the local decks of its branch, and leaves skipped cards open', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await deal(t, 42, [card('own'), card('shared')], { own: pick('a'), shared: pick('b') })
    await deal(t, 'branch', [card('shared'), card('early'), card('left')], {
      shared: pick('a'),
      early: pick('neither'),
      left: pick('skip'),
    })
    // A deck of another branch says nothing about this pull request.
    await deal(t, 'uncommitted', [card('elsewhere')], { elsewhere: pick('a') }, { headRef: 'other' })
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const pr = await t.ctx.prs.readPr(42)
    if (pr === null) throw new Error('prepare wrote no pr.json')
    const decisions = await decisionsForPr(t.ctx, { ...pr, number: 42 })
    expect(decisions.settled.map(c => [c.key, c.pick.choice])).toEqual([
      ['own', 'a'],
      ['shared', 'b'],
      ['early', 'neither'],
    ])
    expect(decisions.open.map(c => c.key)).toEqual(['left'])
  })

  it('tells the canvas generator what is settled and what is left for reviewers', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await deal(t, 42, [card('kept'), card('asked')], { kept: pick('a') })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(prepared.contextPath, 'utf8')))
    expect(context.selfReview).toEqual({
      settled: [
        {
          key: 'kept',
          title: 'Title kept',
          path: 'src/app.ts',
          line: 12,
          side: 'new',
          picked: 'A, Keep',
          why: 'why kept A',
        },
      ],
      open: [{ key: 'asked', title: 'Title asked', path: 'src/app.ts', line: 12, side: 'new' }],
    })
    const prompt = await readFile(prepared.promptPath, 'utf8')
    expect(prompt).toContain('## Decisions from the author’s self-review')
    expect(prompt).toContain('Do not raise them again as `decide` points')
    expect(prompt).toContain('anchored where the contradiction is')
    expect(prompt).toContain('- `kept` **Title kept** at `src/app.ts:12`. Picked A, Keep. Why: why kept A')
    expect(prompt).toContain('The author left these for reviewers.')
    expect(prompt).toContain('- `asked` **Title asked** at `src/app.ts:12`.')
    expect(prompt).toContain('with `"asks": "<key>"`')
    expect(prompt).toContain('with `"reopens": "<key>"`')
  })

  it('leaves the prompt alone when no deck speaks for the pull request', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(prepared.contextPath, 'utf8')))
    expect(context.selfReview).toBeUndefined()
    expect(await readFile(prepared.promptPath, 'utf8')).not.toContain('self-review')
  })

  it('posts the PR-comment justifications once, as one COMMENT review', async () => {
    const posts: Array<Record<string, unknown>> = []
    const gh = ghFor42({
      postRoutes: {
        'repos/acme/widgets/pulls/42/reviews': ghPost(body => {
          posts.push(body as Record<string, unknown>)
          return {
            id: 9001,
            state: 'COMMENTED',
            html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-9001',
          }
        }),
      },
      routes: { 'repos/acme/widgets/pulls/42/reviews/9001/comments': ghJson([]) },
    })
    t = await makeTestContext({ git: gitFor42(), gh })
    await deal(
      t,
      42,
      [
        card('kept'),
        card('changed', { current: 'b' }),
        card('moved', { path: 'src/not-in-diff.ts' }),
        card('quiet', { a: { ...card('quiet').a, record: 'none' } }),
      ],
      { kept: pick('a'), changed: pick('b'), moved: pick('a'), quiet: pick('a') }
    )
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    const result = await publish(t.ctx, prepared.canvasDir, OPTS)
    expect(result.selfReview).toEqual({
      status: 'posted',
      url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-9001',
      comments: 1,
      listed: 1,
    })
    expect(posts).toHaveLength(1)
    const review = posts[0] as {
      event: string
      body: string
      commit_id: string
      comments: Array<Record<string, unknown>>
    }
    expect(review.event).toBe('COMMENT')
    expect(review.commit_id).toBe(HEAD_SHA)
    expect(review.comments).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        line: 12,
        side: 'RIGHT',
        body: expect.stringContaining('**Self-review: Title kept**\n\nPicked A, Keep. why kept A'),
      }),
    ])
    expect(review.body).toContain('- **Title moved** (`src/not-in-diff.ts`): picked A, Keep. why moved A')
    expect(review.body).not.toContain('Title changed')
    expect(review.body).not.toContain('Title quiet')

    // Publishing again posts nothing new; changing a pick posts it again.
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    expect((await publish(t.ctx, prepared.canvasDir, OPTS)).selfReview).toEqual({ status: 'none' })
    await t.ctx.decks.setPick(42, 'kept', pick('a', '2026-09-11T08:00:00.000Z'))
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    expect((await publish(t.ctx, prepared.canvasDir, OPTS)).selfReview).toMatchObject({
      status: 'posted',
      comments: 1,
    })
    expect(posts).toHaveLength(2)

    // The author can keep them off the pull request.
    await t.ctx.decks.setPick(42, 'kept', pick('a', '2026-09-12T08:00:00.000Z'))
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    expect(
      (await publish(t.ctx, prepared.canvasDir, { ...OPTS, selfReviewComments: false })).selfReview
    ).toEqual({
      status: 'skipped',
    })
    expect(posts).toHaveLength(2)
  })

  it('reports a failed post without failing the publish, and retries next time', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await deal(t, 42, [card('kept')], { kept: pick('a') })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    const result = await publish(t.ctx, prepared.canvasDir, OPTS)
    expect(result.status).toBe('published')
    expect(result.selfReview).toMatchObject({ status: 'failed' })
    expect(result.selfReview?.status === 'failed' ? result.selfReview.warning : '').toContain(
      'Publishing again retries them'
    )
    expect((await t.ctx.decks.readPosted(42)).posted).toEqual({})
  })

  it('moves a settled decision to the line its unchanged code sits on after new commits', async () => {
    const git = gitFor42()
    t = await makeTestContext({ git, gh: ghFor42() })
    // The deck was dealt for HEAD_SHA, whose diff this machine has.
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    await deal(t, 42, [card('kept', { line: 3 })], { kept: pick('a') })
    const moved = 'c'.repeat(40)
    moveFakeHead(git, {
      headRef: 'pull/42/head',
      baseRef: 'refs/pr/42/base',
      headSha: moved,
      mergeBaseSha: BASE_SHA,
      diff: SYNTHETIC_DIFF_MOVED_BY_BASE,
    })
    for (const [key, text] of Object.entries(SYNTHETIC_BLOBS)) {
      if (key.startsWith(`${HEAD_SHA}:`)) {
        git.options.blobs = { ...git.options.blobs, [key.replace(HEAD_SHA, moved)]: `\n\n\n${text}` }
      }
    }
    t.ctx.gh = createFakeGh({
      routes: {
        'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, head: { ...GH_PULL.head, sha: moved } }),
      },
    })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(prepared.contextPath, 'utf8')))
    expect(context.selfReview?.settled[0]).toMatchObject({ key: 'kept', line: 6 })
  })

  it('posts a neither pick in the author’s words, and lists one it cannot place on the new head', async () => {
    const posts: Array<{ body: string; comments: Array<{ body: string; line: number }> }> = []
    const gh = ghFor42({
      postRoutes: {
        'repos/acme/widgets/pulls/42/reviews': ghPost(body => {
          posts.push(body as (typeof posts)[number])
          return {
            id: 9002,
            state: 'COMMENTED',
            html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-9002',
          }
        }),
      },
      routes: { 'repos/acme/widgets/pulls/42/reviews/9002/comments': ghJson([]) },
    })
    t = await makeTestContext({ git: gitFor42(), gh })
    await deal(t, 42, [card('own-words')], {
      'own-words': {
        choice: 'neither',
        note: 'Log the row and keep going.',
        record: 'pr-comment',
        pickedAt: 'x',
      },
    })
    // A deck dealt for a head this machine never saw: its line cannot be proven to still hold.
    await deal(t, 'branch', [card('unseen')], { unseen: pick('a') }, { headSha: 'd'.repeat(40) })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    const result = await publish(t.ctx, prepared.canvasDir, OPTS)
    expect(result.selfReview).toMatchObject({ status: 'posted', comments: 1, listed: 1 })
    const review = posts[0]
    expect(review?.comments.map(c => c.body.split('\n')[2])).toEqual([
      'Picked neither side; instead: Log the row and keep going.',
    ])
    expect(review?.body).toContain('- **Title unseen** (`src/app.ts`): picked A, Keep. why unseen A')
    expect(Object.keys((await t.ctx.decks.readPosted(42)).posted).sort()).toEqual(['own-words', 'unseen'])
  })

  it('prefers the newer local deck when two settled the same decision differently', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await deal(t, 'branch', [card('same')], { same: pick('a') }, { generatedAt: '2026-09-01T00:00:00.000Z' })
    await deal(
      t,
      'uncommitted',
      [card('same')],
      { same: pick('b') },
      { generatedAt: '2026-09-05T00:00:00.000Z' }
    )
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const pr = await t.ctx.prs.readPr(42)
    if (pr === null) throw new Error('prepare wrote no pr.json')
    const { settled } = await decisionsForPr(t.ctx, { ...pr, number: 42 })
    expect(settled.map(c => [c.key, c.pick.choice])).toEqual([['same', 'b']])
  })

  it('does not guess a line for a decision whose line is outside the diff of its own head', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await deal(t, 42, [card('far', { line: 40 })], { far: pick('a') })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(prepared.contextPath, 'utf8')))
    expect(context.selfReview?.settled[0]).not.toHaveProperty('line')
    expect(await readFile(prepared.promptPath, 'utf8')).toContain(
      '- `far` **Title far** at `src/app.ts` (its code changed since).'
    )
  })

  it('refuses a canvas that reopens a settled decision without saying so, and keeps a declared reopen', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    // Settled on the chunk where the synthetic canvas has its own decide point (src/app.ts:4).
    await deal(t, 42, [card('sum', { line: 3 })], { sum: pick('a') })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const model = artifactToModelOutput(syntheticArtifact())
    await writeTextAtomic(`${prepared.canvasDir}/model.json`, JSON.stringify(model))
    const refused = await publish(t.ctx, prepared.canvasDir, OPTS).catch(e => e)
    expect(refused).toBeInstanceOf(ModelInvalidError)
    expect((refused as ModelInvalidError).report.errors.map(e => e.code)).toEqual(['SETTLED_REOPENED'])

    const declared = {
      ...model,
      points: model.points.map(p => (p.level === 'decide' && p.line === 4 ? { ...p, reopens: 'sum' } : p)),
    }
    await writeTextAtomic(`${prepared.canvasDir}/model.json`, JSON.stringify(declared))
    const result = await publish(t.ctx, prepared.canvasDir, OPTS)
    const stored = await t.ctx.canvases.readArtifact(result.headSha)
    expect(stored?.points.find(p => p.line === 4)?.reopens).toBe('sum')
  })

  it('tells the generator which picks asked for a change, so unapplied code reads as a pending fix', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await deal(t, 42, [card('kept'), card('change')], { kept: pick('a'), change: pick('b') })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(prepared.contextPath, 'utf8')))
    expect(context.selfReview?.settled.map(d => [d.key, d.fix ?? false])).toEqual([
      ['kept', false],
      ['change', true],
    ])
    const prompt = await readFile(prepared.promptPath, 'utf8')
    expect(prompt).toContain(
      '- `change` **Title change** at `src/app.ts:12`. Picked B, Change. The author asked for this change. Why: why change B'
    )
    expect(prompt).not.toContain('Picked A, Keep. The author asked for this change.')
  })

  it('holds back the reason of a decision the canvas reopens, and posts it once the canvas stops', async () => {
    const posts: Array<{ comments: Array<{ body: string }> }> = []
    const gh = ghFor42({
      postRoutes: {
        'repos/acme/widgets/pulls/42/reviews': ghPost(body => {
          posts.push(body as (typeof posts)[number])
          return {
            id: 9003,
            state: 'COMMENTED',
            html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-9003',
          }
        }),
      },
      routes: { 'repos/acme/widgets/pulls/42/reviews/9003/comments': ghJson([]) },
    })
    t = await makeTestContext({ git: gitFor42(), gh })
    await deal(t, 42, [card('kept'), card('contested')], { kept: pick('a'), contested: pick('a') })
    const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    const model = artifactToModelOutput(syntheticArtifact())
    const reopening = {
      ...model,
      points: [
        ...model.points,
        {
          kind: 'decision',
          level: 'decide',
          title: 'Still skips',
          path: 'src/app.ts',
          line: 12,
          body: 'b',
          reopens: 'contested',
        },
      ],
    }
    await writeTextAtomic(`${prepared.canvasDir}/model.json`, JSON.stringify(reopening))
    const first = await publish(t.ctx, prepared.canvasDir, OPTS)
    expect(first.selfReview).toMatchObject({ status: 'posted', comments: 1, held: 1 })
    expect(posts[0]?.comments.map(c => c.body.split('\n')[0])).toEqual(['**Self-review: Title kept**'])
    expect(Object.keys((await t.ctx.decks.readPosted(42)).posted)).toEqual(['kept'])

    // The next canvas no longer reopens it: now its reason goes out.
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    await writeTextAtomic(`${prepared.canvasDir}/model.json`, JSON.stringify(model))
    const second = await publish(t.ctx, prepared.canvasDir, OPTS)
    expect(second.selfReview).toMatchObject({ status: 'posted', comments: 1 })
    expect(posts[1]?.comments.map(c => c.body.split('\n')[0])).toEqual(['**Self-review: Title contested**'])
  })
})
