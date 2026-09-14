# PR Review Canvas

Review a GitHub pull request by topic, with grouped diffs, attention points, comments,
and an optional AI chat. Everything runs locally at **http://localhost:3010**.

## Install for a project

You need Node.js 22+, pnpm, Git, and [GitHub CLI](https://cli.github.com), signed in with
`gh auth login`. Your project must have a GitHub `origin` remote.

Until a package is published, install from this repository:

```bash
git clone git@github.com:vintasoftware/pr-review-canvas.git
cd pr-review-canvas
pnpm install

cd /path/to/your-project
pnpm add -D link:/absolute/path/to/pr-review-canvas
pnpm exec pr-review install-skill
pnpm exec pr-review doctor
pnpm exec pr-review serve
```

The skill installer adds project skills for Claude Code and Codex. Restart your coding
agent if the new skill does not appear. Repeat the project commands for each repository.
Keep the tool checkout in place: the project links to it.

## Generate and review

In your coding agent, ask:

```text
/pr-review-canvas 123
```

The skill reads the PR, writes and validates a canvas, then gives you a review URL and a zip.
Open **http://localhost:3010/review/123** to explore the layers and diffs. You can mark layers
reviewed and post comments or a review to GitHub. AI chat additionally needs `acpx` and a
signed-in Claude Code or Codex CLI.

## Share the canvas in a PR comment

**The shared canvas lives in a zip attached to a GitHub PR comment.** Drag the zip the skill
printed into a comment and submit it. Reviewers run the server in their own clone and open
the PR number; the tool finds and imports the attachment automatically. PR description
attachments work too.

The zip contains `manifest.json` and `review.json`: the PR description, file/hunk metadata,
and generated review notes. It does not contain full source patches or local chat history.
Review its contents before sharing; PR descriptions and generated notes can contain private
information. Each reviewer gets the source diffs from their own clone.

## Update an outdated canvas

After pushing new commits, run `/pr-review-canvas 123` again. To rewrite a canvas for the
same commit, run `/pr-review-canvas 123 --force`. Attach the new zip in a new PR comment,
or replace the old attachment by editing its comment. Reviewers click **refresh**.

When the saved canvas describes a different PR head, **Canvas is outdated** appears at
the top. You can still read the older canvas, with its commit and distance shown; posting
from that view is disabled. Click **refresh** to check GitHub for changes and a newer zip.

## Work on the tool

```bash
pnpm test
pnpm typecheck
pnpm exec playwright install chromium
pnpm test:browser
pnpm start --repo /path/to/your-project
```

Run `pnpm exec pr-review --help` for CLI commands. Local data goes in the project's
`.pr-review/` directory; keep it out of Git. The included SHL example is documented in
[the release data review](docs/release-data-review.md).

See the [CLI and configuration reference](docs/reference.md) for more options.

## License

Licensed under the [Apache License 2.0](LICENSE).
