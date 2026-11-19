# Static viewer (proof of concept)

A static page that opens the canvas published on a public GitHub pull request, with nothing to
install. It is the first step of [ADR 0005](../docs/adr/0005-static-read-only-viewer.md): public
repositories only, no sign-in, no Cloudflare Worker yet.

```bash
pnpm viewer:dev
```

Then open http://127.0.0.1:4174/?pr=vintasoftware/pr-review-canvas/110. The `pr` parameter takes
`owner/repo/123`, `owner/repo#123`, or the pull request's URL. `pnpm viewer:build` writes the static
files to `dist-viewer/`.

## How it works

The page boots the same `static/js/app.js` the local server serves. `main.ts` replaces `fetch` for
the page's `/api` calls, and `viewer-api.ts` answers them in the browser:

- The pull request, its comments, and the diff come from GitHub's REST API (`github-client.ts`),
  read with the server's own mappers (`src/github/pr.ts`, `src/github/comments.ts`) and diff parser
  (`src/git/diff-collector.ts`).
- The canvas is the newest canvas comment on the pull request, read with `readCanvasZip` like an
  import. It shows as ready, carried over, or outdated by the same rules as the local app.
- Review marks, dismissals, hidden threads, and the skin and theme stay in `localStorage`.
- Posting, the pending review, AI chat, generation, and import answer `NOT_IMPLEMENTED`.

## Limits

- GitHub allows 60 anonymous requests an hour per address, and counts a 304 against it too. A cold
  load of a pull request costs about six requests. Answers are reused for five minutes, and the
  page's refresh command asks again.
- Resolved review threads read as open: GitHub's GraphQL API, which reports them, needs a token.
- Screens built for the local app still offer its commands, such as generating a canvas or
  dropping a zip, and those fail with a "not available in the read-only viewer" message.
