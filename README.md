# PR Review Canvas

Review a GitHub pull request by topic, with grouped diffs, attention points, comments,
and an optional AI chat. Everything runs locally at **http://localhost:3010**.

## Install

You need Node.js 22+, npm, Git, and [GitHub CLI](https://cli.github.com).
Sign in to GitHub with `gh auth login`. npm is enough for users; pnpm is used for development.

Install the command globally once, for use in any project:

```bash
npm install -g git+ssh://git@github.com/vintasoftware/pr-review-canvas.git
```

This installs directly from GitHub while the tool is awaiting an npm release. The repository
is currently private, so you need repository access and GitHub SSH authentication.

## Set up a project

From a project clone with a GitHub `origin` remote:

```bash
cd /path/to/your-project
pr-review install-skill
pr-review doctor
```

`install-skill` sets up **both Claude Code and Codex** in one command: `.claude/skills/pr-review-canvas`
and `.agents/skills/pr-review-canvas`, respectively. Restart your coding agent if the skill
does not appear. Repeat this setup for each project you want to review.

Canvas generation defaults to Sonnet in Claude Code. The skill directs reviews of authentication,
access policy, or protected health information (PHI) handling to an Opus agent when available,
and honors an explicit model request. Other hosts keep their selected model. The publish command's
`--model` flag records the generator; it does not select a model.

`doctor` checks Git, your GitHub remote, the GitHub CLI and its login, write access to the local
canvas directory, and whether the skill is installed. It prints a JSON report with a result for
each check and suggested fixes for failures. Exit code `0` means all checks passed.

### Optional: AI Chat

To ask questions about a PR inside the canvas, install `acpx` globally:

```bash
npm install -g acpx
acpx --version
pr-review doctor --all-checks
```

Install and sign in to either Claude Code or Codex on the same machine. Start (or restart)
the review server, then choose your agent in **settings**. The chat uses that agent's account.
`doctor --all-checks` also checks that `acpx` runs and reports its version. A failed check
returns exit code `1` with an installation hint. Agent login is checked when you use chat.
You can review canvases without installing `acpx`.

## Run

Start the server from the project you want to review:

```bash
pr-review serve
```

Open **http://localhost:3010**, enter a PR number, and leave the terminal running while you
review. Stop the server with **Ctrl+C**. To use another port, run `pr-review serve --port 3011`.

## Settings

Use the header's **skin** button to choose Terminal or GitHub styling, and **theme** to choose
Light, Dark, or Auto (your system preference).

For AI Chat, open **settings** in the header:

- **Agent:** Claude Code or Codex. Switching agents starts a new thread and keeps earlier threads.
- **Model:** enter a model ID, or leave it blank to use the agent's default.
- **Chat timeout:** seconds allowed for a reply; default 600, allowed range 30–3600.
- **Max turns:** limit the agent's steps per reply (1–100), or leave blank for its default.
- **Test agent:** send a small request to check that the selected agent can respond. Then **save** your settings.

Preferences are saved in the project's local `.pr-review/settings.yml`. Server flags `--agent`
and `--model` override saved values for that run. The dialog also shows project configuration;
edit `pr-review.config.yml` to change it. See the [configuration reference](docs/reference.md).

## Suggested workflow: author generates, reviewers review

Each PR author should generate a canvas and attach its zip to the **PR description** before
requesting review. After the project setup above, run the installed skill in Claude Code or Codex:

```text
/pr-review-canvas 123
```

Replace **123** with your PR number. The skill reads the PR, generates and validates the canvas,
then returns a local review URL and the exported zip's path. Open the URL to check the canvas,
then drag the zip into the PR description in GitHub and save it. Generating and exporting take
one skill invocation; attaching the file is a manual browser step.

Reviewers start `pr-review serve` in their own clone and open the PR number. The tool finds and
imports the attachment automatically. They can explore layers and diffs, ask AI Chat questions,
mark layers reviewed, and preview and post comments or a review to GitHub. Attachments in PR
comments are also supported, but keeping the current zip in the description makes it easy to find.

### Export an existing canvas

```bash
pr-review export --pr 123
```

The command prints the zip's absolute path. Both `export` and `publish` save locally; neither
uploads an attachment to GitHub.

The zip contains `manifest.json` and `review.json`: the PR description, file/hunk metadata,
and generated review notes. Check these before sharing, since they can contain private
information. Each reviewer gets source diffs from their own clone; chat history stays local.

## Update an outdated canvas

After pushing new commits, run `/pr-review-canvas 123` again. To rewrite a canvas for the
same commit, run `/pr-review-canvas 123 --force`. Replace the zip in the PR description.
Reviewers click **refresh**.

When the saved canvas describes a different PR head, **Canvas is outdated** appears at
the top. You can still read the older canvas, with its commit and distance shown; posting
from that view is disabled. Click **refresh** to check GitHub for changes and a newer zip.

## Work on the tool

In a clone of this tool, use pnpm for the shared lockfile and development checks:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm exec playwright install chromium
pnpm test:browser
pnpm start --repo /path/to/your-project
```

Run `pr-review --help` for CLI commands. Local data goes in the project's `.pr-review/`
directory; keep it out of Git. See the [CLI and configuration reference](docs/reference.md)
for more options and [the release data review](docs/release-data-review.md) for the SHL example.

## License

Licensed under the [Apache License 2.0](LICENSE).
