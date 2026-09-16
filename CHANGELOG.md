# Changelog

## Unreleased

### AI chat

- Chat runs the agent inside read-only filesystem containment: bubblewrap on Ubuntu and Ubuntu
  WSL2, Seatbelt on macOS, and Ubuntu WSL2 for Windows 11 hosts. The repository, Git metadata, and
  snapshots are read-only; scratch files and agent sessions live in a separate runtime directory.
- Destructive Command Guard (`dcg`) is mandatory for chat. Native Bash `PreToolUse` hooks in Codex
  and Claude Code evaluate commands through an app-owned policy that also covers cloud, database,
  Kubernetes, Terraform, GitHub Actions, and Cloudflare Workers rules. Denied commands return the
  rule and explanation to the model and the chat UI.
- Chat pins its ACP adapters, protects the Codex hook configuration against writes and renaming,
  and verifies native hook activation before a session starts.
- Sandboxes are prepared and attested asynchronously once per checkout, and complete runtimes are
  published atomically so failed or concurrent starts retry safely.

### Diagnostics and development

- `doctor` prints readable PASS/FAIL checks with installation and repair instructions by default;
  `--json` keeps the structured report. Default checks require `dcg`; `--all-checks` also probes
  the sandbox, `acpx`, and native hook activation.
- Added disposable containment fixtures, offline native-tool tests through both acpx adapters, and
  macOS and Windows (Ubuntu WSL2) CI jobs.

### Upgrade from 0.3.0

1. Install `dcg` following the
   [upstream instructions](https://github.com/Dicklesworthstone/destructive_command_guard#quick-install)
   and verify `dcg --version`. `pr-review doctor` fails without it.
2. For chat, install `acpx@0.13.2` and bubblewrap (Ubuntu and WSL2), then run
   `pr-review doctor --all-checks`. Windows 11 users install Node, `dcg`, `acpx`, and their agent
   inside Ubuntu WSL2. See the README's AI Chat setup.
3. Existing configuration and saved canvases remain compatible; no migration is required.

## 0.3.0

Changes since 0.2.0.

### Review interface

- Review history groups submitted reviews and omits empty comment-only events while retaining
  written reviews and approval, change-request, and dismissal decisions.
- Outdated comments appear below review history with replies, original locations, and GitHub
  links. Current comments remain in the diff without a duplicate overview section.
- Clicking directly on a section chevron now expands or collapses it. Keyboard toggling continues
  to work.
- Improved review and tool-call spacing, removed the empty gutter beside inline comments and
  annotations, and added SVG branding.

### AI chat

- Chat floats on smaller screens and becomes a minimizable modal on mobile, with keyboard focus
  containment and Escape to minimize. Drafts survive minimizing and resizing.
- Quick questions now lead with "Suggestion to solve this?" and include five suggested prompts.

### Diagnostics and development

- `serve` logs internal HTTP and chat-stream failures with the request method, path, status,
  error code, and original error details. Expected client errors stay quiet.
- Added Oxlint, Oxfmt, and a pre-commit hook for lint, formatting, strict type checks, and tests.
  CI runs the same checks, executing unit tests once through coverage per Node.js version.

### Upgrade from 0.2.0

1. Run `npm install -g @vintasoftware/pr-review-canvas@0.3.0` and restart `pr-review serve`.
2. Run `pr-review install-skill` in each project to refresh the bundled skill copy. Preserve any
   customizations first, and repeat custom directory flags if used.
3. Existing configuration and saved canvases remain compatible; no migration is required.
4. Contributors should run `corepack pnpm install --frozen-lockfile` and `corepack pnpm hooks:install`
   in their clone. Use `pnpm lint:fix` and `pnpm format` to apply automatic fixes.

## 0.2.0

Changes since 0.1.0.

### Review layers

- Generation groups related behavior and decisions into semantic layers. Projects without
  configured layers no longer use a fixed set of eight architecture groups.
- Configured layers provide optional descriptions, path hints, and reading order. The generator
  can combine, split, or reorder them to fit the change. Tests stay with the code they cover.
- Prompt customization instructions are shorter, with detailed rules in `docs/reference.md`.

### Skill installation

- `install-skill` creates portable copies for Claude Code and Codex on every platform.
  Re-running it refreshes managed copies and replaces legacy symlinks.
- Installed skills include a content hash. `doctor` reports outdated or modified copies;
  `serve` warns with a repair command while continuing to start.
- Installation prevents overwriting the bundled skill's source directory.

### Canvas exports

- ZIP filenames include the PR number, UTC generation time, eight-character commit prefix,
  and repository: `pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip`.
- Comparisons before a PR exists use `ref-` instead of `pr-<number>-`. Re-exporting a canvas
  keeps its filename. Attachment discovery recognizes the new names.

### Validation

- Expanded unit coverage for review validation, GitHub attachments, server routes, and UI behavior.
- CI retains coverage reports for seven days for both Node.js versions.

### Upgrade from 0.1.0

1. Run `pr-review install-skill` in each project after upgrading. Repeat custom directory flags
   if used. Preserve customized skills before refreshing managed copies, and commit updated copies.
2. Rename the `prompts` config key `layers-default.md` to `layering-guidance.md`. Update any
   custom generation templates from `{{DEFAULT_LAYERS}}` to `{{CONFIGURED_LAYERS}}` and from
   `{{LAYERS_DEFAULT}}` to `{{LAYERING_GUIDANCE}}`. The old config key is rejected and causes
   configuration to fall back to defaults; old generation tokens fail rendering.
3. Re-export shared canvases and replace their attachments to use automatic discovery in 0.2.0.
   Old ZIP filenames are no longer recognized by discovery; existing archives can still be
   imported manually.
4. Run `prepare` again for updated generation prompts, using `--force` for an existing canvas.
   Restart the server after configuration changes.
