# Contributing

In a clone of this tool, use pnpm for the shared lockfile and development checks:

```bash
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm hooks:install
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm verify
corepack pnpm start --repo /path/to/your-project
```

When an installed `pr-review serve` already runs, `pnpm start` adds your project to that server
and exits. Pass another port, as in `corepack pnpm start --port 3011 --repo /path/to/your-project`,
to run this clone's server next to it. A server on another port leaves `~/.pr-review/server.json`
and the saved project list to the installed one, so `pr-review open` keeps opening projects there;
the projects you add to it last until it stops.

The pre-commit hook runs `pnpm precommit`: lint, formatting, strict type checks, and tests.
Run `pnpm hooks:install` once per clone to enable it. Use `pnpm lint:fix` and `pnpm format` to apply automatic fixes.
CI runs the same checks through `pnpm verify`, with coverage executing the unit tests once.

Run `pnpm verify` before pushing. When changing behavior, test failure and boundary cases and
keep branch coverage at least 96%, above CI's 95% minimum. Each CI job uploads
`coverage-node-<version>` with branch locations and a summary. Local reports are in
`coverage/` after `pnpm coverage`.

Run `pr-review --help` for CLI commands, or `pr-review <command> --help` for one command's flags.
Local data goes in the project's `.pr-review/` directory; keep it out of Git.

See [Publishing to npm](publishing.md) for release checks and first-publish instructions.
