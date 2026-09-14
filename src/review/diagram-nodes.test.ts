// @vitest-environment node
// The sources here are the ones the prompt recommends, written the way a model writes them.
import { MERMAID_SOURCE } from '../../static/js/__fixtures__/mermaid-svg.js'
import { diagramNodeIds } from './diagram-nodes.js'

function ids(source: string): string[] {
  return [...diagramNodeIds(source)].sort()
}

describe('diagramNodeIds', () => {
  it('reads a flowchart: shapes, an edge label, a subgraph, and no style names', () => {
    const source = [
      'flowchart LR',
      '  ingest[Ingest] --> store[(Storage)]',
      '  store --> serve{Serve}',
      '  serve -->|ok| done',
      '  serve -.-> retry',
      '  subgraph api [The API]',
      '    serve',
      '  end',
      '  classDef hot fill:#f00',
      '  class store hot',
      '  click store "https://example.test"',
    ].join('\n')
    expect(ids(source)).toEqual(['api', 'done', 'ingest', 'retry', 'serve', 'store'])
  })

  it('reads an arrow glued to its nodes the way mermaid does', () => {
    // `box-->done` and `A-->oven` are the two ways an arrow written without spaces can eat a name;
    // `x-->done` and `x---oB` are nodes called `x`, while the `x` of `x--x` is the arrow's tail;
    // an `x`/`o` head belongs to the arrow even with the next name glued to it; and an invisible
    // link takes no head.
    const source = [
      'flowchart LR',
      '  box-->done',
      '  A-->oven',
      '  x-->done',
      '  x---oB',
      '  p x--x q',
      '  C---oD',
      '  E---xF',
      '  G~~~orange',
      '  r -.-> s',
      '  t ==> u',
      '  v --o w',
      '  m <--> n',
    ].join('\n')
    expect(ids(source)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'box',
      'done',
      'm',
      'n',
      'orange',
      'oven',
      'p',
      'q',
      'r',
      's',
      't',
      'u',
      'v',
      'w',
      'x',
    ])
    // On their own, so a line that also names the node elsewhere cannot hide a regression.
    expect(ids('flowchart LR\n  x---oB')).toEqual(['B', 'x'])
    expect(ids('flowchart LR\n  G~~~orange')).toEqual(['G', 'orange'])
    expect(ids('flowchart LR\n  A---oB')).toEqual(['A', 'B'])
  })

  it('reads a sequence diagram: declared participants and the sides of a message', () => {
    const source = [
      'sequenceDiagram',
      '  participant App as Intake App',
      '  actor User',
      '  App->>Srv: POST /api/shl',
      '  Srv-->>App: 201 created',
      '  App-)Srv: fire and forget',
      '  Note over App,Srv: both sides',
    ].join('\n')
    expect(ids(source)).toEqual(['App', 'Srv', 'User'])
  })

  it('reads a state diagram: transitions, descriptions, and an aliased state', () => {
    const source = [
      'stateDiagram-v2',
      '  [*] --> active: POST /api/shl',
      '  active --> active: PUT swaps the manifest',
      '  active --> expired: exp passes',
      '  direction LR',
      '  state "cleanup claimed it" as claimed',
      '  state pending {',
      '    [*] --> waiting',
      '  }',
      '  note right of purged: audit rows stay',
      '  expired --> claimed',
      '  claimed --> purged: blobs deleted',
      '  purged --> [*]',
      '  purged: audit rows kept',
    ].join('\n')
    expect(ids(source)).toEqual(['active', 'claimed', 'expired', 'pending', 'purged', 'waiting'])
  })

  it('reads a quoted ER entity name, and not a quoted relationship label', () => {
    const source = 'erDiagram\n  "Order Item" ||--o{ ORDER : belongs_to\n  ORDER {\n    string id PK\n  }'
    expect(ids(source)).toEqual(['ORDER', 'Order Item'])
    expect(ids('erDiagram\n  A ||--o{ B : "was ordered by"')).toEqual(['A', 'B'])
  })

  it('reads an ER diagram: both sides of a relationship, and no attribute names', () => {
    const source = [
      'erDiagram',
      '  direction LR',
      '  SHL ||--o{ SHL_FILE : holds',
      '  SHL_FILE }o--|| BUCKET : stored_in',
      '  SHL {',
      '    string id PK',
      '    string passcode',
      '  }',
    ].join('\n')
    expect(ids(source)).toEqual(['BUCKET', 'SHL', 'SHL_FILE'])
  })

  it('reads every node of the sources mermaid really drew', () => {
    expect(diagramNodeIds(MERMAID_SOURCE.flowchart)).toEqual(new Set(['ingest', 'store', 'serve', 'done']))
    expect(diagramNodeIds(MERMAID_SOURCE.sequence)).toEqual(new Set(['App', 'Srv']))
    expect(diagramNodeIds(MERMAID_SOURCE.state)).toEqual(new Set(['active', 'expired', 'claimed', 'purged']))
    expect(diagramNodeIds(MERMAID_SOURCE.er)).toEqual(new Set(['SHL', 'SHL_FILE', 'BUCKET']))
  })

  it('falls back to the words of the source for a type it does not read', () => {
    const source = 'journey\n  title My day\n  section Ship\n    Review: 5: Me'
    expect(diagramNodeIds(source).has('Review')).toBe(true)
    expect(diagramNodeIds(source).has('Ship')).toBe(true)
  })

  it('falls back to the words of the source when a known type reads as nothing', () => {
    expect(diagramNodeIds('flowchart LR').has('LR')).toBe(true)
    expect(diagramNodeIds('').size).toBe(0)
  })

  it('skips comment lines', () => {
    expect(ids('flowchart LR\n  %% commented[Out]\n  a --> b')).toEqual(['a', 'b'])
  })
})
