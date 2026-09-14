// @ts-check
// Finds the ```mermaid fences in a markdown text. One implementation for both sides: the client
// turns each block into a diagram placeholder, and the server counts and measures them
// (src/contract/mermaid-fences.ts re-exports this file).
import { splitFences } from './fences.js'

/** @typedef {{ type: 'markdown' | 'mermaid', text: string }} MermaidSegment */

/**
 * The pieces of a markdown text in order: prose and mermaid blocks. A mermaid block is a fenced
 * block whose info string is exactly `mermaid`.
 * @param {string} markdown
 * @returns {MermaidSegment[]}
 */
export function splitMermaid(markdown) {
  return splitFences(markdown, 'mermaid').map(s => ({
    type: s.type === 'block' ? 'mermaid' : 'markdown',
    text: s.text,
  }))
}

/**
 * The kind of drawing a source asks for, taken from its first word: `stateDiagram-v2` reads as
 * `stateDiagram`. An empty or unreadable source has no kind.
 * @param {string} source mermaid text
 * @returns {string}
 */
export function diagramKind(source) {
  const first = source.split('\n').find(line => line.trim() !== '' && !line.trim().startsWith('%%')) ?? ''
  const word = first.trim().split(/[\s{(]/)[0] ?? ''
  return /^[A-Za-z]/.test(word) ? word.replace(/-v\d+$/, '') : ''
}

/**
 * The source of every mermaid block, in order.
 * @param {string} markdown
 * @returns {string[]}
 */
export function mermaidBlocks(markdown) {
  return splitMermaid(markdown)
    .filter(s => s.type === 'mermaid')
    .map(s => s.text)
}

/**
 * The text without its mermaid blocks, for a length measured on the prose a reader reads.
 * @param {string} markdown
 * @returns {string}
 */
export function withoutMermaid(markdown) {
  return splitMermaid(markdown)
    .filter(s => s.type === 'markdown')
    .map(s => s.text)
    .join('\n')
}
