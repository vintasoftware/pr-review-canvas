// `hljs` is the import-map name of @highlightjs/cdn-assets/es/highlight.min.js, which ships no types.
declare module 'hljs' {
  interface HighlightResult {
    value: string
  }
  interface HighlightOptions {
    language: string
    ignoreIllegals?: boolean
  }
  const hljs: {
    highlight(code: string, options: HighlightOptions): HighlightResult
    getLanguage(name: string): unknown
  }
  export default hljs
}
