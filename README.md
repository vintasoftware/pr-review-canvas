# PR Review Canvas

Review a GitHub pull request canvas: layers by topic, with grouped diffs, attention points, comments,
and an optional AI chat. Everything runs locally at **http://localhost:3010**.

## Quick start: author generates, reviewers review

### Author side

Each PR author should generate a canvas and attach its zip to the **PR description** before
requesting review. After the project setup below, run the installed skill in Claude Code or Codex:

```text
/pr-review-canvas 123
```

Replace **123** with your PR number. The skill reads the PR, generates and validates the canvas,
then returns a local review URL and the exported zip's path. Open the URL to check the canvas.

The skill ends with upload instructions. If you're happy with the produced canvas, edit the PR
description in GitHub's UI, drag the zip into the editor, wait for the upload to finish, and save.
Uploading the zip is a manual browser step due to restrictions of GitHub's API.

### Review side

Start the canvas server from the project you want to review:

```bash
pr-review serve
```

Open **http://localhost:3010**, enter a PR number, and leave the terminal running while you
review. Stop the server with **Ctrl+C**. To use another port, run `pr-review serve --port 3011`.

## Install

You need Node.js 22+, npm, Git, and [GitHub CLI](https://cli.github.com).
Sign in to GitHub with `gh auth login`.

Install the command globally once, for use in any project:

```bash
npm install -g @vintasoftware/pr-review-canvas
```

The npm installation command will be available after the first release.

## Set up a project

```bash
cd /path/to/your-project
pr-review install-skill
pr-review doctor --all-checks
```

`install-skill` sets up **both Claude Code and Codex** in one command: `.claude/skills/pr-review-canvas`
and `.agents/skills/pr-review-canvas`, respectively. It also adds `.pr-review/settings.yml` to the
project's `.gitignore`. Restart your coding agent if the skill
does not appear. Repeat this setup for each project you want to review.

`doctor` checks Git, your GitHub remote, the GitHub CLI and its login, write access to the local
canvas directory, and whether the skill is installed. It prints a JSON report with a result for
each check and suggested fixes for failures. `doctor --all-checks` also checks that `acpx` runs and
reports its version. Exit code `0` means all checks passed.

### Optional: AI Chat install

To ask questions about a PR inside the canvas, install `acpx` globally:

```bash
npm install -g acpx
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

The command prints the zip's absolute path. Both `export` and `publish` save locally; neither
uploads an attachment to GitHub.

The zip contains `manifest.json` and `review.json`: the PR description, file/hunk metadata,
and generated review notes. Check these before sharing, since they can contain private
information. Each reviewer gets source diffs from their own clone; chat history stays local.

### Update an outdated canvas

After pushing new commits, run `/pr-review-canvas 123` again. To rewrite a canvas for the
same commit, run `/pr-review-canvas 123 --force`. Replace the zip in the PR description.
Reviewers click **refresh**.

When the saved canvas describes a different PR head, **Canvas is outdated** appears at
the top. You can still read the older canvas, with its commit and distance shown; posting
from that view is disabled. Click **refresh** to check GitHub for changes and a newer zip.

## Configuration

### User-local preferences

Your appearance and AI Chat preferences are saved in `.pr-review/settings.yml` in your local
project directory. This file is ignored by Git, so each teammate can use their own settings.

Use **skin** and **theme** in the header to change the appearance.

For AI Chat, open **settings**, choose Claude Code or Codex, and optionally enter a model ID.
Leave the model blank to use the agent's default. You can also adjust the reply timeout and
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

A global install reads `pr-review.config.yml` from the project root. Use its `prompts`
map to replace individual templates with files you keep in the project's Git repository:

```yaml
prompts:
  generation-format.md: review-prompts/generation-format.md
  generation-surfacing.md: review-prompts/generation-surfacing.md
  chat-seed.md: review-prompts/chat-seed.md
```

To start from the installed templates (for an npm global install):

```bash
mkdir -p review-prompts
cp "$(npm root -g)/@vintasoftware/pr-review-canvas/prompts/"*.md review-prompts/
```

Edit the copies and add entries only for the templates you want to override. Commit
`pr-review.config.yml` and the referenced files together. Paths resolve from the project
root, including when running from a subdirectory or using `--repo`. Absolute paths also
work for personal templates shared across projects. Omitted entries use the installed
package's defaults; a configured file that cannot be read causes an error.

The six supported keys are `generation-format.md` (schema and output rules),
`generation-strict.md` and `generation-surfacing.md` (mode wrappers),
`quality-standards.md` (bundled code standards), `layering-guidance.md` (semantic grouping guidance),
and `chat-seed.md` (the opening AI Chat instructions). `generation.mode` still selects
the wrapper. The rulebook still takes precedence over code standards, and configured
layers and caps still supply the template data.

Each file replaces a whole template. Preserve its `{{TOKENS}}`, including `{{FORMAT}}`
in generation wrappers, to keep the generated context and output contract. Unknown
generation tokens fail rendering. Chat leaves unknown tokens as written. Prompt edits
do not change the output schema or validation rules enforced by the tool. Overrides
remain yours across tool upgrades; compare them with new bundled templates when upgrading.

Run `prepare` again to apply generation edits (use `--force` for an existing canvas).
Restart the server after changing the config; chat template edits apply to new threads.

## Contributing

In a clone of this tool, use pnpm for the shared lockfile and development checks:

```bash
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm verify
corepack pnpm start --repo /path/to/your-project
```

Run `pr-review --help` for CLI commands. Local data goes in the project's `.pr-review/`
directory; keep it out of Git.

See [Publishing to npm](docs/publishing.md) for release checks and first-publish instructions.

## License

Licensed under the [Apache License 2.0](LICENSE).
