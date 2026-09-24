// @vitest-environment node
// The self-review deck, from `deck prepare` through the page's API to the fix list and the next
// deck that carries what was settled.
import { readFile } from 'node:fs/promises'
import {
  type DecisionCard,
  type Deck,
  DeckContextSchema,
  deckCardCap,
  type Pick,
  pickNeedsFix,
} from '../contract/deck.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { createApp } from '../server/app.js'
import type { DeckResponse } from '../server/routes/deck-routes.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import { makeTempDir, makeTestContext, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, ghFor42, gitFor42, gitForLocal, HEAD_SHA } from '../testing/synthetic.js'
import { renderFixList, summarizePicks } from './fix-list.js'
import { prepareDeck } from './prepare-deck.js'
import { settledFrom } from './settled-for-pr.js'
import { DeckInvalidError, publishDeck } from './publish-deck.js'
import { validateDeckModel } from './validate-deck.js'

const LOCAL = { host: 'localhost:3010' }
const WRITE = { ...LOCAL, origin: 'http://localhost:3010', 'content-type': 'application/json' }
const quiet = () => undefined

function card(over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    key: 'empty-rows',
    bucket: 'trade-off',
    topic: 'Rare case vs simplify',
    title: 'What happens to empty rows?',
    context: 'The importer skips rows with no cells.',
    path: 'src/app.ts',
    line: 2,
    current: 'a',
    a: {
      label: 'Skip them',
      consequence: 'Old exports import cleanly.',
      why: 'Only old exports pad.',
      record: 'pr-comment',
    },
    b: {
      label: 'Fail loudly',
      consequence: 'Nothing is dropped quietly.',
      why: 'Never drop data.',
      record: 'none',
    },
    ...over,
  }
}

function pick(choice: Pick['choice'], over: Partial<Pick> = {}): Pick {
  return { choice, pickedAt: '2026-09-10T12:00:00.000Z', ...over }
}

function deckOf(cards: DecisionCard[]): Deck {
  return {
    version: 1,
    review: 'branch',
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'origin/main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T12:00:00.000Z',
    generator: { agent: 'claude' },
    cards,
    settled: [],
  }
}

describe('the card cap', () => {
  it('allows one card per linesPerCard changed lines, rounded up, never above maxCards', () => {
    const limits = { maxCards: 10, linesPerCard: 100 }
    expect(deckCardCap(0, limits)).toBe(0)
    expect(deckCardCap(3, limits)).toBe(1)
    expect(deckCardCap(101, limits)).toBe(2)
    expect(deckCardCap(1000, limits)).toBe(10)
    expect(deckCardCap(5000, limits)).toBe(10)
    expect(deckCardCap(250, { maxCards: 2, linesPerCard: 50 })).toBe(2)
  })
})

describe('which picks ask for a fix', () => {
  it('is the side the code does not implement, or neither side; never a skip', () => {
    expect(pickNeedsFix(card(), pick('a'))).toBe(false)
    expect(pickNeedsFix(card(), pick('b'))).toBe(true)
    expect(pickNeedsFix(card(), pick('neither', { note: 'x' }))).toBe(true)
    expect(pickNeedsFix(card(), pick('skip'))).toBe(false)
    expect(pickNeedsFix(card({ current: null }), pick('a'))).toBe(true)
  })
})

