# Working in this repository

- Development setup and checks: [docs/contributing.md](docs/contributing.md). Run `pnpm verify` before pushing.
  It also covers the formatter, commit messages, ADRs, and testing on a real review's data.
- Driving the review page in a browser: a file's diff renders only once it is on screen. A
  background tab, a hidden layer, or a reviewed layer (it collapses) leaves "Loading diff…" with no
  rows. That is not a bug: bring the tab to the front, show and expand the layer, and scroll to
  the file.
- `pnpm dev` and `pnpm start` run this clone's server on **port 3011** with its own `.pr-review-dev/`
  home, apart from an installed `pr-review serve` on 3010. Open http://localhost:3011;
  `pnpm start --repo <dir>` adds and opens that project there.
- The project's terms (canvas, semantic layer, attention point, review checkout, carried,
  re-judged): [CONTEXT.md](CONTEXT.md).
