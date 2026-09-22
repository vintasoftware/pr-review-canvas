# Changelog

## Unreleased

### Pending reviews

- A comment on a diff line can go into a pending review instead of out on its own: **start a
  review** holds it locally. Once a review is open, **add review comment** is the only way out of
  the box, because a single comment would publish ahead of the review still being written. The
  drafts are part of the review state, so they survive a reload, and nothing reaches the forge
  until the review is submitted.
- An attention point can join the review too, with **add to review** next to **post to github**.
  It keeps both while a review is open, because its text is written in advance. Once the review
  lands, the point shows the comment it became, as it does when posted directly.
- A bar under the progress line says how many comments are waiting and offers to finish or discard
  the review; each draft is drawn on its line with a **pending** badge and commands to edit or
  delete it.
- Submitting a review sends the drafts with it: on GitHub as the comments of the one call that
  creates the review, so they land as a single review; on GitLab through native draft-note batch
  publication. Existing GitLab drafts must be finished first. A refused batch retains local drafts;
  a separate approval failure after publication is reported without submitting comments again.

### Reading levels

- Three reading levels, with one **Hide code** control beside the review progress, which names what
  the chosen level hides and how much of the diff that is. The generator gives each fold and each
  collapsed file the lowest level at which it hides, and the levels nest: `light` is the diff as it
  always looked — imports, whitespace, moves, and wholly generated files; `moderate` also hides test
  bodies under their titles, helpers, adapters, and wiring; `aggressive` also hides any block its
  title explains, so a low-risk change reads as pseudo-code. The page opens at the level saved as
  `foldLevel` in `.pr-review/settings.yml`, `light` until changed; the **Hide code by default**
  field of the settings dialog sets it. The control and `f`, which steps through the levels, change
  the level for one page only. Each layer and the sign-off dialog report how many diff lines are
  hidden.
- Attention points, comment threads and pending review drafts stay visible at every level; a file
  with a thread or a draft folds nothing. An annotation may only be hidden by an aggressive fold
  that covers it whole and no other annotation; the fold then shows the annotation's text instead of
  its title. A file with an annotation or an attention point never collapses.
- The validator holds the generator to the shape of the levels: `collapsed` names a level, nothing
  in a hand-written test file hides at `light` (snapshots and fixtures may), a `light` fold covers
  at most 40 lines of generated content, and a file with over 20 lines outside its annotations, no
  attention point, and nothing hidden fails with `FOLD_MISSING`, as does an open file over 60 lines
  that folds less than half of its lines outside attention points by `aggressive`. An annotation
  marks what to read; it does not excuse the rows around it, and annotated rows count towards the
  half because an aggressive fold may hide them. A stored `review.json` is held to the correctness
  rules only, because an older canvas predates the rest.
- A layer of more than 100 changed lines that leaves more than 20 lines open at `moderate` and hides
  nothing more at `aggressive` fails with `FOLD_MISSING` too. A smaller layer reads whole, and only
  the file rules apply to it.
- The built-in test patterns now match test directories (`tests/`, `test/`) and file-name shapes
  (`*_test.*`, `*_spec.*`, `test_*.py`, `conftest.py`, and `*Test`/`*Tests` in Java, Kotlin, Scala,
  Groovy, C#, F#, VB, Swift and PHP) across stacks, not only the JavaScript conventions, so a
  repository without a `pr-review.config.yml` gets its tests labelled, ordered, and kept open at
  light.

### Sign-off

- A third verdict, **comment**, posts a review with no approval or rejection, next to the existing
  **approve** and **request changes**, each of which already carries an editable review body.
  Only approval still asks that every layer was read.

### Breaking

- A canvas written before the reading levels, with `collapsed: true` and folds without a level,
  still opens and reads as `light`, so it hides exactly what it hid before. A canvas this version
  writes names its levels (`collapsed: "moderate"`), which an earlier version cannot read: its zip
  import fails with `CANVAS_INVALID`, and a stored copy does not load. A team that shares canvases
  upgrades together.
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

### Upgrades

- `pr-review upgrade` upgrades pr-review and acpx with `npm install -g` when npm has newer
  versions. It also refreshes the project's skill copies that no longer match the installed
  pr-review. It lists the changes and asks first, or applies them with `--yes`. When a skill copy
  changes, it says to commit and push it. `doctor` and `serve` now suggest it for a stale skill.

### AI chat

- A saved model runs as the newest model of its family. A versioned Claude ID such as
  `claude-opus-4-8[1m]` runs as the `opus[1m]` alias, and a GPT model that the Codex catalog marks
  as replaced runs as its replacement, even when the new model has a different name
  (`gpt-5.6-terra` runs as `gpt-6-sol`). With no saved model, a thread still on a replaced model
  moves to its replacement. `pin:<id>` sends one exact model ID as written, for either agent;
  Bedrock and Vertex Claude IDs run as written too.
- Claude chat runs through the `claude` CLI on PATH instead of the older Claude Code bundled with
  acpx's adapter, so `opus` means the model Claude Code itself uses. Set `CLAUDE_CODE_EXECUTABLE`
  to choose another binary.
- The settings dialog suggests family aliases for Claude and the current GPT models for Codex.

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
