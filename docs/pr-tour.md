# Tour guide

The committed notes a tour of this repository is generated with. `pr-review tour prepare` reads
this file whole; `/pr-tour-setup` edits it.

## Run the app

```bash
pnpm install          # once; about a minute
pnpm start --fixture-canvas __fixtures__/pr-278/review.json   # http://localhost:3010, about two seconds
```

The CLI runs from source through `tsx`; there is no build step.

`pnpm start` serves the review app for this clone. The fixture canvas makes every pull request
report a ready canvas, so a look at the review page needs no generation run. Opening
`/review/<n>` still fetches that pull request's live head, so it needs a GitHub login (`gh auth
status`). The tour page is `/tour/<n>`.

## Synthetic data

- Canvases: `__fixtures__/pr-278/review.json` is a real canvas of a public pull request, used as a
  fixture. `src/testing/synthetic.ts` builds a small synthetic pull request for server tests.
- Browser tests run an in-process server with a fake agent runner (`browser/fixtures.ts`).
- Fixtures may be written under `__fixtures__/`, `src/testing/`, and `static/js/__fixtures__/`
  only. Never real user data, credentials, or protected health information.

## Non-functional requirements

- Every command runs child processes through argument arrays, never a shell; the security test
  scans for it.
- The server answers only to localhost and refuses cross-origin writes; every HTML answer carries a
  content security policy. Generated scenes run in a sandboxed frame with no origin and no network.
- Coverage thresholds are 95% on lines, branches, functions, and statements.
- The review page works at phone width and with the keyboard alone; browser tests run at desktop,
  tablet, and mobile sizes.
- Both GitHub and GitLab work; nothing may assume one forge.

## Specs and designs

- `docs/adr/`: the decisions, one file each. The tour's own design is ADR 0005.
- `CONTEXT.md`: the glossary; its words are the ones code, docs, prompts, and UI use.
- `docs/reference.md`: the CLI and config reference.
- The pull request description is the spec when nothing else is.

## The agent may run

```text
pnpm install
pnpm check
pnpm test
pnpm test:browser
pnpm start --fixture-canvas __fixtures__/pr-278/review.json
git show <sha>:<path>
gh pr view <n>
```
