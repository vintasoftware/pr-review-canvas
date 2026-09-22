# Changelog

## Unreleased

### Review interface

- AI Chat minimizes at any width. On a wide screen the docked pane drops out of the layout, the
  canvas takes the width, and the launcher brings the chat back with its draft and transcript.
  The minimized state is remembered per browser, beside the pane width.
- Restoring the chat leaves the canvas where the reader left it, instead of scrolling down to the
  composer it focuses.
- The minimize command sits at the right edge of the chat header, where it stays when the header
  wraps.
- A quick-question menu opened from a command near the window edge stays inside the window, and
  hangs above a command with no room below it.
- A **Show layers** field in the settings dialog, saved as `layerView` in `.pr-review/settings.yml`.
  At `one at a time` the canvas shows the overview or a single layer, so the page scrolls through
  one layer only; the rail moves between them and marks the one that shows, `j` and `k` step
  through the layers, and a link into a layer shows that layer first. The save applies to the
  open page. The default, `all`, is the canvas as one page.

## 0.4.0

Changes since 0.3.0.

### Review before the pull request

- Two reviews of the work in a clone, each a target of its own: `pr-review prepare --branch` for
  the tip of the current branch, and `pr-review prepare --uncommitted` for the working tree with
  its edits and untracked files on top. Both compare against the default branch, read from
  `origin/HEAD`, and `--base <ref>` overrides it.
- `--uncommitted` stages the working tree into an index of this tool's own and writes a commit
  anchored at `refs/worktree/pr-review-snapshot`, and publishing anchors that canvas's commit
  under `refs/worktree/pr-review-canvas/`, so nothing the user staged is touched and the
  same tree always hashes to the same commit. Both the index and the anchor are per worktree, so
  worktrees of one clone keep their own snapshots. Changing the head afterwards makes the canvas stale, as a push
  does for a pull request.
- The canvases are served at `/review/branch` and `/review/uncommitted`, and the home page links
  to whichever exist. Each keeps its own review progress and chat threads. Attention points and
  the AI chat work there; comments, sign-off, canvas import, and attachment discovery are refused,
  because local work is on no forge.
- `/pr-review-canvas branch` and `/pr-review-canvas uncommitted` run the whole flow from Claude
  Code or Codex.

### Review interface

- A canvas is carried over to a later pull request head whose diff is identical to the one it
  was generated from, as after merging the base branch in without touching the changed files.
  The page shows it under a **Canvas still applies** note, review progress carries over, and
  sign-off keeps working. The new `canvas.keepForIdenticalDiff` project setting (default `true`)
  turns this off. The note says how many commits later the head is, when the head was built on
  the canvas's commit.
- `pr-review publish` accepts a head whose diff is identical to the prepared commit's, instead of
  failing with `CANVAS_STALE`.
- `pr-review import` and the canvas zips discovered on a pull request read the same rule, so the
  CLI no longer reports a canvas as stale that the page shows as current.

### Canvas sharing

- `pr-review publish` now shares PR/MR canvases automatically in a compressed comment and
  updates the current account's existing canvas comment on subsequent publishes. The payload
  is readable by anyone with access to the PR/MR. Oversized canvases can still be shared as ZIPs.
- Discovery reads both compressed canvas comments and existing ZIP links.
- Import rejects a canvas exported for a different pull request, including with `--force`.

### AI chat

- The chat works on an outdated canvas again: it answers about the canvas on screen, with the
  diff of that canvas's commit, instead of refusing with `CANVAS_NOT_FOUND` after every new commit.

### Hosts

- GitLab merge requests work through the [GitLab CLI (`glab`)](https://gitlab.com/gitlab-org/cli),
  alongside GitHub pull requests through `gh`. Origin detection covers gitlab.com, hostnames that
  contain `gitlab`, and self-hosted GitLab via `PR_REVIEW_HOST=gitlab`.
- Nested GitLab groups (`group/subgroup/project`) are stored as the repository owner.
- Comments, inline discussions, approvals, and canvas-zip discovery use GitLab's REST API.
  Request-changes posts the review body as a merge request note.
- New error codes: `GLAB_MISSING`, `GLAB_UNAUTHENTICATED`, `GITLAB_API_ERROR`. Exit code `4` covers
  both CLIs.

### Fixes

- Git commands select the requested project even when launched from a Git hook with inherited
  repository environment variables.
- GitHub attachment images render as external links, and Markdown comment editing uses a
  single Write/Preview toggle.

### Upgrade from 0.3.0

1. Run `npm install -g @vintasoftware/pr-review-canvas@0.4.0` and restart `pr-review serve`.
2. Run `pr-review install-skill` in each project to refresh the bundled skill. Preserve any
   customizations first, and repeat custom directory flags if used.
3. Publishing a PR/MR canvas now posts or updates a comment automatically. Use `pr-review export`
   when you only want a local ZIP.
4. For GitLab projects, install and authenticate `glab`. Set `PR_REVIEW_HOST=gitlab` for
   self-hosted instances whose hostname does not contain `gitlab`.
5. Local branch and uncommitted reviews need an `origin/HEAD` default branch or an explicit
   `--base <ref>`.

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
