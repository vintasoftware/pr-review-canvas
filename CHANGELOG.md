# Changelog

## Unreleased

### The tour

- A tour is a guided pass over one change, apart from the canvas: landmarks with a generated
  scene each (one may be a micro-world to play with), decisions to keep or change, and a quiz.
  `/pr-tour <n|branch|uncommitted>` generates and shares it; `/pr-tour-setup` writes the
  project's tour guide; `/pr-tour-apply` carries the confirmed plan out. `pr-review tour
prepare|validate|preview|publish|plan` are the steps. The design is ADR 0005; scenes run in a
  sandboxed frame (ADR 0006).
- The page is `/tour/<n|branch|uncommitted>`: every step a history entry, keyboard and phone
  parity, the code behind a landmark as a literate or raw diff, a note per landmark, and a plan
  that writes the re-implementation prompt and shares who toured on the pull request. A change
  pick is grilled through AI Chat in the tour's own thread, with a restatement card to approve,
  edit, or reject, a reverse quiz, and speech input with a one-time notice.
- A reviewer's approved changes go into their pending review as comments on the decisions'
  lines; the author's kept reasons that belong on the pull request post as inline comments.
- Config: `tour:` in `pr-review.config.yml` (budget, quiz, grilling, audio, micro-world, try-it,
  categories, sharing, models, guide); `tourComment` in `.pr-review/settings.yml`; prompt
  templates `tour.md` and `tour-grill.md`.
- Skill install, doctor, and upgrade handle every bundled skill.

## 0.6.1

Changes since 0.6.0.

### CLI output

- `install-skill`, `export`, `import`, `clean`, and `upgrade` print text at a terminal, and an
  unknown command or any other failure prints `error:` and `hint:` lines on stderr. `--json`, or a
  stdout that is a pipe, keeps the JSON line. `prepare`, `validate`, and `publish` always print
  JSON.

### Skins

- New `olive` skin: GitHub's layout in the project site's palette. Set `skin: olive` in
  `.pr-review/settings.yml` or cycle with the skin command (terminal, github, olive).
- The `github` skin has clearer section and file separation.

### Project

- The project site shows the canvas in the olive skin and mentions self-review, generation models,
  and GitLab.
- CSS is linted with stylelint, plus a check for unused CSS.

## 0.6.0

Changes since 0.5.0.

### Self-review

- Every attention point names its audience: **author** (shown as **yours** to the author) or
  **reviewer**. Points in canvases from earlier versions are all the reviewer's.
- The PR author can **resolve** an author point with a reason, and **reopen** it later. A resolved
  point leaves every reviewer's list and its reason is shown under the overview. The author can
  also post the reason as a comment on the point's line. Only the PR author can resolve.
- The canvas comment counts the points left for the reviewer and the ones the author resolved.
- Resolutions survive regenerating the same commit and follow carried points into incremental
  canvases. **Refresh** imports a canvas the author revised at the same commit.
- The skill ends by handing the author the self-review.

### Sharing

- `sharing.canvasComment: false` in `pr-review.config.yml` keeps canvases local: `publish` posts
  no PR/MR comment.
- `sharing.mentionCanvas: false` removes the `from the pr-review canvas` credit from posted
  comments and leaves the sign-off body empty.
- Each person can override either switch in `.pr-review/settings.yml`.

### Canvas generation

- `generation.models` in `pr-review.config.yml` sets the model each agent generates with
  (`claude: opus`). Claude now generates with Opus by default. The skill no longer pins Sonnet.
- `validate --fix` repairs fold errors that have only one correct fix: it clips folds to their
  chunk, drops repeated folds, and shrinks folds that cover an attention point.
- Incremental canvases keep an attention point in a changed file when its own lines are unchanged
  or only moved.
- `validate` and `publish` use the data dir that holds the canvas, so a canvas prepared with
  `--data-dir` no longer lands in the main checkout. `publish` fails with `CANVAS_ELSEWHERE` when
  the canvas is outside its data dir.

### AI Chat

- AI Chat reads code from a review checkout: a git worktree at the reviewed commit, so files the
  PR did not change come from the PR, not your current branch. Uncommitted reviews still read your
  working tree.
- `checkoutEnabled`, `checkoutIdleDays`, and `checkoutSweepMinutes` in `.pr-review/settings.yml`
  control review checkouts. `serve` removes idle ones.
- A proposed comment offers **add to review** next to **post to github**.
- The settings keys `agent` and `model` are renamed to `chatAgent` and `chatModel`. Old files
  still work and are renamed on the next save.
- Threads started before this version start a new agent session on their next turn.

### CLI

- `pr-review clean [--all | --older-than <days>] [--dry-run]` removes idle review checkouts.
- `pr-review --help` wraps to the terminal, and `pr-review <command> --help` shows that command.
- `pr-review doctor` prints a checklist. `--json` prints it as one JSON line.
- `serve --chat-agent` and `--chat-model` replace `--agent` and `--model`, which still work with
  a deprecation notice.
- `serve` opens the canvas in the browser. Pass `--no-open` to skip it.

### Review interface

- **Show layers: one at a time** in **settings** shows the overview or a single layer. The rail,
  `j`, and `k` move between layers. The default, `all`, keeps one page.
- The settings dialog has **Reading**, **AI Chat**, **Checkouts**, and **Project** tabs.
- Click a file's name to collapse or open its card. Folds show a chevron and how many lines they
  hide.
- **Canvas is outdated**, **Canvas still applies**, and **Review progress carried over** can be
  dismissed. Only the outdated warning stays pinned to the top.
- The page asks before a refresh discards an unfinished comment or chat message.

### Fixes

- `j`/`k` and `n`/`p` land on the top of the next layer or file, and start from what is on
  screen. `]`/`[` follow page order and reach points in the Other layer. `R`, `o`, and `c` act on
  the focused point. Shortcuts work with AltGr keyboard layouts.
- File, line, and hunk links land on their target, including code in later or collapsed layers.
- Opening a canvas no longer fails with `cannot lock ref` when fetches overlap. pr-review no
  longer updates your remote-tracking branches.
- Concurrent CLI and server writes no longer overwrite each other's canvas index entries.
- Submitted AI Chat proposals keep their **view comment** link after reload and after later
  commits move the commented lines.
- Chat answers no longer run words together after a tool call.

### Breaking changes

- 0.5.0 opens 0.6.0 canvases but ignores resolutions, so resolved points show as open. Teams
  should upgrade together.
- `pr-review doctor` prints a checklist instead of a JSON line. Pass `--json` for the JSON line.

### Upgrade from 0.5.0

1. Run `pr-review upgrade` in each project. It updates pr-review, acpx, and the skill copies.
   Commit the skill copies, then restart `pr-review serve`.
2. Upgrade the whole team together. 0.5.0 opens 0.6.0 canvases but shows resolved points as open.
3. Scripts that read `pr-review doctor` output should pass `--json`. Scripts that pass
   `serve --agent` or `--model` should switch to `--chat-agent` and `--chat-model`.
4. Claude now generates canvases with Opus. To keep another model, set it under
   `generation.models` in `pr-review.config.yml` (for example `claude: sonnet`).
5. If you override `generation-format.md` or the `*-incremental.md` templates, merge in this
   release's changes so generated points name their audience.

## 0.5.0

Changes since 0.4.0. Details are in the [reference](docs/reference.md).

### Pending reviews

- **start a review** holds diff comments locally until you submit them together as one review.
  Attention points can join with **add to review**. Drafts survive a reload.
- On GitHub the drafts post as one review. On GitLab they publish as a batch of draft notes.
- Sign-off adds a **comment** verdict, next to **approve** and **request changes**.

### Reading levels

- A **Hide code** control switches between `light`, `moderate`, and `aggressive`. Higher levels
  hide tests, helpers, and wiring, down to pseudo-code. Press `f` to step through them. Set the
  default in **settings**.
- Attention points, threads, and drafts stay visible at every level.
- Validation fails with `FOLD_MISSING` when a large file or layer hides too little.
- Built-in test patterns now cover common Python, Java, Kotlin, C#, Swift, PHP, and other
  conventions (`tests/`, `*_test.*`, `test_*.py`, `*Test`, and more).

### Incremental canvases

- Regenerating for a new head updates the previous canvas instead of starting over. Layers, notes,
  folds, and attention points of untouched files are kept word for word, and dismissals stay.
- Review marks on untouched files and layers follow the new canvas.
- `--force` starts from a blank page. `canvas.incremental: false` turns this off.
- New prompt templates: `generation-strict-incremental.md`, `generation-surfacing-incremental.md`,
  `judging-strict.md`, and `judging-surfacing.md`.

### Upgrades

- `pr-review upgrade` updates pr-review, acpx, and the project's skill copies after asking.
  `--yes` skips the question.

### AI Chat

- A saved model runs as the newest model of its family (`claude-opus-4-8` runs as `opus`).
  Prefix an ID with `pin:` to use that exact model.
- Claude chat uses the `claude` CLI on PATH when there is one, so it gets new models as soon as
  Claude Code updates. Set `CLAUDE_CODE_EXECUTABLE` to use another binary.
- The chat can be minimized at any width, and restoring it keeps the canvas scroll position.

### Review interface

- GitHub is the default skin. Choose **terminal** under **skin** to switch back.
- Quick-question menus stay inside the window.

### Breaking changes

- Canvases written by 0.5.0 cannot be read by earlier versions. Older canvases still open.
- Review marks saved by earlier versions are dropped on first read, so in-progress reviews start
  their ticks again. Dismissals, posted comments, and chat threads are kept.

### Upgrade from 0.4.0

1. Run `npm install -g @vintasoftware/pr-review-canvas@0.5.0` and restart `pr-review serve`.
   Later upgrades can use `pr-review upgrade`.
2. Run `pr-review upgrade` in each project to refresh the skill copies, then commit them.
3. Upgrade the whole team together, since 0.4.0 cannot open 0.5.0 canvases.
4. If you override `generation-strict.md` or `generation-surfacing.md`, move judging rules into
   `judging-strict.md` or `judging-surfacing.md`. Regenerations use the `*-incremental.md`
   templates, so override those too, or set `canvas.incremental: false`.

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
