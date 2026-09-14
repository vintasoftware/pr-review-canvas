// @ts-check

/**
 * @template T
 * @typedef {{ get: () => T, set: (next: T) => void, update: (fn: (cur: T) => T) => void, subscribe: (fn: (state: T) => void) => () => void }} Store
 */

/**
 * A tiny observable value. Subscribers run after every set; unsubscribe with the returned function.
 * @template T
 * @param {T} initial
 * @returns {Store<T>}
 */
export function createStore(initial) {
  let state = initial
  /** @type {Set<(state: T) => void>} */
  const subs = new Set()
  const set = /** @param {T} next */ next => {
    state = next
    for (const fn of subs) {
      fn(state)
    }
  }
  return {
    get: () => state,
    set,
    update: fn => set(fn(state)),
    subscribe: fn => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}
