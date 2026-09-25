/**
 * Runs the work given for one key strictly after the work given before it for that key, whether
 * that work succeeded or failed. Different keys run side by side.
 */
export function oneAtATime<K>(): <T>(key: K, run: () => Promise<T>) => Promise<T> {
  const chains = new Map<K, Promise<unknown>>()
  return (key, run) => {
    const chained = (chains.get(key) ?? Promise.resolve()).then(run, run)
    chains.set(
      key,
      chained.catch(() => undefined)
    )
    return chained
  }
}
