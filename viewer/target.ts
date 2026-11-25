// Which pull request the viewer opens, from the `pr` query parameter.
import type { ViewerTarget } from './viewer-api.js'

/** `owner/repo/123`, `owner/repo#123`, or a github.com pull request URL, tab included. */
export function parseTarget(raw: string | null): ViewerTarget | null {
  if (raw === null) return null
  const text = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/pull\/|\/|#)(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/.exec(
    text
  )
  if (match === null) return null
  // `.` and `..` are no names GitHub gives, and would walk up the API path.
  if (/^\.+$/.test(match[1]!) || /^\.+$/.test(match[2]!)) return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number < 1) return null
  return { owner: match[1]!, repo: match[2]!, number }
}