describe('validateDeckModel', () => {
  const files = [
    {
      path: 'src/app.ts',
      key: 'src_app_ts',
      status: 'modified' as const,
      additions: 3,
      deletions: 1,
      hunks: [
        { id: 'src_app_ts#1', header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 },
      ],
    },
  ]

  it('passes a deck that fits', () => {
    expect(validateDeckModel({ cards: [card()] }, { files, maxCards: 1 })).toMatchObject({ ok: true })
    expect(validateDeckModel({ cards: [] }, { files, maxCards: 0 })).toMatchObject({ ok: true })
  })

  it('names every problem, one line each', () => {
    const long = 'x'.repeat(61)
    const result = validateDeckModel(
      {
        cards: [
          card({ title: long }),
          card({ path: 'src/gone.ts' }),
          card({ key: 'lines', line: 40 }),
          card({ key: 'same', b: { ...card().b, label: 'skip THEM' } }),
          card({
            key: 'big',
            a: { ...card().a, snippet: { code: Array.from({ length: 9 }, () => 'x').join('\n') } },
          }),
        ],
      },
      { files, maxCards: 4 }
    )
    expect(result.ok).toBe(false)
    const codes = result.ok ? [] : result.problems.map(p => `${p.code} ${p.where}`)
    expect(codes).toEqual([
      'TOO_MANY_CARDS cards',
      'TEXT_TOO_LONG card:empty-rows.title',
      'DUPLICATE_CARD card:empty-rows',
      'CARD_OUTSIDE_DIFF card:empty-rows',
      'CARD_OUTSIDE_DIFF card:lines',
      'SIDES_ALIKE card:same',
      'SNIPPET_TOO_LONG card:big.a.snippet',
    ])
  })

  it('counts visible text, so backticks and link targets are free', () => {
    const title = `\`${'y'.repeat(60)}\``
    expect(validateDeckModel({ cards: [card({ title })] }, { files, maxCards: 1 }).ok).toBe(true)
  })

  it('names the root when the model is not an object at all', () => {
    const result = validateDeckModel(null, { files, maxCards: 1 })
    expect(result.ok ? [] : result.problems.map(p => [p.code, p.where])).toEqual([['DECK_SCHEMA', '(root)']])
  })

  it('reports schema problems by path', () => {
    const result = validateDeckModel({ cards: [{ ...card(), current: 'c' }] }, { files, maxCards: 1 })
    expect(result.ok ? [] : result.problems.map(p => p.code)).toEqual(['DECK_SCHEMA'])
    expect(result.ok ? '' : result.problems[0]?.where).toBe('cards.0.current')
  })
})

describe('the fix list', () => {
  const cards = [
    card({ key: 'keep' }),
    card({ key: 'change', title: 'Change me', a: { ...card().a, record: 'none' } }),
    card({ key: 'other', title: 'Neither', current: 'b' }),
    card({ key: 'note', title: 'Write it down', current: 'b', b: { ...card().b, record: 'code' } }),
    card({ key: 'skipped', title: 'Left over' }),
    card({ key: 'open', title: 'Not answered' }),
  ]
  const picks = {
    keep: pick('a'),
    change: pick('b', { why: 'Edited reason.' }),
    other: pick('neither', { note: 'Log and continue.' }),
    note: pick('b'),
    skipped: pick('skip'),
  }

  it('tallies fixes, reasons for the code, queued comments, skips, and open cards', () => {
    expect(summarizePicks(deckOf(cards), picks)).toEqual({
      fixes: 2,
      records: 1,
      comments: 1,
      skipped: 1,
      open: 1,
    })
  })

  it('writes each kind of pick into its own section', () => {
    const md = renderFixList(deckOf(cards), picks)
    expect(md).toContain('# Self-review fix list')
    expect(md).toContain('### 1. Change me')
    expect(md).toContain('- Wanted: B: Fail loudly. Nothing is dropped quietly.')
    expect(md).toContain('- Why: Edited reason.')
    expect(md).toContain('### 2. Neither')
    expect(md).toContain('- Wanted: neither side. Log and continue.')
    expect(md).toContain('## Reasons to write into the code')
    expect(md).toContain('- Write down: Never drop data.')
    expect(md).toContain('## Queued as pull request comments')
    expect(md).toContain('- What happens to empty rows? (`src/app.ts:2`): Only old exports pad.')
    expect(md).toContain(
      '## Left for reviewers\n\n- Left over (`src/app.ts:2`)\n- Not answered (`src/app.ts:2`)'
    )
  })

  it('gives the agent what it needs for each fix: where, what the code does now, and the target code', () => {
    const md = renderFixList(
      deckOf([
        card({
          key: 'old',
          title: 'Deleted guard',
          side: 'old',
          line: 7,
          current: null,
          b: { ...card().b, snippet: { lang: 'ts', code: 'if (!row) throw new Error(row)\nreturn row' } },
        }),
      ]),
      { old: pick('b') }
    )
    expect(md).toContain('- Where: `src/app.ts:7 (old side)`')
    expect(md).toContain('- Now: the code does neither side')
    expect(md).toContain('  ```ts\n  if (!row) throw new Error(row)\n  return row\n  ```')
    expect(md).toContain('- Why: Never drop data.')
  })

  it('files a kept side under the code when the author moved its reason there', () => {
    const md = renderFixList(deckOf([card()]), {
      'empty-rows': pick('a', { record: 'code', why: 'Old tool pads.' }),
    })
    expect(md).toContain('_No pick asks the code to change._')
    expect(md).toContain('## Reasons to write into the code\n\n### 1. What happens to empty rows?')
    expect(md).toContain('- Write down: Old tool pads.')
    expect(md).not.toContain('## Queued as pull request comments')
  })

  it('asks for what the author wrote when neither side fits, and omits a reason they did not give', () => {
    const md = renderFixList(deckOf([card()]), {
      'empty-rows': pick('neither', { note: 'Warn, then skip.' }),
    })
    expect(md).toContain('- Wanted: neither side. Warn, then skip.')
    expect(md).not.toContain('- Why:')
  })

  it('says so when no pick asks the code to change', () => {
    const md = renderFixList(deckOf([card()]), { 'empty-rows': pick('a', { record: 'none' }) })
    expect(md).toContain('_No pick asks the code to change._')
    expect(md).not.toContain('## Queued as pull request comments')
  })
})

