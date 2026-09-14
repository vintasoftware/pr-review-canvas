// @ts-check
// @vitest-environment node
import { createStore } from './store.js'

describe('createStore', () => {
  it('holds a value, notifies subscribers, and stops after unsubscribe', () => {
    const store = createStore({ n: 1 })
    const seen = /** @type {Array<{ n: number }>} */ ([])
    const off = store.subscribe(s => seen.push(s))
    store.set({ n: 2 })
    store.update(s => ({ n: s.n + 1 }))
    expect(store.get()).toEqual({ n: 3 })
    off()
    store.set({ n: 9 })
    expect(seen).toEqual([{ n: 2 }, { n: 3 }])
  })
})
