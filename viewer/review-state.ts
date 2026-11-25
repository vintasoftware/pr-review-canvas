// Where the viewer keeps review state: the reader's browser, in place of the local app's
// .pr-review/ files. The rules are the local app's own (src/store/state-store.ts); this is only
// the storage under them.
import { type PrState, PrStateSchema } from '../src/contract/state.js'
import type { StatePersistence } from '../src/store/state-store.js'

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * Each key's state in `localStorage`. When the browser refuses to keep it (blocked or full
 * storage), the state lives in this page's memory instead, so the review still works until the
 * tab closes. A stored state that does not match the schema starts the review afresh.
 */
export function browserState(storage: Storage | null = localStore()): StatePersistence<string> {
  const storageKey = (key: string) => `pr-review-viewer:state:${key}`
  /** States the storage did not take, newer than whatever it still holds. */
  const memory = new Map<string, PrState>()
  return {
    read(key) {
      const kept = memory.get(key)
      if (kept !== undefined) return Promise.resolve(kept)
      try {
        const raw = storage?.getItem(storageKey(key))
        if (raw) {
          const parsed = PrStateSchema.safeParse(JSON.parse(raw))
          if (parsed.success) return Promise.resolve(parsed.data)
        }
      } catch {
        // Unreadable or blocked storage starts the review afresh.
      }
      return Promise.resolve(null)
    },
    write(key, state) {
      try {
        if (storage === null) throw new Error('no storage')
        storage.setItem(storageKey(key), JSON.stringify(state))
        memory.delete(key)
      } catch {
        memory.set(key, state)
      }
      return Promise.resolve()
    },
  }
}
