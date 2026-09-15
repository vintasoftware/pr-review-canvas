/**
 * Mechanical repairs for text that is over its cap.
 *
 * Caps are measured on the text a reader sees, which a writer cannot count while writing, so an
 * over-cap field usually comes back over-cap after a rewrite. Two things help without touching
 * meaning: trimming a title's trailing explainer, which the length rules ask for anyway, and
 * telling the writer where the cap actually falls in their own text.
 */

import { visibleLength, visibleText } from './text-length.js'

/** Separators that introduce an explainer after a name: "Storage: how it works". */
const EXPLAINER = /\s+[:—–-]\s+|:\s+/

/**
 * The visible prefix that fits in `cap`, ending on a word boundary when one is near the cut.
 * Used to tell a writer where their text crosses the cap, never to rewrite prose for them.
 */
export function visiblePrefix(text: string, cap: number): string {
  const visible = visibleText(text)
  if (visible.length <= cap) {
    return visible
  }
  const cut = visible.slice(0, cap)
  if (/\s/.test(visible.charAt(cap))) {
    return cut.trimEnd()
  }
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > 0 && lastSpace > cap - 24 ? cut.slice(0, lastSpace) : cut
}

/**
 * A title with its trailing explainer removed, when dropping it brings the title under the cap.
 * Returns null when the title already fits or when no cut helps, so the caller leaves it alone.
 *
 * Only the first separator counts: "Endpoints: update, create" keeps "Endpoints", and a title
 * with no separator is never cut mid-phrase — a truncated name is worse than a long one.
 */
export function trimTitle(title: string, cap: number): string | null {
  const tidied = title.trim().replace(/\s+/g, ' ').replace(/\.$/, '')
  if (visibleLength(tidied) <= cap) {
    return tidied === title ? null : tidied
  }
  const match = EXPLAINER.exec(tidied)
  if (match === undefined || match === null || match.index === 0) {
    return null
  }
  const head = tidied.slice(0, match.index).trim()
  return head !== '' && visibleLength(head) <= cap ? head : null
}

/** A title this pass repaired or could not shorten safely. */
export type TitleTrim =
  | { outcome: 'fixed'; where: string; from: string; to: string }
  | { outcome: 'unfixable'; where: string; length: number; cap: number; reason: string }

interface TitledFold {
  title?: string
}

interface TitledFile {
  folds?: TitledFold[]
}

interface TitledLayer {
  title?: string
  files?: TitledFile[]
}

interface TitledOutput {
  layers?: TitledLayer[]
  points?: Array<{ title?: string }>
}

/**
 * Trims every title of a parsed model that is over its cap, in place, and reports what changed.
 * Titles only: a rationale or a body is prose a reader will read, and cutting it is the author's
 * call, not the tool's.
 */
export function applyTitleTrims(output: unknown, caps: { layerTitle: number; pointTitle: number }): TitleTrim[] {
  const trims: TitleTrim[] = []
  const trim = (where: string, holder: { title?: string }, cap: number): void => {
    if (typeof holder.title !== 'string') {
      return
    }
    const trimmed = trimTitle(holder.title, cap)
    if (trimmed !== null) {
      trims.push({ outcome: 'fixed', where, from: holder.title, to: trimmed })
      holder.title = trimmed
    } else if (visibleLength(holder.title) > cap) {
      const match = EXPLAINER.exec(holder.title.trim().replace(/\s+/g, ' '))
      const reason = match === null
        ? 'no explainer separator (:, —, – or -) to drop'
        : match.index === 0
          ? 'dropping the explainer would leave an empty title'
          : 'the title before the explainer still exceeds the cap'
      trims.push({ outcome: 'unfixable', where, length: visibleLength(holder.title), cap, reason })
    }
  }

  const model = output as TitledOutput
  model.layers?.forEach((layer, i) => {
    trim(`layers.${i}.title`, layer, caps.layerTitle)
    layer.files?.forEach((file, j) => {
      file.folds?.forEach((fold, k) => {
        trim(`layers.${i}.files.${j}.folds.${k}.title`, fold, caps.pointTitle)
      })
    })
  })
  model.points?.forEach((point, i) => {
    trim(`points.${i}.title`, point, caps.pointTitle)
  })
  return trims
}
