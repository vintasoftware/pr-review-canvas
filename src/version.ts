// Comparing release versions, for `upgrade` and the prompt-token checks `doctor` runs too.

/** `1.2.10` against `1.2.9`, numerically. A prerelease tag is ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] => v.trim().replace(/^v/, '').split(/[-+]/)[0]!.split('.').map(Number)
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (Number.isNaN(diff)) return false
    if (diff !== 0) return diff > 0
  }
  return false
}
