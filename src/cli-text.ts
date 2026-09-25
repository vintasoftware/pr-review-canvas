// Wrapping for the terminal. Clack draws the gutter and the symbols; it prints each line it is
// given as-is, and the terminal then breaks that line at the screen edge, including through a
// flag. Break on spaces instead, and leave a token that is itself wider than the line whole.
import type { Writable } from 'node:stream'

/** `│  ` is one glyph and two spaces, which is what clack puts in front of a guided line. */
export const CLACK_GUIDE = 3

const ANSI_COLOR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

/** Drops the color codes a terminal would not count, so a width is the columns a person sees. */
export function visibleText(text: string): string {
  return text.replaceAll(ANSI_COLOR, '')
}

/** Columns of a stream, or 80 when it is not a terminal and does not say. */
export function streamColumns(stream: Writable, fallback = 80): number {
  if ('columns' in stream && typeof stream.columns === 'number' && stream.columns > 0) {
    return stream.columns
  }
  return fallback
}

/** How much text fits once the guide is on the line. Never so narrow that a flag cannot land. */
export function contentWidth(columns: number): number {
  return Math.max(40, columns - CLACK_GUIDE)
}

/**
 * One paragraph, broken on spaces. A backtick span stays whole, so a command does not break, and
 * a token longer than `width` stays on its own line.
 */
export function wrapParagraph(text: string, width: number): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const words = trimmed.match(/`[^`]*`|\S+/g) ?? []
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`
    if (line !== '' && next.length > width) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line !== '') lines.push(line)
  return lines
}
