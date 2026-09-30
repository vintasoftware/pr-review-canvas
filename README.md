# PR Review Canvas

Review GitHub pull requests and GitLab merge requests with diffs grouped by topic,
attention points, comments, and optional AI chat. The review app runs locally at
**http://localhost:3010**.

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
pr-review install-skill
pr-review doctor --all-checks
```

`install-skill` installs every skill the package ships for Claude Code and Codex, each in its
own directory under `.claude/skills/` and `.agents/skills/`, starting with the generation skill
`pr-review-canvas`. Commit these copies so your team can use them. Restart your coding agent if the skill
does not appear. Repeat this setup for each project.

`doctor --all-checks` checks your repository, host CLI login, local storage, installed
skills, and `acpx` for AI Chat. Follow any hints it prints to fix failed checks.
If only `acpx` is missing, you can still review canvases; install it below to enable chat.

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

## Take the tour, then review

### The tour: the recommended pass before review

A tour is a guided pass over one change that builds your theory of it: landmarks that explain
the change with a picture each, the decisions it makes for you to keep or change, and a short
quiz. The author takes it before asking for review; each reviewer takes the same tour. Run the
installed skill in Claude Code or Codex, replacing `123` with your PR or MR number:

```text
/pr-tour 123
```

The skill reads the project's tour guide (`/pr-tour-setup` writes one, once per project),
generates the tour, checks every landmark as a screenshot, and shares the tour in a PR or MR
comment. Start `pr-review serve` and open **http://localhost:3010/tour/123**: read the landmarks,
keep or change each decision (a change opens the grilling, where AI Chat restates what you want
in your words), take the quiz, and confirm the plan. The tour writes a re-implementation prompt
and records that you toured; `/pr-tour-apply 123` carries the plan out. Tours of local work
(`/pr-tour branch`, `/pr-tour uncommitted`) stay on your machine. See
[the tour](docs/reference.md#the-tour) for the whole flow and its settings.

### Generate a canvas

A canvas is the review itself: the diff grouped into layers with annotations, attention points,
and a test map, read at **http://localhost:3010/review/123**. Run the installed skill with your
PR or MR number:

```text
/pr-review-canvas 123
```

The skill generates and validates the canvas, then shares it in a PR or MR comment using
your `gh` or `glab` login. It returns a local review URL and the comment link.
Anyone with access to the PR or MR can read the shared canvas.

Start the server from your project:

```bash
pr-review serve
```

Open the review URL. Optionally, self-review on the canvas too: for each attention point
marked **yours**, click **resolve** and explain why it needs no reviewer decision. Your reason
stays visible to reviewers. Then request review from your team.

After pushing new commits, run `/pr-review-canvas 123` again to update the canvas.
Reviewers click **refresh** to load it.

See [self-review](docs/reference.md#self-review) for resolution details and
[manual sharing](docs/reference.md#automatic-sharing-and-zip-fallback) if automatic sharing fails.

Before opening a PR, you can generate a canvas for your local work:

```text
/pr-review-canvas branch          # the current branch against the default branch
/pr-review-canvas uncommitted     # includes working-tree edits and new files
```

With `pr-review serve` running, open **http://localhost:3010/review/branch** or
**http://localhost:3010/review/uncommitted**. These reviews stay local, and you can resolve
attention points before sharing your work. Use `--base <ref>` to compare against another branch.
See [local branch and uncommitted reviews](docs/reference.md#reviewing-before-the-pull-request-exists)
for details.

### Reviewing PRs

Run `pr-review serve` from your clone of the project. It opens **http://localhost:3010**.
Enter the PR or MR number to load the shared canvas, read the grouped diffs, and leave comments.
Keep the terminal running while you review; stop the server with **Ctrl+C**.

## Documentation

- [CLI and configuration reference](docs/reference.md): command options and troubleshooting.
- [The tour](docs/reference.md#the-tour): generating, taking, grilling, and applying a tour; the tour guide.
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