describe('settledFrom', () => {
  it('carries answered cards and earlier settled ones, and leaves skipped cards to be asked again', () => {
    const earlier = { ...card({ key: 'old' }), pick: pick('b'), headSha: BASE_SHA }
    const previous = {
      ...deckOf([card({ key: 'kept' }), card({ key: 'skipped' }), card({ key: 'old' })]),
      settled: [earlier],
    }
    const settled = settledFrom(previous, { kept: pick('a'), skipped: pick('skip'), old: pick('a') })
    expect(settled.map(c => [c.key, c.pick.choice, c.headSha])).toEqual([
      ['kept', 'a', HEAD_SHA],
      ['old', 'a', HEAD_SHA],
    ])
    expect(settledFrom(null, {})).toEqual([])
  })
})

describe('a deck from prepare to the fix list', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  async function prepareAndWrite(cards: DecisionCard[], review: 'branch' | 'uncommitted' = 'uncommitted') {
    const prepared = await prepareDeck(t.ctx, { review, base: 'origin/main', force: true }, quiet)
    await writeTextAtomic(prepared.modelPath, JSON.stringify({ cards }))
    return prepared
  }

  it('prepares a prompt with the cap, the diff, and nothing settled yet', async () => {
    t = await makeTestContext({ git: gitForLocal() })
    const phases: string[] = []
    const prepared = await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, p => phases.push(p))
    expect(phases).toEqual(['snapshot', 'collect-diffs', 'prompt'])
    expect(prepared).toMatchObject({
      status: 'prepared',
      headSha: HEAD_SHA,
      base: 'origin/main',
      uncommitted: true,
      settled: 0,
    })
    const prompt = await readFile(prepared.promptPath, 'utf8')
    expect(prompt).toContain(`Write at most **${prepared.maxCards}** cards`)
    expect(prompt).toContain('### hunk src_app_ts#1')
    expect(prompt).not.toContain('{{')
    expect(prompt).not.toContain('## Already settled')
    const context = DeckContextSchema.parse(
      JSON.parse(await readFile(prepared.promptPath.replace('prompt.md', 'context.json'), 'utf8'))
    )
    expect(context.maxCards).toBe(1)
    expect(prepared.maxCards).toBe(1)
  })

  it('refuses an invalid deck and publishes a valid one', async () => {
    t = await makeTestContext({ git: gitForLocal() })
    await prepareAndWrite([card({ line: 99 })])
    await expect(
      publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    ).rejects.toBeInstanceOf(DeckInvalidError)
    await prepareAndWrite([card()])
    const published = await publishDeck(t.ctx, 'uncommitted', {
      agent: 'claude',
      model: 'm',
      allowStale: false,
    })
    expect(published).toEqual({
      status: 'published',
      review: 'uncommitted',
      headSha: HEAD_SHA,
      cards: 1,
      settled: 0,
      deckUrl: 'http://localhost:3010/deck/uncommitted',
    })
    expect((await t.ctx.decks.readDeck('uncommitted'))?.generator).toEqual({ agent: 'claude', model: 'm' })
    // The same head needs --force for another deck.
    expect((await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, quiet)).status).toBe('exists')
  })

  it('refuses a deck whose head moved while it was written', async () => {
    const git = gitForLocal()
    t = await makeTestContext({ git })
    await prepareAndWrite([card()])
    git.options.snapshot = BASE_SHA
    await expect(
      publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    ).rejects.toMatchObject({
      code: 'DECK_STALE',
    })
    expect((await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: true })).headSha).toBe(
      HEAD_SHA
    )
  })

  it('serves the deck with its excerpts, saves picks, undoes them, and writes the fix list', async () => {
    t = await makeTestContext({ git: gitForLocal() })
    await prepareAndWrite([card()])
    await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    const app = createApp(t.ctx)

    const page = await app.request('/deck/uncommitted', { headers: LOCAL })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('/static/js/deck.js')
    expect((await app.request('/deck/nope', { headers: LOCAL })).status).toBe(400)

    const got = (await (
      await app.request('/api/deck/uncommitted', { headers: LOCAL })
    ).json()) as DeckResponse
    expect(got.deck.cards.map(c => c.key)).toEqual(['empty-rows'])
    expect(got.excerpts['empty-rows']).toMatchObject({
      path: 'src/app.ts',
      header: '@@ -1,4 +1,5 @@',
      newStart: 1,
    })
    expect(got.excerpts['empty-rows']?.lines).toContain("+import { b } from './b'")
    expect(got.summary.open).toBe(1)
    expect(got.fixes).toBeNull()

    const put = (body: unknown) =>
      app.request('/api/deck/uncommitted/picks/empty-rows', {
        method: 'PUT',
        headers: WRITE,
        body: JSON.stringify(body),
      })
    expect((await put({ headSha: BASE_SHA, choice: 'b' })).status).toBe(409)
    expect((await put({ headSha: HEAD_SHA, choice: 'neither' })).status).toBe(400)
    const saved = await put({ headSha: HEAD_SHA, choice: 'b', why: 'Edited.' })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { summary: { fixes: number } }).summary.fixes).toBe(1)
    expect((await t.ctx.decks.readPicks('uncommitted')).picks['empty-rows']).toMatchObject({
      choice: 'b',
      why: 'Edited.',
    })

    const undone = await app.request(`/api/deck/uncommitted/picks/empty-rows?headSha=${HEAD_SHA}`, {
      method: 'DELETE',
      headers: WRITE,
    })
    expect(undone.status).toBe(200)
    expect((await t.ctx.decks.readPicks('uncommitted')).picks).toEqual({})

    await put({ headSha: HEAD_SHA, choice: 'b' })
    const finished = await app.request(`/api/deck/uncommitted/finish?headSha=${HEAD_SHA}`, {
      method: 'POST',
      headers: WRITE,
    })
    expect(finished.status).toBe(200)
    const fixes = (await finished.json()) as { path: string; markdown: string }
    expect(fixes.path).toBe(t.ctx.decks.fixesPath('uncommitted'))
    expect(await readFile(fixes.path, 'utf8')).toBe(fixes.markdown)
    expect(fixes.markdown).toContain('### 1. What happens to empty rows?')
  })

  it('rejects writes from another origin and answers a missing deck with DECK_NOT_FOUND', async () => {
    t = await makeTestContext({ git: gitForLocal() })
    const app = createApp(t.ctx)
    const missing = await app.request('/api/deck/branch', { headers: LOCAL })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('DECK_NOT_FOUND')
    const cross = await app.request('/api/deck/branch/picks/x', {
      method: 'PUT',
      headers: { ...WRITE, origin: 'http://evil.example' },
      body: '{}',
    })
    expect(cross.status).toBe(403)
  })

  it('carries settled decisions into the next deck and never asks them again, unless asked by key', async () => {
    const config = { ...DEFAULT_PROJECT_CONFIG, selfReview: { maxCards: 10, linesPerCard: 1 } }
    t = await makeTestContext({ git: gitForLocal(), projectConfig: { config, warnings: [], source: null } })
    await prepareAndWrite([card(), card({ key: 'later', title: 'Later' })])
    await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    await t.ctx.decks.setPick('uncommitted', 'empty-rows', pick('a'))
    await t.ctx.decks.setPick('uncommitted', 'later', pick('skip'))

    const again = await prepareDeck(t.ctx, { review: 'uncommitted', force: true }, quiet)
    expect(again.settled).toBe(1)
    const prompt = await readFile(again.promptPath, 'utf8')
    expect(prompt).toContain('## Already settled')
    expect(prompt).toContain('`empty-rows` **What happens to empty rows?**: the author picked A, Skip them.')
    expect(prompt).not.toContain('`later`')

    await writeTextAtomic(again.modelPath, JSON.stringify({ cards: [] }))
    const next = await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    expect(next).toMatchObject({ cards: 0, settled: 1 })
    expect((await t.ctx.decks.readPicks('uncommitted')).picks).toEqual({})

    // The generator asks a settled decision again when the code still contradicts it.
    await prepareAndWrite([card()])
    const reopened = await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    expect(reopened).toMatchObject({ cards: 1, settled: 0 })
  })
})

