# Changelog

## Unreleased

### Breaking

- Reviewed marks are keyed by the layer's own key instead of its position in the canvas, so a
  regenerated canvas that reorders or renames its layers keeps a reviewer's progress pointing at
  the same concern. Marks in state files written by earlier versions cannot be translated and are
  dropped on first read: a review in progress starts its ticks again. Dismissed attention points,
  posted comments, hidden threads, and chat threads are untouched.

### Canvas generation

- Regenerating a canvas for a new head updates the newest canvas of a commit the head was built
  on, instead of writing one from a blank page. `pr-review prepare` compares that basis canvas's
  diff with the head's file by file and hands the generator two computed lists: what to carry word
  for word (whole layers whose files are all byte-identical, and the notes, folds, annotations and
  attention points of untouched files elsewhere) and what to decide again. A carried attention
  point keeps its kind, path and title, so it keeps its fingerprint and any dismissal with it. The
  summary and the risk tags are always written again. A canvas of a line of work the head no longer
  contains is never a basis.
- Two prompt templates carry the wording of an incremental run, `generation-strict-incremental.md`
  and `generation-surfacing-incremental.md`, selected by `prepare` when it finds a basis canvas.
  Each mode's judging rules, the half of the task that is the same whether a canvas is written or
  updated, moved into `judging-strict.md` and `judging-surfacing.md`, which both of that mode's
  task files end with. All of them are overridable through the `prompts` map like the others.
- `--force` generates from a blank page as before, and the new `canvas.incremental` project setting
  (default `true`) turns the behavior off.
- A canvas records the basis it was generated from, and nothing more. Which of a reviewer's marks
  may follow it is decided on the reviewer's own machine, from the two canvases and their own
  clone. Marks follow the whole line of descent, not one step of it, so marking nothing on an
  intermediate canvas does not strand them: a file's mark follows when that file is in both the
  canvas it was made on and the one on screen under the same layer key with a byte-identical patch,
  and a layer's mark follows only when the layer holds exactly the same files and none of them
  changed. When any mark follows, the page names the canvas it was made on.

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
