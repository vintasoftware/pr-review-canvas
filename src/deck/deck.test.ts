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
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, gitForLocal, HEAD_SHA } from '../testing/synthetic.js'
import { renderFixList, summarizePicks } from './fix-list.js'
import { prepareDeck, settledFrom } from './prepare-deck.js'
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
    expect((await app.request('/deck/42', { headers: LOCAL })).status).toBe(400)

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
