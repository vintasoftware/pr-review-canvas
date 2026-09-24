# PR Review Canvas

Review a GitHub pull request or GitLab merge request canvas: layers by topic, with grouped diffs,
attention points, comments, and an optional AI chat. Everything runs locally at **http://localhost:3010**.

## Quick start: author generates, reviewers review

### Author side

Each PR author generates a canvas before requesting review. The skill shares it automatically
in a comment on the GitHub PR or GitLab MR. After the project setup below, run the installed skill in Claude Code or Codex:

```text
/pr-review-canvas 123
```

Replace **123** with your PR number. The skill reads the PR, generates and validates the canvas, then publishes a compressed canvas
comment using your `gh` or `glab` login. It returns a local review URL and the comment link.

If automatic sharing fails (including a canvas too large for one comment), the skill warns you
and gives you a ZIP path. Drag that ZIP into the PR or MR description, wait for the upload, and
save. This manual upload is only a fallback.

### Before you open the pull request

To read your own change the way a reviewer will, generate a canvas for the work in your clone:

```text
/pr-review-canvas branch          # the current branch against the default branch
/pr-review-canvas uncommitted     # the same, with your working-tree edits and new files on top
```

Start `pr-review serve` and open **http://localhost:3010/review/branch** or
**/review/uncommitted**. The two are separate reviews, so generating one leaves the other alone.

Nothing is posted anywhere: local work has no pull request, so the comment and sign-off commands
stay off. Add `--base <ref>` to compare against another branch. Committing after `branch`, or
editing a file after `uncommitted`, moves the head: the next time you open the page or press
refresh, the canvas is marked outdated and the page offers to generate it again.

### Settle your decisions first: the self-review deck

A canvas explains a change. The self-review deck makes you decide it. Run:

```text
/pr-self-review branch            # or: /pr-self-review uncommitted, or /pr-self-review <pr-number>
```

The skill writes a short deck of **decision cards**, at most one per 100 changed lines and never
more than ten. Each card is one choice your change makes that a reasonable engineer could make
either way, such as handling a rare case or simplifying, or keeping backwards compatibility or
breaking cleanly. Each card has two sides, A and B, and marks the one the code does now. Open
**http://localhost:3010/deck/branch** (or `/deck/uncommitted`, or `/deck/<pr-number>`) and work through the cards one at a
time. At 1080p and above, the page never scrolls; on a phone the sides stack and you tap or drag.
A pull request works too: its head comes from the forge, so fixes reach the next deck once they
are pushed.

| Key       | Action                                                      |
| --------- | ----------------------------------------------------------- |
| `a` / `b` | pick side A (left) or side B (right), or drag the card      |
| `n`       | neither side: say what you want instead                     |
| `s`       | skip: leave the decision to reviewers                       |
| `u`       | undo the last pick                                          |
| `e` / `r` | edit a side's justification, or change where it is recorded |
| `o`       | show the code the card is about                             |

When the deck is cleared, the page writes a **fix list** from every pick that disagrees with the
code, and suggests the next command:

```text
/pr-self-review-fix branch
```

It asks you about anything unclear, applies the fixes, writes the justifications you marked for
the code, then deals a fresh deck. Decisions you already settled are carried over and never asked
again, so the next deck shows only the questions the fixes raised.

When you then generate the pull request's canvas (`/pr-review-canvas <n>`), it takes what the
decks for that pull request, or for its branch, settled. The canvas does not ask a settled decision
again unless the code contradicts your pick, and it raises the cards you skipped for reviewers.
Publishing it also posts every **PR comment** justification as your own review, one comment on the
code each concerns. Pass `--skip-self-review-comments` to `pr-review publish` to keep them off.

### Review side

Start the canvas server from the project you want to review:

```bash
pr-review serve
```

Open **http://localhost:3010**, enter a PR number (or follow a link to a local review), and
leave the terminal running while you review. Stop the server with **Ctrl+C**. To use another port, run `pr-review serve --port 3011`.

## Install

You need Node.js 22+, npm, Git, and the CLI for your host:

