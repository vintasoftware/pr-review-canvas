// The node ids a mermaid source names. The validator uses them to tell a diagram link keyed on a
// real node from one keyed on a name the drawing does not have.
//
// Coverage: the four types the prompt recommends (flowchart, sequence, state, ER) are read
// statement by statement; every other type, and any source these readers find no name in, falls
// back to every word of the text. Each reader keeps names it is unsure about, since a name it
// misses would be reported as a mistake the model did not make.

import { diagramKind } from '../contract/mermaid-fences.js'

/** A bare word: an identifier, or a number a flowchart may use as a node id. */
const WORD_RE = /[A-Za-z_][\w.-]*|\d[\w.-]*/g

/** Words that open a statement instead of naming a node. */
const FLOW_KEYWORDS = new Set([
  'flowchart',
  'flowchart-elk',
  'graph',
  'subgraph',
  'end',
  'direction',
  'accTitle',
  'accDescr',
  'LR',
  'RL',
  'TB',
  'BT',
  'TD',
])

/** Statements that name styles, classes, or callbacks rather than nodes. */
const FLOW_SKIP = /^(class|classDef|click|style|linkStyle|href|callback)\b/

const STATE_KEYWORDS = new Set([
  'stateDiagram',
  'stateDiagram-v2',
  'state',
  'as',
  'direction',
  'note',
  'end',
  'left',
  'right',
  'of',
  'classDef',
  'class',
  'accTitle',
  'accDescr',
  'LR',
  'RL',
  'TB',
  'BT',
  'TD',
])

const ER_KEYWORDS = new Set(['erDiagram', 'accTitle', 'accDescr', 'direction', 'LR', 'RL', 'TB', 'BT', 'TD'])

/** The text before the first `sep`, or all of it when there is none. */
function before(text: string, sep: string): string {
  const at = text.indexOf(sep)
  return at === -1 ? text : text.slice(0, at)
}

/** The words of a text, with no attempt at grammar. */
function words(text: string): string[] {
  return text.match(WORD_RE) ?? []
}

/** The lines of the source without its comments and without empty lines. */
function lines(source: string): string[] {
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('%%'))
}

/** Drops quoted text and the label brackets around it, innermost first. */
function stripLabels(line: string): string {
  let out = line.replace(/"[^"]*"/g, ' ').replace(/\|[^|]*\|/g, ' ')
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/\[[^[\]]*\]|\([^()]*\)|\{[^{}]*\}/g, ' ')
    if (next === out) {
      break
    }
    out = next
  }
  return out
}

/**
 * Replaces the arrows and edge markers of a flowchart with spaces, the way mermaid's own lexer
 * reads them: two or more of `-=.`, then one head, either `>` or the `x`/`o` of a crossing or
 * circle arrow. A head is part of the arrow even with the next name glued to it (`A---oB` names
 * `B`), while `A-->oven` keeps its `oven`, since that arrow already has its head. A leading
 * `x`/`o` is the tail of a crossing or circle arrow only when the same letter closes it. An
 * invisible link (`~~~`) takes no head, so `A~~~orange` keeps its `orange`.
 */
function stripFlowArrows(line: string): string {
  return line.replace(/(?<![\w-])([ox])(?=[-=.]{2,}\1(?![-=.]))|<?[-=.]{2,}(?:>|[xo])?|~{2,}|&/g, ' ')
}

function flowchartIds(source: string): string[] {
  const out: string[] = []
  for (const line of lines(source)) {
    if (FLOW_SKIP.test(line)) {
      continue
    }
    for (const word of words(stripFlowArrows(stripLabels(line)))) {
      if (!FLOW_KEYWORDS.has(word)) {
        out.push(word)
      }
    }
  }
  return out
}

function sequenceIds(source: string): string[] {
  const out: string[] = []
  for (const line of lines(source)) {
    const declared = /^(?:participant|actor|create\s+(?:participant|actor))\s+(.+)$/.exec(line)?.[1]
    if (declared !== undefined) {
      out.push(...words(declared.split(/\s+as\s+/)[0] ?? declared).slice(0, 1))
      continue
    }
    // A message names its two sides; the text after the first colon is the message itself.
    const head = before(line, ':')
    if (!/-{1,2}[)>x-]/.test(head)) {
      continue
    }
    for (const side of head.split(/(?:<<)?-{1,2}(?:>>|>|x|\))/)) {
      out.push(...words(side))
    }
  }
  return out
}

function stateIds(source: string): string[] {
  const out: string[] = []
  const take = (text: string): void => {
    for (const word of words(text).slice(0, 1)) {
      if (!STATE_KEYWORDS.has(word)) {
        out.push(word)
      }
    }
  }
  for (const line of lines(source)) {
    const bare = stripLabels(line).replace(/<<[^>]*>>/g, ' ')
    if (bare.startsWith('state ')) {
      const named = /\bas\s+([^\s{]+)/.exec(bare)?.[1]
      take(named === undefined ? bare.slice('state '.length) : named)
      continue
    }
    if (bare.includes('-->')) {
      // `a --> b : label` carries the label on the right side.
      for (const side of bare.split('-->')) {
        take(before(side, ':'))
      }
      continue
    }
    // `id : description` names a state and describes it.
    take(before(bare, ':'))
  }
  return out
}

/**
 * The quoted names on the entity side of an ER line, which is where a name holds a space. The
 * scan stops at the colon that opens the relationship label, so the label is not read as a name.
 */
function quotedEntities(line: string): string[] {
  const out: string[] = []
  let quote = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quote === -1) {
        quote = i + 1
      } else {
        out.push(line.slice(quote, i))
        quote = -1
      }
    } else if (ch === ':' && quote === -1) {
      break
    }
  }
  return out
}

function erIds(source: string): string[] {
  const out: string[] = []
  let depth = 0
  for (const line of lines(source)) {
    // A relationship marker (`||--o{`) carries a brace of its own, so it is removed before the
    // braces that open and close an attribute block are counted.
    const clean = stripLabels(line).replace(/[|}{o.-]{2,}/g, ' ')
    if (depth <= 0) {
      out.push(...quotedEntities(line))
      for (const word of words(before(clean, ':'))) {
        if (!ER_KEYWORDS.has(word)) {
          out.push(word)
        }
      }
    }
    depth += (clean.match(/\{/g) ?? []).length - (clean.match(/\}/g) ?? []).length
  }
  return out
}

/**
 * The node ids of a mermaid source. The first line decides how the source is read; a type this
 * module does not know, or a source it reads nothing out of, falls back to every word in the text.
 */
export function diagramNodeIds(source: string): Set<string> {
  const type = diagramKind(source)
  let found: string[] = []
  if (type === 'flowchart' || type === 'flowchart-elk' || type === 'graph') {
    found = flowchartIds(source)
  } else if (type === 'sequenceDiagram') {
    found = sequenceIds(source)
  } else if (type === 'stateDiagram') {
    found = stateIds(source)
  } else if (type === 'erDiagram') {
    found = erIds(source)
  }
  return new Set(found.length > 0 ? found : words(source))
}
