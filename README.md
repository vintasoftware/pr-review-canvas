# PR Review Canvas

Review GitHub pull requests and GitLab merge requests with diffs grouped by topic,
attention points, comments, and optional AI chat. The review app runs locally at
**http://localhost:3010**: one server for all your projects.

## Install

You need Node.js 22+, npm, Git, and the CLI for your host:

- GitHub: [GitHub CLI](https://cli.github.com). Sign in with `gh auth login`.
- GitLab: [GitLab CLI (glab)](https://gitlab.com/gitlab-org/cli). Sign in with `glab auth login`.
  For self-hosted GitLab whose hostname does not contain `gitlab`, set `PR_REVIEW_HOST=gitlab`.

Install the command globally:

```bash
npm install -g @vintasoftware/pr-review-canvas
```

To update an existing installation and its project skills, run `pr-review upgrade` from
that project. See [upgrade options](docs/reference.md#upgrade-options).

## Set up a project

Run these commands in the repository you want to review:

```bash
cd /path/to/your-project
pr-review doctor --all-checks
```

`doctor --all-checks` checks your repository, host CLI login, local storage, the project's
skill, and `acpx` for AI Chat. Follow any hints it prints to fix failed checks.
If only `acpx` is missing, you can still review canvases; install it below to enable chat.
If only the skill is missing, you can still generate from the review app, which uses the skill
pr-review ships.

### Optional: install the skill

Install the generation skill to run `/pr-review-canvas` in Claude Code or Codex, or to
customize it for the project:

```bash
pr-review install-skill
```

`install-skill` copies the skill to `.claude/skills/pr-review-canvas` and
`.agents/skills/pr-review-canvas`. Commit these copies so your team can use them. Restart your
coding agent if the skill does not appear. Repeat this for each project.

Generations from the review app follow the project's copy when there is one, with any changes
the project made to it. `pr-review upgrade` replaces a changed copy with the shipped skill, so
commit your changes before you upgrade.

### Optional: AI Chat install

To ask questions about a PR inside the canvas, install `acpx` globally:

```bash
npm install -g acpx@latest
acpx --version
pr-review doctor --all-checks
```

Install and sign in to Claude Code or Codex on the same machine. Start or restart the
review server, then choose the **Chat agent** in **settings**. Chat uses that agent's account.
See [AI Chat](docs/reference.md#ai-chat) for model settings and review checkouts.

## Generate and review a canvas

### Self-reviewing your PRs

With the [skill installed](#optional-install-the-skill), run it in Claude Code or Codex,
replacing `123` with your PR or MR number:

```text
/pr-review-canvas 123
```

The skill generates and validates the canvas, then shares it in a PR or MR comment using
your `gh` or `glab` login. It returns a local review URL and the comment link.
Anyone with access to the PR or MR can read the shared canvas.

Start the server from your project; it opens the review in the browser:

```bash
pr-review serve
```

Open the review URL. For each attention point marked **yours**, click **resolve** and
explain why it needs no reviewer decision. Your reason stays visible to reviewers.
Then request review from your team.

After pushing new commits, run `/pr-review-canvas 123` again to update the canvas.
Reviewers click **refresh** to load it.

With [AI Chat](#optional-ai-chat-install) installed, you can also generate from the review app,
with or without the skill installed:
click **generate canvas** on the home page or on a review with no canvas, or
**generate for current head** on an outdated one. See
[generating from the review app](docs/reference.md#generating-from-the-review-app).

See [self-review](docs/reference.md#self-review) for resolution details and
[manual sharing](docs/reference.md#automatic-sharing-and-zip-fallback) if automatic sharing fails.

Before opening a PR, you can generate a canvas for your local work:

```text
/pr-review-canvas branch          # the current branch against the default branch
/pr-review-canvas uncommitted     # includes working-tree edits and new files
```

With `pr-review serve` running, the project's home page, where `serve` opens, links to them under
**Before the pull request**; **http://localhost:3010** lists every project. These reviews stay
local, and you can resolve attention points before sharing your work. Use `--base <ref>` to compare against another branch.
See [local branch and uncommitted reviews](docs/reference.md#reviewing-before-the-pull-request-exists)
for details.

### Reviewing PRs

Run `pr-review serve` from your clone of the project. It opens the project in the browser: enter
the PR or MR number to load the shared canvas, read the grouped diffs, and leave comments. When the
checked-out branch is the head of an open PR or MR, as in a worktree made for that review, the
project opens on that review directly. Keep the terminal running while you review; stop the server
with **Ctrl+C**.

One server serves every project. With it running, `pr-review serve` or `pr-review open` in
another project's folder adds that project to it, and `pr-review open 123` opens one PR or MR.
Each project answers at `http://localhost:3010/r/<owner>/<repo>/`, and a linked worktree at
`/r/<owner>/<repo>~<worktree>/`, because its branch and working tree differ.
**http://localhost:3010** lists them, and the logo on every page leads there; **remove** takes a
project off the list without touching its data.

## Documentation

- [CLI and configuration reference](docs/reference.md): command options and troubleshooting.
- [Project settings](docs/reference.md#project-config) and [prompt templates](docs/reference.md#prompt-templates): customize generation and review rules.
- [Review controls](docs/reference.md#review-controls): navigation, comments, and sign-off.
- [AI Chat](docs/reference.md#ai-chat): setup and review checkouts.
- [Local preferences](docs/reference.md#local-settings-and-storage): appearance and chat settings.
- [Incremental canvases](docs/reference.md#incremental-canvases): updates and saved review progress.
- [Export and import](docs/reference.md#export-and-import-options): save and share canvases manually.
- [Project website](https://vintasoftware.github.io/pr-review-canvas/): an interactive review walkthrough.

## Contributing

See the [contributor guide](docs/contributing.md) for development setup and checks,
[website guide](docs/website.md) for previews and deployment, and
[publishing guide](docs/publishing.md) for releases.

## License

Licensed under the [Apache License 2.0](LICENSE).