describe('a deck for a pull request', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('reads the pull request from the forge, and files its deck under its number', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const phases: string[] = []
    const prepared = await prepareDeck(t.ctx, { review: 42, force: false }, p => phases.push(p))
    expect(phases).toEqual(['fetch-pr', 'fetch-refs', 'collect-diffs', 'prompt'])
    expect(prepared).toMatchObject({ status: 'prepared', review: 42, headSha: HEAD_SHA, uncommitted: false })
    const prompt = await readFile(prepared.promptPath, 'utf8')
    expect(prompt).toContain('# Self-review deck for pull request #42')
    expect(prompt).toContain('- Pull request #42: feat: add b')
    expect(prompt).toContain('pr-review deck validate --pr 42')

    await writeTextAtomic(prepared.modelPath, JSON.stringify({ cards: [card()] }))
    const published = await publishDeck(t.ctx, 42, { agent: 'claude', allowStale: false })
    expect(published).toMatchObject({ review: 42, cards: 1, deckUrl: 'http://localhost:3010/deck/42' })
    expect(t.ctx.decks.deckDir(42)).toMatch(/decks\/42$/)
    expect(await t.ctx.decks.readDeck('branch')).toBeNull()

    const app = createApp(t.ctx)
    expect((await app.request('/deck/42', { headers: LOCAL })).status).toBe(200)
    const got = (await (await app.request('/api/deck/42', { headers: LOCAL })).json()) as DeckResponse
    expect(got.deck.review).toBe(42)
    await t.ctx.decks.setPick(42, 'empty-rows', pick('b'))
    const done = await app.request(`/api/deck/42/finish?headSha=${HEAD_SHA}`, {
      method: 'POST',
      headers: WRITE,
    })
    expect(((await done.json()) as { markdown: string }).markdown).toContain('pull request #42')
  })
})

