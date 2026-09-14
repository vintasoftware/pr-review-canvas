// One implementation for both sides: the browser loads static/js/mermaid-fences.js as a module,
// and the validator imports the same file through this re-export.
export type { MermaidSegment } from '../../static/js/mermaid-fences.js'
export { diagramKind, mermaidBlocks, splitMermaid, withoutMermaid } from '../../static/js/mermaid-fences.js'
