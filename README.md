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
canvas directory, the review skill, and **Destructive Command Guard (`dcg`)**. Install dcg using
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