- GitHub: [GitHub CLI](https://cli.github.com). Sign in with `gh auth login`.
- GitLab: [GitLab CLI (glab)](https://gitlab.com/gitlab-org/cli). Sign in with `glab auth login`.
  Self-hosted GitLab whose hostname does not contain `gitlab` needs `PR_REVIEW_HOST=gitlab`.

Install the command globally once, for use in any project:

```bash
npm install -g @vintasoftware/pr-review-canvas
```

### Upgrade

Run this from a project that has the skill installed:

```bash
pr-review upgrade
```

It updates pr-review, acpx, and the project's skill copies, after showing the plan and asking.
Commit and push any refreshed skill copies so your team uses the same skill. `--yes` skips the
question.

## Set up a project

```bash
cd /path/to/your-project
pr-review install-skill
pr-review doctor --all-checks
```

`install-skill` sets up **both Claude Code and Codex** in one command: `.claude/skills/pr-review-canvas`
and `.agents/skills/pr-review-canvas`, respectively. These are portable copies you can commit to Git.
`pr-review upgrade` refreshes them after the CLI changes. It also adds `.pr-review/settings.yml` to the
project's `.gitignore`. Restart your coding agent if the skill does not appear. Repeat this setup for each project you want to review.

`doctor` checks Git, your GitHub or GitLab remote, the matching CLI (`gh` or `glab`) and its login,
write access to the local canvas directory, and whether installed skills match the current package.
It prints a JSON report with a result for each check and suggested fixes for failures.
`doctor --all-checks` also checks that `acpx` runs and reports its version. Exit code `0` means all
checks passed.

`serve` automatically runs the skill check and warns on stderr if a skill is missing, outdated,
or modified. The warning includes the reinstall command and does not block startup.

### Optional: AI Chat install

To ask questions about a PR inside the canvas, install `acpx` globally:

```bash
npm install -g acpx@latest
acpx --version
pr-review doctor --all-checks
```

Install and sign in to either Claude Code or Codex on the same machine. Start (or restart)
the review server, then choose your agent in **settings**. The chat uses that agent's account.
You can review canvases without installing `acpx`.

## Advanced usage

See the [CLI and configuration reference](docs/reference.md) for detailed options and troubleshooting.

### Export an existing canvas

```bash
pr-review export --pr 123
```

The command prints the zip's absolute path. `export` saves locally; `publish` also shares PR/MR
canvases automatically as compressed comments.

The zip contains `manifest.json` and `review.json`: the PR description, file/hunk metadata,
and generated review notes. Publishing shares this information with everyone who can read the PR/MR. Each reviewer gets source diffs from their own clone; chat history stays local.

### Update an outdated canvas

After pushing new commits, run `/pr-review-canvas 123` again, without `--force`. The run updates
the previous canvas: content for untouched files is kept, and reviewers' progress on them follows.
Publishing updates your canvas comment automatically. Reviewers click **refresh**.

`--force` regenerates from a blank page, whether or not the commit already has a canvas. Use it to
rewrite a canvas for the same commit. Set `canvas.incremental: false` to always start from a blank
page. See [Incremental canvases](docs/reference.md#incremental-canvases).

When the saved canvas describes a different PR head, **Canvas is outdated** appears at
the top. You can still read the older canvas, with its commit and distance shown; posting
from that view is disabled. Click **refresh** to check GitHub or GitLab for changes and a newer canvas.

A head whose diff is identical to the canvas's does not outdate it: after **Update branch**
merged `main` in without touching the changed files, for example, the canvas still applies
and the page says so. Set `canvas.keepForIdenticalDiff: false` in the project config to treat
every commit as a new head.

## Configuration

### User-local preferences

Your appearance, reading level, layer view, and AI Chat preferences are saved in
`.pr-review/settings.yml` in your local project directory. This file is ignored by Git, so each
teammate can use their own settings.

Use **skin** and **theme** in the header to change the appearance, and **Hide code by default**
in the settings dialog to choose how much code a review hides when it opens. Set **Show layers**
to **one at a time** in the same dialog to read the overview or a single layer at once, moving
between layers with the rail or the `j` and `k` keys.

For AI Chat, open **settings**, choose Claude Code or Codex, and optionally enter a model ID.
Leave the model blank to use the agent's default. A model ID runs as the newest model of its family
(`claude-opus-4-8` runs as `opus`); write `pin:claude-opus-4-8` to use that exact model. See
[Model families](docs/reference.md#model-families). You can also adjust the reply timeout and
maximum turns. Click **Test agent** to check the connection, then **save**.

Switching agents starts a new thread and keeps earlier threads. Server flags `--agent` and
`--model` override your saved chat preferences for that run.

### Shared project settings

Edit `pr-review.config.yml` at the repository root and commit it to share settings with your team.
It controls review rules, layers, generation mode, test file patterns, prompt templates, and
whether AI Chat is enabled. The settings dialog displays this configuration; edit the file to
change it. See the [configuration reference](docs/reference.md#project-config).

Canvas generation follows the [skill's model rules](skills/pr-review-canvas/SKILL.md#model-choice).

### Project prompt templates

Customize generation and AI Chat prompts with the `prompts` map in your project's
`pr-review.config.yml`:

```yaml
prompts:
    generation-format.md: review-prompts/generation-format.md
    generation-surfacing.md: review-prompts/generation-surfacing.md
    chat-seed.md: review-prompts/chat-seed.md
```

Copy the installed templates to start editing (for an npm global install):

```bash
mkdir -p review-prompts
cp "$(npm root -g)/@vintasoftware/pr-review-canvas/prompts/"*.md review-prompts/
```

Edit the copies and configure only the templates you want to replace. Paths are relative
to the project root. Omitted entries use the bundled defaults. Keep each template's
`{{TOKENS}}`, including `{{FORMAT}}` in generation wrappers. Commit the config and
referenced files together.

Run `prepare` again to apply generation edits (use `--force` for an existing canvas).
Restart the server after changing the config; chat template edits apply to new threads.

See the [prompt template reference](docs/reference.md#prompt-templates) for supported keys,
path rules, validation, and upgrades.

## Website

The [project website](https://vintasoftware.github.io/pr-review-canvas/) introduces the review workflow with a real PR walkthrough. See [website development and publishing](docs/website.md) for local preview commands and the GitHub Pages deployment workflow.

## Contributing

In a clone of this tool, use pnpm for the shared lockfile and development checks:

```bash
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm hooks:install
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm verify
corepack pnpm start --repo /path/to/your-project
```

The pre-commit hook runs `pnpm precommit`: lint, formatting, strict type checks, and tests.
Any failure blocks the commit. Run `pnpm hooks:install`
once per clone to enable it. Use `pnpm lint:fix` and `pnpm format` to apply automatic fixes.
CI runs the same checks through `pnpm verify`, with coverage executing the unit tests once.

Run the full `pnpm verify` before pushing. Keep branch coverage at least 96% when adding or
changing behavior, leaving a margin above CI's 95% minimum. Cover meaningful failure and boundary
cases rather than lowering thresholds. Each CI job uploads `coverage-node-<version>` with branch
locations and a summary; locally, these reports are in `coverage/` after `pnpm coverage`.

Run `pr-review --help` for CLI commands. Local data goes in the project's `.pr-review/`
directory; keep it out of Git.

See [Publishing to npm](docs/publishing.md) for release checks and first-publish instructions.

## License

Licensed under the [Apache License 2.0](LICENSE).