describe('the deck API refuses what it cannot apply', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  async function published() {
    t = await makeTestContext({ git: gitForLocal() })
    const prepared = await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, quiet)
    await writeTextAtomic(prepared.modelPath, JSON.stringify({ cards: [card()] }))
    await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    return createApp(t.ctx)
  }

  const put = (app: ReturnType<typeof createApp>, cardKey: string, body: string) =>
    app.request(`/api/deck/uncommitted/picks/${cardKey}`, { method: 'PUT', headers: WRITE, body })

  it('answers each bad pick with the status that says why, and saves nothing', async () => {
    const app = await published()
    const cases: Array<[string, string, number]> = [
      ['empty-rows', 'not json', 400],
      ['empty-rows', JSON.stringify({ headSha: HEAD_SHA, choice: 'maybe' }), 400],
      ['empty-rows', JSON.stringify({ choice: 'a' }), 400],
      ['no-such-card', JSON.stringify({ headSha: HEAD_SHA, choice: 'a' }), 404],
      ['empty-rows', JSON.stringify({ headSha: HEAD_SHA, choice: 'neither', note: '   ' }), 400],
    ]
    for (const [cardKey, body, status] of cases) {
      expect((await put(app, cardKey, body)).status, body).toBe(status)
    }
    expect((await t.ctx.decks.readPicks('uncommitted')).picks).toEqual({})
    expect((await app.request('/api/deck/not-a-review', { headers: LOCAL })).status).toBe(400)
  })

  it('refuses an undo or a finish made on a deck that was regenerated since', async () => {
    const app = await published()
    await t.ctx.decks.setPick('uncommitted', 'empty-rows', pick('b'))
    const stale = await app.request(`/api/deck/uncommitted/picks/empty-rows?headSha=${BASE_SHA}`, {
      method: 'DELETE',
      headers: WRITE,
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('DECK_STALE')
    expect((await t.ctx.decks.readPicks('uncommitted')).picks['empty-rows']?.choice).toBe('b')
    const finish = await app.request('/api/deck/uncommitted/finish', { method: 'POST', headers: WRITE })
    expect(finish.status).toBe(409)
    expect(await t.ctx.decks.readFixes('uncommitted')).toBeNull()
  })

  it('still serves a deck whose diff this clone can no longer rebuild, just without excerpts', async () => {
    const app = await published()
    const deck = await t.ctx.decks.readDeck('uncommitted')
    if (deck === null) throw new Error('no deck')
    await t.ctx.decks.writeDeck('uncommitted', { ...deck, headSha: 'e'.repeat(40) })
    const res = await app.request('/api/deck/uncommitted', { headers: LOCAL })
    expect(res.status).toBe(200)
    const got = (await res.json()) as DeckResponse
    expect(got.deck.cards).toHaveLength(1)
    expect(got.excerpts).toEqual({})
  })

  it('serves a card whose file left the diff without an excerpt, and the fix list once written', async () => {
    const app = await published()
    const deck = await t.ctx.decks.readDeck('uncommitted')
    if (deck === null) throw new Error('no deck')
    await t.ctx.decks.writeDeck('uncommitted', {
      ...deck,
      cards: [...deck.cards, card({ key: 'gone', path: 'src/gone.ts' })],
    })
    await t.ctx.decks.writeFixes('uncommitted', '# Self-review fix list\n')
    const got = (await (
      await app.request('/api/deck/uncommitted', { headers: LOCAL })
    ).json()) as DeckResponse
    expect(Object.keys(got.excerpts)).toEqual(['empty-rows'])
    expect(got.fixes).toEqual({
      path: t.ctx.decks.fixesPath('uncommitted'),
      markdown: '# Self-review fix list\n',
    })
  })
})

