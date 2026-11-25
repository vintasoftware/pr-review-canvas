import { emptyState } from '../src/contract/state.js'
import { browserState } from './review-state.js'

/** A Storage over a map, whose writes can be made to fail as a full or blocked storage's do. */
function fakeStorage(opts: { failWrites?: boolean } = {}) {
  const items = new Map<string, string>()
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (opts.failWrites === true) throw new Error('QuotaExceededError')
      items.set(key, value)
    },
  } as unknown as Storage
  return { storage, items }
}

const state = { ...emptyState('2026-11-24T00:00:00.000Z'), reviewed: { 'layer:a': true as const } }

it('keeps each key in local storage, and reads back only a state that matches the schema', async () => {
  const { storage, items } = fakeStorage()
  const kept = browserState(storage)
  await kept.write('github/acme/widgets/42', state)
  expect(JSON.parse(items.get('pr-review-viewer:state:github/acme/widgets/42')!)).toEqual(state)
  expect(await browserState(storage).read('github/acme/widgets/42')).toEqual(state)
  items.set('pr-review-viewer:state:broken', '{"reviewed": 3}')
  expect(await kept.read('broken')).toBeNull()
  expect(await kept.read('absent')).toBeNull()
})

it('keeps the state in memory for this page when the browser refuses to store it', async () => {
  const refusing = browserState(fakeStorage({ failWrites: true }).storage)
  await refusing.write('k', state)
  expect(await refusing.read('k')).toEqual(state)
  const none = browserState(null)
  await none.write('k', state)
  expect(await none.read('k')).toEqual(state)
})
