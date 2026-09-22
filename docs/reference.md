# CLI and configuration reference

This reference covers command options, configuration, and troubleshooting for local PR reviews.
For setup and the basic review workflow, see the [README](../README.md).

- [CLI options](#cli-options)
- [Project config](#project-config)
- [Local settings and storage](#local-settings-and-storage)
- [Review controls](#review-controls)
- [AI Chat](#ai-chat)
- [Network access and permissions](#network-access-and-permissions)
- [Troubleshooting](#troubleshooting)

## CLI options

### Repository and runtime options

| Option                           | Applies to                 | Default and behavior                                                                                             |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--repo <dir>`                   | All commands               | Uses the current directory when omitted; resolves the repository root from there                                 |
| `--data-dir <dir>`               | All except `install-skill` | Overrides `PR_REVIEW_DATA_DIR`, then the default `<main checkout>/.pr-review`                                    |
| `--port <n>`                     | `serve`                    | Overrides `PR_REVIEW_PORT`, then `3010`; accepts 1–65535                                                         |
| `--agent claude\|codex`          | `serve`                    | Overrides the saved chat agent for this run                                                                      |
| `--model <id>`                   | `serve`                    | Overrides the saved chat model for this run                                                                      |
| `--fixture-canvas <review.json>` | `serve`                    | Development preview: uses the supplied canvas for every requested PR, with its head replaced by the live PR head |
| `PR_REVIEW_HOST=gitlab`          | Environment                | Treats a non-github.com origin as GitLab (self-hosted hosts whose name does not contain `gitlab`)                |

Repository operations require an `origin` remote on **github.com** or **GitLab** (gitlab.com, a
hostname that contains `gitlab`, or any host with `PR_REVIEW_HOST=gitlab`). GitHub Enterprise Server
hosts are not supported. Fetching a PR or merge request does not check out its branch. Use `--pr`
for both GitHub pull request numbers and GitLab merge request IIDs.

### Prepare, validate, and publish

These commands support custom generation workflows. The bundled
[generation skill](../skills/pr-review-canvas/SKILL.md) describes the complete sequence and model rules.

```text
pr-review prepare (--pr <n> | --branch | --uncommitted | --base <ref> --head <ref>) [--base <ref>] [--force]
pr-review validate <model.json|review.json> --canvas <dir> [--human] [--fix]
pr-review publish <canvasDir> --agent <id> [--model <id>] --harness claude-code|codex|other [--allow-stale]
```

`prepare` returns `canvasDir`, `headSha`, `mergeBaseSha`, `promptPath`, `contextPath`, and `status`.
A status of `exists` means that head already has a canvas. With `--force`, preparation clears the
previous generation's working files while keeping the published canvas available until a new
publish succeeds.

### Reviewing before the pull request exists

There are two reviews of the work in a clone, and they are separate targets:

```bash
pr-review prepare --branch        # served at /review/branch
pr-review prepare --uncommitted   # served at /review/uncommitted
```

`--branch` describes the tip of the current branch. `--uncommitted` describes the working tree as
it stands, with the edits and the untracked files on top of that tip; with a clean tree the two
build the same canvas. Each keeps its own canvas, review progress and chat threads, so preparing
one never disturbs the other.

- **Base.** Both compare against the repository's default branch, resolved from `origin/HEAD` and
  falling back to `origin/main`, `origin/master`, `main`, then `master`. `--base <ref>` overrides
  it. Preparation fails with a hint when none of them resolve.
- **Uncommitted work.** `--uncommitted` stages the working tree into an index of its own and
  writes a commit from it, so the diff covers files that are not committed yet. Nothing the user
  staged is touched, ignored files stay out, and the commit is anchored at
  `refs/worktree/pr-review-snapshot` so `git gc` cannot collect it before `publish`. Publishing
  gives that canvas an anchor of its own under `refs/worktree/pr-review-canvas/`, so a later
  snapshot cannot leave it collectable. The same working tree always hashes to the same commit.
- **Staleness.** Committing after `--branch`, or editing a file after `--uncommitted`, moves the
  head, so `publish` answers `CANVAS_STALE`, exactly as a push does for a pull request. The page
  reads the head again when it is opened and when `refresh` is pressed, and offers to regenerate.
  Its background polls answer about that same head, so they never contradict what the page shows;
  they read the work again only once a new canvas has been prepared.
- **Worktrees.** The snapshot index and its anchor are per worktree, so two worktrees of one clone
  never overwrite each other's snapshot. The review targets are not: `branch` and `uncommitted`
  name one review per clone, so worktrees share their canvas, review progress and chat threads.
  Review local work from one worktree at a time.
- **No forge side.** A local canvas posts nothing: comments, sign-off, canvas import, and
  attachment discovery are refused for it. The page draws no import drop zone and no shared-canvas
  callout, and the comment and sign-off commands stay disabled with the reason. A canvas of a working-tree
  snapshot is never offered as a pull request's canvas, or as the branch review's, because its
  commit is on no branch.

For a comparison between two commits that both exist, name them instead:

```bash
pr-review prepare --base origin/main --head HEAD
```

`validate` checks the supplied file against the context in `--canvas`. By default it returns
`{ ok, errors }`; `--human` prints readable diagnostics. A `review.json` is held to the correctness
rules only; the rules about what a fresh generation must hide (`FOLD_MISSING`, a test file
collapsed at `light`) apply to a `model.json`, because an older canvas predates them. `--fix` edits overlong titles by removing
the explanation after the first `:` or `—` and reports the changes. Titles that still exceed the
limit and overlong prose require rewriting.

`publish` returns `status`, `headSha`, `reviewJsonPath`, `attempts`, `sharing`, and a `reviewUrl`
for PR and local runs.
Its `--agent`, `--model`, and `--harness` describe who generated the canvas; they do not launch or
select an agent. `--allow-stale` permits publishing for the prepared commit after the PR head has
moved. Use it only when that older commit is the intended review target.

For more than 400 changed files or 50,000 added/deleted lines, preparation leaves diffs out of the
prompt and directs the generator to read patch files individually. Smaller diffs are inlined up
to `generation.inlineDiffMaxLines`.

### Automatic sharing and ZIP fallback

For PR/MR targets, `publish` saves the validated canvas locally, then posts its compressed ZIP
as base64 inside a hidden HTML comment on GitHub or GitLab. The visible comment identifies the
commit and explains how to open the canvas. Publishing again updates the existing canvas comment
owned by the current CLI account; another author's comment is left alone. The payload contains
the same `manifest.json` and `review.json` as an export, including the PR/MR description and review
notes. Hidden markup is not private: anyone who can read the comment can retrieve the payload.
No generated files enter Git history and no storage service or CI workflow is required.

Check the `sharing` result even when the process exits successfully:

- `{ "status": "shared", "url": "..." }`: the host accepted the comment.
- `{ "status": "failed", "warning": "...", "zipPath": "..." }`: the canvas is saved locally,
  but automatic sharing failed. The CLI also prints a warning to stderr and exports a fallback ZIP.
  Upload that ZIP into the PR/MR description in the browser and save; replace an older attachment
  link if present. A host failure can have an uncertain outcome, so check the comment before retrying.
- `{ "status": "local" }`: a refs-only target has no PR/MR to publish to.

The entire comment must fit the host limit: 65,536 characters on GitHub and 1,000,000 on GitLab.
Base64 uses roughly four characters per three compressed bytes, leaving slightly under 48 KiB
for a GitHub ZIP after the envelope and visible text. Oversize canvases are never split or truncated.
Permission, login, network, and host-policy errors use the same ZIP fallback. A sharing failure
keeps exit code 0 because local publication succeeded; validation errors still exit 5.
The generation skill must report the warning and manual-upload instructions on sharing failure.

`export` remains a local-only command for backups and manual sharing. For refs-only canvases,
export with `--head <sha> --pr <n>` once the PR exists, or regenerate for the PR to share automatically.

### Export and import options

```text
pr-review export (--pr <n> | --head <ref|sha>) [--out <file|dir>]
pr-review import <zip> [--pr <n>] [--force]
```

- `export --head` selects a specific commit. With both `--head` and `--pr`, the PR number labels
  the archive; it does not select the commit.
- `--out` defaults to the data directory's `exports/` folder. Supply an existing directory to
  keep the generated filename, or a full `.zip` file path to choose a name.
- Generated names follow `pr-<number>-<YYYYMMDDTHHmmssZ>-<sha8>-<owner>-<repo>-canvas.zip`,
  for example `pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip`. The timestamp is the
  canvas generation time in UTC, to seconds, so exports sort chronologically within each PR.
  Before a PR exists, `ref-` replaces `pr-<number>-`. Re-exporting the same canvas keeps its name.
- Export returns `status`, `path`, `name`, `headSha`, and `prNumber` when supplied or stored.
- `import --pr` compares the imported canvas with that PR's current head, and refuses a canvas
  exported for a different pull request with `CANVAS_PR_MISMATCH`. `--force` does not lift that
  refusal: a canvas is stored under the pull request it names, so importing the same ZIP without
  `--pr` stores it under its own PR instead. Without `--pr`, import does not check against a live
  PR. A canvas generated before the PR existed names none and joins the pull request it is
  imported for.
- Import returns `ready`, `stale`, or `exists`, plus commit information and warnings. `exists`
  keeps a stored canvas generated at the same time or later. `derivable: false` means the canvas
  was accepted but its source diffs could not be rebuilt from Git.
- `import --force` allows a canvas from another repository. It does not force an older canvas to
  replace a newer one, and does not allow a canvas of another pull request.

Imports accept archives up to **20 MiB**. The required `manifest.json` and `review.json` entries
must be at the archive root, pass format validation, and agree on the commit and the pull request
they describe. If the necessary commits are missing,
the tool attempts to fetch them; a failed fetch can leave the notes available without diffs.

### Skill installation options

```text
pr-review install-skill [--claude-dir <dir>] [--codex-dir <dir>] [--force]
```

Custom directories replace the destination for the named host; both hosts are still installed.
Relative custom paths resolve from the command's working directory. For example:

```bash
pr-review install-skill --codex-dir ~/.codex/skills
```

Installation copies the bundled skill on every platform. The copies and their `.pr-review-install`
marker files can be committed to Git. Re-running the command refreshes managed copies and replaces
legacy symlinks. An unmanaged directory requires `--force` to replace it.

Each installed `SKILL.md` records `metadata.body-sha256` in its YAML frontmatter. The SHA-256 hash
covers the body after the closing frontmatter delimiter, with CRLF normalized to LF. `doctor`
compares the recorded hash and actual body against the skill bundled with the running CLI. Any
outdated or modified copy in `.claude/skills` or `.agents/skills` fails the skill check, even if the
other copy is current. Refresh copies with `pr-review install-skill` (repeat any custom directory
flags used during installation). Automatic discovery checks the two default directories.

`serve` runs this skill check automatically and prints failures with a repair hint to stderr.
Warnings do not prevent the server from starting. Use `doctor --all-checks` for full diagnostics.
The `.gitignore` update always applies to the selected repository root, even with custom skill
directories.

### Output and exit codes

One-shot commands normally print a JSON result on stdout. Preparation progress goes to stderr.
`validate --human` prints text, and a failed `publish` prints validation diagnostics before its
JSON error. `serve` stays running and writes its startup message to stderr.

Command failures use `{ "error": { "code", "message", "hint" } }`, with `hint` optional.
Validation failures from `validate` use its report format instead.

| Exit code | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `0`       | Success                                                                  |
| `1`       | Error, including a failed `doctor` check                                 |
| `2`       | Command usage error, such as an unknown command or missing required flag |
| `4`       | GitHub CLI (`gh`) or GitLab CLI (`glab`) missing or unauthenticated      |
| `5`       | Validation failed in `validate` or `publish`                             |

`doctor` reports failed checks with exit `1`, including authentication failures.

## Project config

All keys are optional. See the [example configuration](../pr-review.config.example.yml) for a
starting file. Invalid YAML or invalid values produce a warning and fall back to the defaults.
Lists you supply replace their defaults.

Path patterns match repository-relative paths. `**` crosses directories; `*` and `?` match
within one path segment.

| Key                             | Default                                                                     | Details                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                       | `1`                                                                         | The only supported configuration version                                                                                                                                                                                   |
| `rulebook`                      | Unset                                                                       | Path to a Markdown file of project code standards, resolved from the repository root; these standards take precedence over bundled standards                                                                               |
| `layers`                        | `[]`                                                                        | Optional review guidance; each entry has `id`, `title`, `description`, and optional `paths` patterns. The agent may combine, split, or reorder groups. When omitted or empty, it chooses semantic sections from the change |
| `highRisk`                      | `[]`                                                                        | Entries with a `pattern` glob and `label`; matching changes receive risk labels and cannot go in the Other layer                                                                                                           |
| `generation.mode`               | `strict`                                                                    | See [generation modes](#generation-modes)                                                                                                                                                                                  |
| `generation.maxRepairRounds`    | `3`                                                                         | Failed validation rounds allowed by the generation skill                                                                                                                                                                   |
| `generation.inlineDiffMaxLines` | `1500`                                                                      | Maximum diff length to include directly in the generation prompt                                                                                                                                                           |
| `generation.smallPrHunks`       | `10`                                                                        | At or below this hunk count, the prompt asks for one layer unless concerns differ                                                                                                                                          |
| `generation.caps`               | See below                                                                   | Overrides individual text limits                                                                                                                                                                                           |
| `tests.patterns`                | Test directories and file-name shapes across stacks; see the example config | Paths treated as tests for review ordering, labels, and the light reading level                                                                                                                                            |
| `chat.enabled`                  | `true`                                                                      | Set to `false` to disable AI Chat                                                                                                                                                                                          |
| `canvas.keepForIdenticalDiff`   | `true`                                                                      | Keep the canvas current for a later head whose diff is identical to the canvas's; see [outdated canvases](#outdated-canvases). Set to `false` to mark it outdated on every commit                                          |
| `canvas.incremental`            | `true`                                                                      | Regenerate a canvas for a new head by updating the newest canvas of a commit the head was built on; see [incremental canvases](#incremental-canvases). Set to `false` to generate every canvas from a blank page           |
| `prompts`                       | Bundled templates                                                           | See [prompt templates](#prompt-templates) for supported keys and behavior                                                                                                                                                  |

Generation's numeric options and text caps must be positive integers. An empty `layers` list
provides no suggested groups; an empty `tests.patterns` list recognizes no files as tests.

Preparation saves the rules used to validate that generation. Changes to the configuration do
not change an already prepared generation or an existing canvas.

### Generation modes

- **`strict`** focuses on code-quality findings.
- **`surfacing`** provides a walkthrough of decisions, trade-offs, and maintenance concerns,
  with code-quality findings included.

Both modes read the project rulebook and use the same validation and review controls. The mode
affects canvas generation; chat answers the reviewer's selected question.

### Prompt templates

The `prompts` map in `pr-review.config.yml` accepts these keys:

| Key                                   | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `generation-format.md`                | Schema and output rules                                     |
| `generation-strict.md`                | Instructions for strict mode                                |
| `generation-surfacing.md`             | Instructions for surfacing mode                             |
| `generation-strict-incremental.md`    | Strict mode, updating an existing canvas                    |
| `generation-surfacing-incremental.md` | Surfacing mode, updating an existing canvas                 |
| `judging-strict.md`                   | Strict mode's judging rules, shared by both of its tasks    |
| `judging-surfacing.md`                | Surfacing mode's judging rules, shared by both of its tasks |
| `quality-standards.md`                | Bundled code standards                                      |
| `layering-guidance.md`                | Guidance for grouping related changes                       |
| `chat-seed.md`                        | Opening AI Chat instructions                                |

Each configured file replaces a whole template. Paths resolve from the project root,
including when running from a subdirectory or using `--repo`. Absolute paths work for
personal templates shared across projects. Omitted entries use the installed package's
defaults. A configured file that cannot be read causes an error.

`generation.mode` selects the generation wrapper. The project rulebook takes precedence
over code standards. Configured layers and caps supply data to the templates.

Preserve `{{TOKENS}}`, including `{{FORMAT}}` in generation wrappers, so generated prompts
include the context and output requirements. Unknown generation tokens fail rendering;
chat leaves unknown tokens as written. Prompt edits do not change the output schema or
validation rules enforced by the tool.

Run `prepare` again to apply generation edits (use `--force` for an existing canvas).
Restart the server after changing the config; chat template edits apply to new threads.
Custom templates persist across tool upgrades. Compare them with the new bundled templates
when upgrading.

### Text limits

Set any of these keys under `generation.caps`. Prose limits count visible characters, so Markdown
link targets do not count. `diagram` counts raw Mermaid source characters.

| Key            | Default |
| -------------- | ------- |
| `summary`      | 1200    |
| `layerTitle`   | 60      |
| `rationale`    | 300     |
| `decisions`    | 600     |
| `checkByHand`  | 400     |
| `annotation`   | 240     |
| `pointTitle`   | 90      |
| `pointBody`    | 600     |
| `testBehavior` | 120     |
| `diagram`      | 1500    |

The canvas has a separate limit of 12 attention points, including entries generated from missing
tests. Increasing text caps does not increase that limit.

### Test conventions

Custom patterns replace the JavaScript/TypeScript defaults. For example, a Python project can use:

```yaml
tests:
    patterns: ['**/test_*.py', '**/tests/**']
```

Test recognition controls ordering, but matching a test to its source file currently follows
`.test`, `.spec`, and `__tests__` naming. With other conventions, validation may miss a test
placed in Other while its source is in a regular layer.

## Local settings and storage

The data directory's `settings.yml` accepts these keys and values:

| Key              | Default  | Accepted values                                  |
| ---------------- | -------- | ------------------------------------------------ |
| `version`        | `1`      | `1`                                              |
| `skin`           | `github` | `terminal`, `github`                             |
| `theme`          | `auto`   | `auto`, `light`, `dark`                          |
| `foldLevel`      | `light`  | `light`, `moderate`, `aggressive`                |
| `agent`          | `claude` | `claude`, `codex`                                |
| `model`          | `null`   | A model ID, or `null` for the agent's default    |
| `chatTimeoutSec` | `600`    | Integer seconds, 30–3600                         |
| `maxTurns`       | `null`   | Integer 1–100, or `null` for the agent's default |

Invalid settings fall back to defaults. URL parameters `?skin=github&theme=light` can override
appearance for one page load without saving it.

By default, Git worktrees of the same clone share the main checkout's data directory. Separate
clones have separate data. An explicit data-directory override also relocates `settings.yml`,
canvases, review progress, and chat history.

The data directory contains exported archives, saved canvases, generation inputs, cached GitHub or
GitLab data, source diffs, and personal review progress. Its own `.gitignore` excludes its contents.
Deleting the directory loses saved preferences, canvases, progress, and chat history.

## Review controls

### Links to specific code

Append a fragment to `/review/<pr-number>`:

| Target              | Fragment example            |
| ------------------- | --------------------------- |
| Layer               | `#layer:data-access`        |
| File                | `#file:src/store.ts`        |
| Hunk                | `#hunk:src/store.ts#2`      |
| New-side line range | `#line:src/store.ts:40-52`  |
| Old-side line       | `#line:src/store.ts:40:old` |

Use the layer key and file path from the canvas. Links open the target file when needed; if a
line is unavailable, navigation uses the nearest visible row. Recipients need their own running
server and the corresponding canvas to use a localhost link.

### Collapsed diffs

Import-only changes, whitespace changes, moved code, and ranges selected by the generator may
start collapsed. Click the summary to expand them. Moves are detected within a file; moves
between files appear as deletions and additions. Edited moves keep their changed text visible.
Collapsing content does not mark it reviewed.

### Reading levels

A **Hide code** control sits under the header's risk line, beside the review progress, and governs
the whole canvas. The generator gives each range and each collapsed file the lowest level at which
it hides, and the levels nest, so a range marked `light` is hidden in all three.

| Level        | What it hides                                                                            |
| ------------ | ---------------------------------------------------------------------------------------- |
| `light`      | The diff as before: imports, whitespace, moves, and wholly generated files (the default) |
| `moderate`   | Also test bodies under their titles, helpers, adapters, boilerplate, mappings and wiring |
| `aggressive` | Also any block its title explains, so the change reads as pseudo-code                    |

The line next to the control names what the chosen level hides and how much of the diff that is,
so the effect is stated before the reader scrolls. Each layer repeats the count in its Files
heading, and the sign-off dialog records the total, so a reviewer signs off knowing how much they
did not read.

Attention points and comment threads keep their code visible at every level. An annotation may only
be hidden by an aggressive fold that covers the whole annotation and no other one; the fold then
shows the annotation's text in place of its title. A file that carries an annotation or an attention
point never collapses, so the layer's core stays on screen at every level and hides only its routine
ranges. Nothing in a test file hides at `light`, except snapshots and fixtures, which are generated;
from `moderate` each test body folds under its own title, one fold per test, or the file collapses
whole. A `light` fold is at most 40 lines of generated content. A file with more than 20 changed
lines outside its annotations and no attention point must hide something at some level; a file over
60 lines that stays open must fold at least half of the lines outside its attention points by
`aggressive`, annotated lines included; and a layer of more than 100 changed lines that leaves more
than 20 lines open at `moderate` outside its attention points must hide more at `aggressive`. A
smaller layer reads whole, and only the file rules apply to it. Each failure is `FOLD_MISSING`. An
annotation marks what to read; it does not excuse the rows around it.

The page opens at the level saved as `foldLevel` in `settings.yml`, `light` until changed. The
**Hide code by default** field of the settings dialog sets it. The control and the `f` key, which
steps through the levels, change the level for that page only, so the file holds a default rather
than the last thing the reader did. Changing
the level redraws the diffs that are on screen and re-applies file collapse, so a card the reader
opened by hand follows the new level.

Files with patches longer than 2,000 lines wait behind **show diff**. A link into the file opens
it automatically.

### Finding shared canvases

Discovery reads compressed canvas comments and checks the PR description and comments for legacy
canvas ZIP links. Both use the same ZIP validation and import path. It prefers a filename
matching the current head, then the PR number, then the most recently edited source text.
If a candidate fails, it tries other matching canvases. Keep the exported filename so the
canvas can be recognized. **Refresh** also checks for regenerated canvases at the same head commit.

An attachment exported for a different pull request is reported rather than imported, and is not
downloaded at all when its filename already names the other PR. The page says so and offers the
drop zone, which applies the same check: a ZIP whose name or manifest belongs to another PR is
refused.

When automatic download fails, download the archive in GitHub or GitLab and use the page's drop
zone or `pr-review import <zip> --pr <n>`.

### Comments and sign-off

You can post inline comments, replies, PR-level comments, and attention points. Inline comments
must target lines in the diff. Posting uses your `gh` or `glab` account and remains subject to its
repository permissions. On GitLab, **request changes** posts the review body as a merge request
note; **approve** calls GitLab's approve API.

The sign-off dialog previews an editable review body summarizing reviewed layers, dismissed
attention points, and comments posted from the canvas. Approval requires every layer except
**Other changes** to be reviewed for the current head. Requesting changes does not require that
completion. If the head moves before submission, reload and review the current commit.

### Outdated canvases

A canvas describes one head commit. When the pull request moves to another commit, the page
shows **Canvas is outdated**, offers the older canvas read-only, and disables posting from it.

An identical diff is the exception. When the head's diff against its merge base is the same as
the canvas commit's diff against its own, file by file and byte for byte, the canvas is carried
over: the page shows it under a **Canvas still applies** note, review progress carries over, and
sign-off, comments, and AI Chat keep working. The note says how many commits later the head is,
when the head was built on the canvas's commit. Merging the base branch in (**Update branch**) keeps
the diff identical as long as the base did not touch the changed files. The rule does not care how
the head reached that diff, only that it did; a diff that differs anywhere, even a hunk moved down
by a base change, marks the canvas outdated as before, because the canvas's layers, hunk ids, and
attention points describe the diff it was generated from. It needs `canvas.keepForIdenticalDiff`
(the default) and both commits in the local clone: the canvas's own commit has to be there for its
diff to be rebuilt, and without that diff there is nothing to compare, so the canvas reads outdated.
Two empty change sets are not compared either. `pr-review publish` and `pr-review import` apply the
same rule, so the CLI never calls a canvas stale that the page shows as current.

AI Chat also answers on an outdated canvas: it quotes the diff of the canvas's own commit, the
one on screen.

## Incremental canvases

Regenerating a canvas for a new head does not start from a blank page. `pr-review prepare` looks
for the newest canvas generated for a commit the head was built on, the **basis canvas**, and
compares its diff with the head's file by file. Every file whose patch is byte-identical is
untouched, and the prompt tells the generator to carry that canvas's work for it word for word:
whole layers when none of their files moved, and otherwise the notes, folds and annotations of the
files that did not, together with the attention points sitting in them. A carried point keeps its
kind, path and title, so it keeps its identity and any dismissal you made. Layers and points whose
files the head changed are decided again, and the summary and the risk tags are always written
again, since they describe the whole change set.

A canvas of a commit the head no longer contains is never a basis, however recent it is. `--force`
starts from a blank page, and `canvas.incremental: false` turns the behavior off for the project.
The canvas records the basis it came from, and nothing else: which of your review marks may follow
it is worked out on your own machine, from the two canvases and your own clone.

Your review progress follows an incremental canvas for the parts you have already seen. Each canvas
records the one it was generated from, and your marks follow that line of descent however long it
is: marking nothing on an intermediate canvas does not strand them, because the canvas you marked
and the canvas on screen are compared directly. A file's mark follows when that file is in both of
those canvases under the same layer key and its patch is byte-identical; a layer's mark follows only
when the layer holds exactly the same files and none of them changed, since that mark claims the
whole layer was read. A file that changed and changed back counts as untouched, because it is. When
any mark follows, the page names the canvas you made it on. A machine that does not have that
canvas, or cannot rebuild either diff, carries nothing and starts the marks empty.

## AI Chat

**Ask** on a layer, file, attention point, or line selection chooses the context for your message.
Choosing another target replaces it; **clear** returns to the whole PR. The `a` key asks about
the focused target, and `/` focuses the message box.

Chat can propose an inline comment. A valid proposal appears with controls to post, edit,
or copy it. A proposal outside the current diff remains text with an explanation.

Use **stop** to interrupt a reply. Only one chat turn can run per PR at a time. A timeout or
incomplete answer can be retried; increase `chatTimeoutSec` if replies need more time.

## Network access and permissions

The server binds to `127.0.0.1` and rejects browser writes from other origins. It is intended for
local use with your GitHub or GitLab login.

Publishing sends the canvas as a PR/MR comment. Host requests also fetch PR or MR data and
attachments and submit the comments or reviews you choose to
post. Rendered Markdown can load images from HTTPS hosts. Generation and chat send review
context to the selected coding agent and its configured provider.

Chat is instructed to read code without changing it, but the tool does not provide a filesystem
sandbox for the agent. Its access also depends on the agent's own permissions. Disable chat with
`chat.enabled: false` if those permissions are unsuitable for the project.

## Troubleshooting

| Symptom or code                         | Next step                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_A_REPO`                            | Run inside a Git clone or pass `--repo <dir>`                                                                                                         |
| `NO_ORIGIN`                             | Check that `origin` points to github.com or GitLab; for self-hosted GitLab set `PR_REVIEW_HOST=gitlab`                                                |
| `GH_MISSING` / `GH_UNAUTHENTICATED`     | Install [GitHub CLI](https://cli.github.com), run `gh auth login`, and check authentication in the same environment that runs the server              |
| `GITHUB_API_ERROR`                      | Read the underlying error for permissions, rate limits, connectivity, or GitHub service problems                                                      |
| `GLAB_MISSING` / `GLAB_UNAUTHENTICATED` | Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), run `glab auth login`, and check authentication in the same environment that runs the server |
| `GITLAB_API_ERROR`                      | Read the underlying error for permissions, rate limits, connectivity, or GitLab service problems                                                      |
| `PR_NOT_FOUND`                          | Check the PR number, repository, and your access                                                                                                      |
| `CANVAS_NOT_FOUND`                      | Generate or import a canvas for the requested commit                                                                                                  |
| `CANVAS_INVALID`                        | Read the format errors; re-export or regenerate the canvas                                                                                            |
| `CANVAS_REPO_MISMATCH`                  | Check which clone is open; use `import --force` only when importing from the other repository is intentional                                          |
| `CANVAS_PR_MISMATCH`                    | The ZIP was exported for another pull request; import the canvas of this PR, or import that ZIP without `--pr` to store it under its own              |
| `CANVAS_TOO_LARGE`                      | The archive exceeds the 20 MiB import limit                                                                                                           |
| `CANVAS_STALE`                          | The PR head moved; prepare again for the current commit                                                                                               |
| `MODEL_INVALID`                         | Fix the reported problems in `model.json`, validate, then publish again                                                                               |
| `SKILL_DIR_EXISTS`                      | The destination contains a customized directory; preserve it elsewhere before replacing it with `--force`                                             |
| `CHAT_BUSY`                             | Wait for the running reply or press **stop**                                                                                                          |
| `AGENT_AUTH_REQUIRED`                   | Sign in through the selected agent's CLI, then retry                                                                                                  |
| `AGENT_MISSING` or missing chat pane    | Check `chat.enabled` and confirm the server can find `acpx` and the selected agent; run `pr-review doctor --all-checks`                               |
| `AGENT_INCOMPLETE`                      | Retry the message or increase the chat timeout                                                                                                        |
| `COMMENT_FORBIDDEN`                     | Check the GitHub or GitLab account's repository access and token permissions                                                                          |
| `COMMENT_LINE_NOT_IN_DIFF`              | Choose a line shown in the current diff                                                                                                               |
| `SIGNOFF_INCOMPLETE`                    | Mark every layer except Other reviewed for this head                                                                                                  |
| `FORBIDDEN_HOST` / `CROSS_ORIGIN`       | Open the local server using `localhost` or `127.0.0.1` and submit actions from that page                                                              |

### Validation diagnostics

Validation reports name the field, file, hunk, or line to fix. Common groups are:

| Codes                                                           | What to check                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SCHEMA`, `TEXT_TOO_LONG`                                       | Required fields, types, and text limits                                                                                      |
| `HUNK_UNASSIGNED`, `HUNK_DUPLICATE`, `HUNK_UNKNOWN`             | Each known hunk belongs to exactly one layer                                                                                 |
| `PATH_UNKNOWN`, `TEST_PATH_UNKNOWN`                             | Referenced files exist in the relevant diff or PR head                                                                       |
| `LAYER_EMPTY`, `LAYER_KEY_DUPLICATE`                            | Layers contain hunks and have unique keys                                                                                    |
| `OTHER_DUPLICATE`, `OTHER_NOT_LAST`, `RISK_IN_OTHER`            | At most one Other layer, last, without risk-tagged changes                                                                   |
| `TEST_NOT_LAST`, `TEST_IN_OTHER`                                | Tests follow the code they cover and use the appropriate layer                                                               |
| `ANNOTATION_OUTSIDE_HUNK`, `POINT_OUTSIDE_DIFF`, `FOLD_INVALID` | Locations and fold ranges fit the assigned diff                                                                              |
| `FOLD_MISSING`                                                  | A file over 20 unannotated lines hides something; an open file over 60 folds half; a layer over 100 hides more at aggressive |
| `TOO_MANY_POINTS`                                               | Count explicit points and missing-test entries together                                                                      |
| `LINK_UNRESOLVED`, `DIAGRAM_NODE_UNKNOWN`, `DIAGRAM_LIMIT`      | Link targets, diagram node IDs, and diagram counts                                                                           |