describe('a pick keeps what the author edited', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('saves an edited reason, a moved record, and a note, and the fix list uses them', async () => {
    // The branch review reads the branch tip, here the commit the synthetic diff leads to.
    t = await makeTestContext({ git: gitForLocal({ head: HEAD_SHA }) })
    const prepared = await prepareDeck(t.ctx, { review: 'branch', force: false }, quiet)
    expect(await readFile(prepared.promptPath, 'utf8')).toContain('# Self-review deck for a branch')
    await writeTextAtomic(prepared.modelPath, JSON.stringify({ cards: [card()] }))
    await publishDeck(t.ctx, 'branch', { agent: 'claude', allowStale: false })
    const app = createApp(t.ctx)
    const res = await app.request('/api/deck/branch/picks/empty-rows', {
      method: 'PUT',
      headers: WRITE,
      body: JSON.stringify({
        headSha: HEAD_SHA,
        choice: 'b',
        why: 'Loud beats lossy.',
        record: 'code',
        note: 'n/a',
      }),
    })
    expect(res.status).toBe(200)
    expect((await t.ctx.decks.readPicks('branch')).picks['empty-rows']).toMatchObject({
      choice: 'b',
      why: 'Loud beats lossy.',
      record: 'code',
      note: 'n/a',
    })
    const fixes = await app.request(`/api/deck/branch/finish?headSha=${HEAD_SHA}`, {
      method: 'POST',
      headers: WRITE,
    })
    const { markdown } = (await fixes.json()) as { markdown: string }
    expect(markdown).toContain('- Why: Loud beats lossy.')
    expect(markdown).toContain('- Also record the reason next to the code, as a comment or a doc line.')
    expect(markdown).toContain('branch `feat/b`')
  })
})

