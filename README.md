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

### Review side

Start the canvas server from the project you want to review:

```bash
pr-review serve
```

Open **http://localhost:3010**, enter a PR number, and leave the terminal running while you
review. Stop the server with **Ctrl+C**. To use another port, run `pr-review serve --port 3011`.

## Install

You need Node.js 22+, npm, Git, and the CLI for your host:

- GitHub: [GitHub CLI](https://cli.github.com). Sign in with `gh auth login`.
- GitLab: [GitLab CLI (glab)](https://gitlab.com/gitlab-org/cli). Sign in with `glab auth login`.
  Self-hosted GitLab whose hostname does not contain `gitlab` needs `PR_REVIEW_HOST=gitlab`.

Install the command globally once, for use in any project:

```bash
npm install -g @vintasoftware/pr-review-canvas
```

## Set up a project

```bash
cd /path/to/your-project
pr-review install-skill
pr-review doctor --all-checks
```

`install-skill` sets up **both Claude Code and Codex** in one command: `.claude/skills/pr-review-canvas`
and `.agents/skills/pr-review-canvas`, respectively. These are portable copies you can commit to Git.
Re-run `pr-review install-skill` after upgrading the CLI to refresh them. It also adds `.pr-review/settings.yml` to the
project's `.gitignore`. Restart your coding agent if the skill
does not appear. Repeat this setup for each project you want to review.

`doctor` checks Git, your GitHub or GitLab remote, the matching CLI (`gh` or `glab`) and its login,
write access to the local canvas directory, whether installed skills match the current package, and
**Destructive Command Guard (`dcg`)**. Install dcg using
the [upstream installation instructions](https://github.com/Dicklesworthstone/destructive_command_guard#quick-install)
and verify `dcg --version`. Doctor fails with exit code `1` and an installation hint when dcg
is missing, fails to run, or fails the required chat policy probes. The probes evaluate command
strings without executing them. Doctor prints readable PASS/FAIL results and installation or
repair instructions for each failure. Exit code `0` means all requested checks passed.
Use `pr-review doctor --json` for the structured report, or
`pr-review doctor --all-checks --json` to include chat checks.

Chat enables remote-service rules through its bundled dcg policy, even if your personal dcg
configuration leaves them disabled. You do not install these rules separately. If the installed
dcg cannot evaluate them, doctor fails and explains how to upgrade dcg or restore the app's policy.

`serve` automatically runs the skill check and warns on stderr if a skill is missing, outdated,
or modified. The warning includes the reinstall command and does not block startup.

### AI Chat setup

AI Chat supports macOS, Ubuntu (including WSL2), and Windows 11 using an Ubuntu WSL2 backend.
Install `acpx` globally in the environment that runs the agent:

```bash
npm install -g acpx@0.13.2
acpx --version
pr-review doctor --all-checks
```

Install and sign in to either Claude Code or Codex in that environment. Start (or restart)
the review server, then choose your agent in **settings**. The chat uses that agent's account.
`doctor --all-checks` also checks acpx, exercises the OS sandbox, and verifies native hook
activation for each installed agent. A failed check
returns exit code `1` with an installation hint. Agent login is checked when you use chat.
You can review canvases without installing `acpx`.

The tested versions are **dcg 0.6.5, Codex 0.154.0, and Claude Code 2.1.272**. Chat pins its
ACP adapters to `codex-acp` 1.11.0 and `claude-agent-acp` 0.60.0. Install at least one native
agent; a version that cannot activate the required hook cannot start chat.

#### Platform setup

- **Ubuntu / Ubuntu WSL2:** install bubblewrap with `sudo apt-get install bubblewrap`.
  Unprivileged user namespaces must be available; doctor reports when the OS blocks them.
- **macOS:** chat uses the system `/usr/bin/sandbox-exec` facility. Doctor verifies that it
  can start a sandbox. No bubblewrap installation is needed.
- **Windows 11:** install Ubuntu WSL2 with `wsl --install -d Ubuntu`. Inside Ubuntu, install
  Linux Node **22.18+ or 24+**, bubblewrap, dcg, acpx, and your agent, then sign in there.
  The Windows server runs chat and its agent/login checks through `wsl.exe`; a Windows-only
  agent or dcg installation does not satisfy those checks. Use the default Ubuntu distribution,
  or set `PR_REVIEW_WSL_DISTRO` to its exact name (for example `Ubuntu-24.04`).
  Verify from PowerShell that `wsl --exec node --version`, `wsl --exec acpx --version`, and
  `wsl --exec dcg --version` work. Tools must be on WSL's non-interactive PATH. Repository and
  snapshot paths are translated with `wslpath`, including paths containing spaces.

#### What chat can write

The repository, Git metadata, PR snapshots, and other host files are read-only to the agent
process and its children. A separate runtime directory holds scratch files, caches, and agent
sessions: `~/.local/state/pr-review-canvas/chat/<checkout-hash>/` in the agent's environment
(inside WSL on Windows). Linux exposes it at `/run/pr-review-runtime-<uid>`; macOS uses its real path.
Chat copies initial login files into this isolated environment. Codex uses an app-owned,
read-only configuration that trusts only the exact dcg hook. Claude receives app-owned launch
settings; its native CLI does not load personal or project settings. Configure the chat model
through the review app. Custom settings and hooks from your normal agent sessions are not a
substitute for the required chat guard.
Login refreshes stay there; if credentials become stale, stop the server, remove that checkout's
runtime directory, sign in again, and restart.

After a Codex upgrade or a guard configuration change, doctor may ask you to reset that
checkout's runtime so it can install the new exact hook trust. This removes its isolated agent
sessions and caches. Stop the server before resetting it.

#### Required command guard

**dcg is mandatory for chat.** Chat checks its policy before launch and installs a native
`PreToolUse` hook for Bash commands in both agents. The hook checks commands before execution
and returns the matching rule and explanation when it denies one. Claude's failed tool status
and Codex's guard notice show the short denial; the agent receives the full explanation. Missing dcg, evaluator errors,
invalid results, and evaluation timeouts block commands. There is no chat setting to opt out.

The bundled policy enables Git/filesystem rules plus AWS, Google Cloud, Azure, Kubernetes,
Terraform, database, GitHub Actions, and Cloudflare Workers rules. For example, it blocks
recognized bucket deletion, namespace deletion, and infrastructure destruction commands.
Personal dcg settings and allowlists do not control this policy.

The filesystem sandbox remains required and has no unsandboxed fallback. WSL chat cannot
launch Windows executables through WSL interop. Network access remains enabled for inference.
dcg is a command-pattern guard, not a network firewall: it does not authorize arbitrary SDK,
MCP, or HTTP requests, and cannot guarantee prevention of every remote side effect. Hook
coverage and hook-process failures also depend on the native agent. The OS sandbox protects
local files independently of hooks.

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

After pushing new commits, run `/pr-review-canvas 123` again. To rewrite a canvas for the
same commit, run `/pr-review-canvas 123 --force`. Publishing updates your canvas comment automatically.
Reviewers click **refresh**.

When the saved canvas describes a different PR head, **Canvas is outdated** appears at
the top. You can still read the older canvas, with its commit and distance shown; posting
from that view is disabled. Click **refresh** to check GitHub or GitLab for changes and a newer canvas.

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