describe('deck prepare and publish report what is missing', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('names the prepare command for the review when nothing was prepared', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await expect(publishDeck(t.ctx, 42, { agent: 'claude', allowStale: false })).rejects.toMatchObject({
      code: 'DECK_NOT_FOUND',
      hint: 'run `pr-review deck prepare --pr 42` first',
    })
    await expect(publishDeck(t.ctx, 'branch', { agent: 'claude', allowStale: false })).rejects.toMatchObject({
      hint: 'run `pr-review deck prepare --branch` first',
    })
  })

  it('tells a missing model from a broken one', async () => {
    t = await makeTestContext({ git: gitForLocal() })
    const prepared = await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, quiet)
    await expect(
      publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    ).rejects.toMatchObject({
      code: 'DECK_NOT_FOUND',
    })
    await writeTextAtomic(prepared.modelPath, '{ "cards": [')
    const broken = await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false }).catch(
      e => e
    )
    expect(broken).toBeInstanceOf(DeckInvalidError)
    expect((broken as DeckInvalidError).problems.map(p => p.code)).toEqual(['DECK_SCHEMA'])
    expect((broken as DeckInvalidError).problems[0]?.message).toMatch(/^not valid JSON/)
    expect((broken as DeckInvalidError).message).toBe('deck-model.json has 1 problem')
    await writeTextAtomic(
      prepared.modelPath,
      JSON.stringify({ cards: [card({ line: 90 }), card({ line: 91 })] })
    )
    const two = await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false }).catch(e => e)
    expect((two as DeckInvalidError).message).toBe('deck-model.json has 4 problems')
    expect(await t.ctx.decks.readDeck('uncommitted')).toBeNull()
  })

  it('points a large diff at the patch files, and embeds the project rulebook', async () => {
    const repoRoot = await makeTempDir()
    await writeTextAtomic(`${repoRoot}/docs/REVIEW.md`, '# Standards\n\nPrefer plain loops.\n')
    const config = {
      ...DEFAULT_PROJECT_CONFIG,
      rulebook: 'docs/REVIEW.md',
      generation: { ...DEFAULT_PROJECT_CONFIG.generation, inlineDiffMaxLines: 1 },
    }
    t = await makeTestContext({ git: gitForLocal(), projectConfig: { config, warnings: [], source: null } })
    t.ctx.config.repoRoot = repoRoot
    const prepared = await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, quiet)
    const prompt = await readFile(prepared.promptPath, 'utf8')
    expect(prompt).toContain('above the 1-line inline limit, so it is not inlined')
    expect(prompt).not.toContain('### hunk src_app_ts#1')
    expect(prompt).toContain('### Project rulebook')
    expect(prompt).toContain('Prefer plain loops.')
  })

  it('tells the generator what the author wrote when neither side fit', async () => {
    t = await makeTestContext({ git: gitForLocal() })
    const prepared = await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, quiet)
    await writeTextAtomic(prepared.modelPath, JSON.stringify({ cards: [card()] }))
    await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    await t.ctx.decks.setPick('uncommitted', 'empty-rows', pick('neither', { note: 'Log and keep going.' }))
    const again = await prepareDeck(t.ctx, { review: 'uncommitted', force: true }, quiet)
    const settledLine = (await readFile(again.promptPath, 'utf8'))
      .split('\n')
      .find(l => l.startsWith('- `empty-rows`'))
    expect(settledLine).toBe(
      '- `empty-rows` **What happens to empty rows?**: the author picked neither side: Log and keep going.'
    )
  })
})
