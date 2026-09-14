# CLI and configuration reference

A localhost review page for one GitHub pull request. It shows the PR's diffs grouped into semantic
**layers** by a canvas an AI coding harness generated, with attention points that need a human
look, the existing GitHub comments, reviewed state, comment posting, and sign-off. Nothing leaves
the machine except the GitHub posts the reviewer confirms.

See [the README](../README.md) for installation and sharing a canvas.

## Requirements

| Need | For what |
|---|---|
| `git`, and a clone whose `origin` is a github.com repository | diffs, merge base, the data dir |
| `gh`, authenticated (`gh auth login`), or `GH_TOKEN` / `GITHUB_TOKEN` in the environment | PR metadata, comments, attachment downloads, posting |
| Node ≥ 22 | the server runs through `tsx`, with no build step |
| A coding harness with the skill installed (Claude Code or Codex) | generating a canvas; the server never runs an agent |
| `acpx` ≥ 0.13 and an authenticated agent CLI | the AI chat pane only, optional |

Check all of it at once:

```bash
pr-review doctor
```

## Run

```bash
pr-review serve                    # http://localhost:3010 for this repository
pr-review serve --port 3011        # another port
```

Open `http://localhost:3010/review/<pr-number>`, or type the number on the home page. The server
fetches `pull/<n>/head` and the base branch into `refs/pr/<n>/*`, so the PR is never checked out.

For development, run `pnpm dev` from the tool checkout. It uses `tsx watch`: editing `src/`
restarts the server. Files under `static/` are read per request and need no restart.
The data directory is excluded from the watch, so publishing a canvas never restarts the server.

To look at the page with a canvas without generating one, serve the committed fixture for PR #278
of this repository:

```bash
pr-review serve --fixture-canvas __fixtures__/pr-278/review.json
# then open http://localhost:3010/review/278
```

With that flag every PR reports `ready` with the fixture re-keyed to the live head. Dev only.

A canvas link works as a URL fragment, so a review URL points at a layer, a file, a hunk, or a line
range and opens the page there:

```
http://localhost:3010/review/278#layer:shl-lifecycle
http://localhost:3010/review/278#file:apps/shl-server/src/db.ts
http://localhost:3010/review/278#hunk:apps/shl-server/src/db.ts#2
http://localhost:3010/review/278#line:apps/shl-server/src/db.ts:40-52
```

The page draws the file card the link needs, opens it if it is collapsed, and lands on the row.
A line the diff folds away lands on the nearest row, marked `near line`. Clicking a link
inside the page does the same and writes the fragment into the URL, so the URL bar is always the
link to share.

The header's `[ skin: ... ]` command picks the look, and is independent of light and dark. `terminal`
is the default: brackets around commands, square corners, drop shadows, and the rainbow bar under the
header. `github` repaints the same page in Primer colors with rounded corners, hairline borders, and
toolbar buttons, so it reads like a GitHub pull request. Dark is GitHub's softer "dark dimmed" ground
there. Nothing moves between the two; only paint and spacing change. Added and deleted lines carry
GitHub's tints in both skins.

The `[ theme: ... ]` command cycles `auto`, `light`, and `dark`. `auto` follows the operating system.
Both skins work in each of the three, so there are six pairings in all.

Both choices are saved in `.pr-review/settings.yml` as `skin:` and `theme:`, so they hold for every
browser that opens this server and can be edited by hand. The server renders them onto `<html>`, so
no page ever flashes the other look and the shell runs no script to pick one. `?skin=` and `?theme=`
take the same names and pick an appearance for a single load without touching the file, which is what
screenshots want.

The header's `[ refresh ]` command re-asks GitHub for the pull request, its comments, and any canvas
zip attached to it, instead of answering from the server's caches. It is the same thing as
`?refresh=1` on the bundle route. Ctrl-C stops the server and closes its open connections.

### Install globally

```bash
npm install -g git+ssh://git@github.com/vintasoftware/pr-review-canvas.git
pr-review install-skill                                # links into .claude/skills and .agents/skills
pr-review install-skill --codex-dir ~/.codex/skills    # user-wide for Codex instead
```

`install-skill` symlinks `skills/pr-review-canvas` (copies on Windows) and is idempotent; it refuses
to replace a hand-made directory unless `--force`. Claude Code reads `.claude/skills/<name>/SKILL.md`.
Codex reads repo skills from `.agents/skills` under the project root (walking from the root to the
cwd), `.codex/skills` from a project config layer, and user skills from `$CODEX_HOME/skills`
(default `~/.codex/skills`); source: `codex-rs/ext/skills/src/host_roots.rs` in openai/codex.

To run it beside the other dev servers, add the review server to the root `dev` task:

```jsonc
// package.json
"scripts": { "dev:review": "pr-review serve" }
```
```jsonc
// turbo.json
"tasks": { "dev": { "with": ["//#dev:review"], "persistent": true, "cache": false } }
```

## What the diff folds away

A file card shows the change, not every line git printed. Three kinds of rows sit behind a summary
row that counts them and opens on a click:

- **Imports and whitespace.** An import-only hunk and a rewrite that only changed spacing read as
  `⋯ 2 lines hidden (imports, whitespace)`.
- **Code that only moved.** Three or more lines deleted in one place and added again, identical
  apart from spacing, are one move rather than two edits. Each end folds behind a summary that
  names the other end: `⋯ 3 lines moved to line 96` where the lines went, `⋯ 3 lines moved from
  line 12` where they arrived. The line number is a button that jumps to the other end and opens
  its fold. Neither end is painted as added or deleted code, so a move costs a reviewer one row
  instead of two blocks.

  A block is a run of one side's file, so the other side's lines in between are skipped: a
  deletion and the deletion four lines below it are one block of the old file even when git
  printed a screenful of additions between them. Blank lines are left out of the comparison, and
  up to three untouched lines are bridged — git routinely leaves a line the move did not touch as
  context and splits the changed lines around it. A bridged line is compared but never folded,
  because it is still where it was on both sides; a move that spans one shows up as two summaries,
  one per run, each naming its own destination. The match has to begin on a line that matches and
  stops at the first bridged line that does not, and it needs three changed lines on each side, so
  a run of `}` and blanks is never mistaken for a move.
- **Ranges the canvas asked to fold.** The generator names source ranges by title (see `folds`
  below); those open the same way.

A move that changed on the way is shown, not folded. Its summary reads `⋯ 4 lines moved from line
12, edited` and its rows carry the usual word-level marks, so the edit stands out and the rest of
the block does not have to be read twice.

A move is found within one file. Lines that moved between files still read as a deletion and an
addition.

## CLI reference

Every command prints one JSON line on stdout on success and `{ "error": { code, message, hint } }`
on failure; progress goes to stderr. `--repo <dir>` and `--data-dir <dir>` work on every command.

| Command | What it does |
|---|---|
| `serve [--port] [--repo] [--data-dir] [--fixture-canvas]` | The review server |
| `doctor [--all-checks]` | Checks `git`, `origin`, `gh`, `ghAuth`, data directory access, and the skill. `--all-checks` also runs `acpx --version`. Prints one JSON line; exit 1 when any requested check fails |
| `prepare (--pr <n> \| --base <ref> --head <ref>) [--force]` | Prints `{ canvasDir, headSha, mergeBaseSha, promptPath, contextPath, status }`, `status` being `prepared` or `exists` |
| `validate <model.json\|review.json> --canvas <dir> [--human] [--fix]` | Prints the validation report as one JSON line (`--human`: one line per problem); exit 5 when not ok. `--fix` first shortens over-cap titles in place, dropping the explainer after the first `:` or `—`, and reports each one; prose is never cut, but an over-cap field names where the cap falls in its own text |
| `publish <canvasDir> --agent <id> [--model <id>] --harness <id> [--allow-stale]` | Prints `{ status: 'published', headSha, reviewJsonPath, attempts, reviewUrl? }`; refuses with `CANVAS_STALE` when the PR head moved |
| `install-skill [--claude-dir <dir>] [--codex-dir <dir>] [--force]` | Links the skill into the host repo |
| `export (--pr <n> \| --head <ref\|sha>) [--out <file\|dir>]` | Writes the canvas zip (default `.pr-review/exports/`) and prints `{ status: 'exported', path, name, headSha, prNumber? }`; `CANVAS_NOT_FOUND` when that head has no canvas. With both flags the named commit is exported and the number only stamps the zip |
| `import <zip> [--pr <n>] [--force]` | Stores a canvas from a zip and prints `{ status: 'ready' \| 'stale' \| 'exists', headSha, currentHeadSha, relation?, commitsBehind?, derivable, warnings }`; `CANVAS_REPO_MISMATCH` for a zip from another repository unless `--force` |

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | an error, including a failed `doctor` check |
| 2 | usage: an unknown command, a missing flag, a bad value |
| 4 | `gh` is missing or not logged in |
| 5 | invalid model output (`validate`, `publish`) |

### Flags and environment

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--port <n>` | `PR_REVIEW_PORT` | `3010` | Port on `127.0.0.1` |
| `--repo <dir>` | | cwd | Repository to serve; must have a GitHub `origin` |
| `--data-dir <dir>` | `PR_REVIEW_DATA_DIR` | `<main checkout>/.pr-review` | Where canvases and PR state live |
| `--fixture-canvas <review.json>` | | | Dev only, see above |
| `--agent claude\|codex` | | from `settings.yml` | Chat agent for this run; the settings dialog reports it as an override |
| `--model <id>` | | from `settings.yml` | Chat model for this run |

## Generate a canvas

The server never runs an agent. Open `/review/<n>` without a canvas and the page shows the command
to run in your own coding harness:

```
/pr-review-canvas 484            # or: /pr-review-canvas 484 --force to regenerate
```

The skill drives three CLI commands and writes one file:

1. `pr-review prepare --pr <n>` fetches the PR, builds `derived/`, and writes `prompt.md` (the
   task: manifest with hunk ids, diffs, layering and length rules, the rulebook, the JSON schema) and
   `context.json` (what `publish` checks against) into the canvas directory.
2. The agent reads them and writes `<canvasDir>/model.json`.
3. `pr-review publish <canvasDir> --agent <id> --harness claude-code|codex|other` validates the
   file, prints one line per problem and exits 5 when it fails, or normalizes it into `review.json`
   and indexes the canvas. The page, which polls while it shows the empty state, flips to the review
   without a reload.

Before a PR exists: `pr-review prepare --base origin/main --head HEAD`. The canvas is stored by
head SHA and found once the PR is opened.

### Large pull requests

Above 400 changed files or 50 000 changed lines the change set is **large**: `prepare` inlines no
diff in the prompt and tells the agent to read one patch file at a time, the caps of at most 6
annotations per file and 12 attention points are restated, `context.json` carries `largePr: true`,
and the page prints a one-line notice in its header so a reader knows why a file carries no
annotation. Separately, a file whose patch is over 2 000 lines waits behind a `[ show diff ]`
command instead of drawing on sight; a link into such a file draws it first.

### Validation codes

`SCHEMA`, `TEXT_TOO_LONG`, `HUNK_UNASSIGNED`, `HUNK_DUPLICATE`, `HUNK_UNKNOWN`, `PATH_UNKNOWN`,
`LAYER_EMPTY`, `LAYER_KEY_DUPLICATE`, `OTHER_DUPLICATE`, `OTHER_NOT_LAST`, `TEST_NOT_LAST`,
`TEST_IN_OTHER`, `RISK_IN_OTHER`, `ANNOTATION_OUTSIDE_HUNK`, `POINT_OUTSIDE_DIFF`, `TOO_MANY_POINTS`
(written points plus one per `missing` test entry), `TEST_PATH_UNKNOWN`, `LINK_UNRESOLVED`,
`DIAGRAM_NODE_UNKNOWN`, `DIAGRAM_LIMIT`. A shape failure (`SCHEMA`) stops the run; a text over its
cap is reported together with the layering rules. Nothing is auto-fixed and no partial `review.json`
is written. A `covered` test path may be any file at the PR head, changed or not.

## Where artifacts live

`.pr-review/` sits next to the git common dir, so every worktree of one clone shares it. It is
self-ignoring (`.gitignore` with `*`).

```
.pr-review/
  exports/                          default --out for `pr-review export`
  repos/<owner>__<repo>/
    index.json                      canvases by head sha
    canvases/<headSha>/
      review.json  manifest.json    the canvas (what a shared zip carries)
      prompt.md  context.json       written by prepare; model.json by the agent; publish.log by publish
      derived/                      rebuilt from local git: files.json, patches.json,
                                    patches/<key>.diff (hunks labeled `### hunk <id>`), head/<path>, base/<path>
    prs/<n>/                        pr.json, comments.json, state.json, discovery.json
```

Reviewed marks, dismissed attention points, hidden threads, and the record of what was posted live
in `prs/<n>/state.json`. They are personal: a shared zip never carries them.

## Sharing a canvas

The PR opener generates the canvas once and attaches the zip to the pull request, so every other
reviewer reads it without paying for a generation.

1. `pr-review export --pr <n>` writes
   `pr-review-canvas-<owner>-<repo>-pr<n>-<sha7>.zip` and prints its absolute path. Before the pull
   request exists, `--head <ref>` writes the same zip without the `pr<n>` part.
2. Drag that file into the PR description or a comment in the browser. The tool exports locally;
   attaching the zip is manual. `pr-review export --pr <n>` re-exports with the number once the PR exists.
3. Another reviewer opens `http://localhost:3010/review/<n>`. The server finds the links in the PR
   text, takes the one named for this head, then the newest one attached to this PR, and imports
   it; when that file cannot be read it tries the next two before giving up.
4. When the download fails, the page shows the link, the reason, a `[ fetch again ]` command, and
   a drop zone that takes the file by hand. `pr-review import <zip> --pr <n>` does the same
   from a terminal.

A canvas is stored under its head sha, so a canvas for an older commit shows as **stale**: the page
offers to read it anyway, with a bar naming how many commits behind it is, or to generate a new one
for the current head. A stale canvas cannot post comments or reviews, because its line numbers
belong to another commit.

## Comment posting and sign-off

A capability probe (cached ten minutes, `?refresh=1` to redo it) reads the login from `gh api user`
and the token's scopes and repository permissions from `gh api -i repos/{owner}/{repo}`:

| Probe result | What the page does |
|---|---|
| classic token with `repo` (or `public_repo` on a public repo) and read access | posting enabled |
| classic token without the scope, or no read access | posting disabled with the reason and `gh auth refresh -h github.com -s repo` |
| no scopes header (fine-grained or app token) | posting enabled; GitHub's own answer decides |

The page posts inline comments from the gutter `+` and the range toolbar, replies under a thread,
PR-level comments from the overview, and an attention point as a comment. A line outside the diff
is refused before GitHub is called (`COMMENT_LINE_NOT_IN_DIFF`).

Sign-off posts a pull request review whose body lists the layers reviewed, the attention points
dismissed, and the comments posted from the canvas. The dialog shows that body first and it can be
edited. `[ approve on github ]` stays disabled until every layer outside **Other changes** is marked
reviewed for the current head; the server refuses it too (`SIGNOFF_INCOMPLETE`), so a stale page
cannot approve behind the check.

## Project config

`pr-review.config.yml` at the repository root. Every key is optional; see
[`pr-review.config.example.yml`](../pr-review.config.example.yml). `prepare` records the caps and
patterns and generation mode in `context.json`, so a config change between prepare and publish
does not move the rules.

| Key | Default | Meaning |
|---|---|---|
| `rulebook` | none | Markdown reference for project code standards; it wins over bundled standards. The generation mode controls how it is used |
| `layers` | the 8 architecture groups | The default taxonomy, in review order. The model may add, split, or reorder |
| `highRisk` | `[]` | `{ pattern, label }` globs. A layer touching one gets the label; the header shows the union. A tagged layer can never be Other |
| `generation.mode` | `strict` | `strict` reviews code quality; `surfacing` explains decisions, trade-offs, flows, and maintenance context, and audits the change while it reads |
| `generation.maxRepairRounds` | `3` | How many failed publishes the skill retries before it reports |
| `generation.inlineDiffMaxLines` | `1500` | Above this the prompt points at patch files instead of inlining |
| `generation.smallPrHunks` | `10` | At most this many hunks: one layer unless concerns differ, fewer annotations |
| `generation.caps` | the built-in caps | Per-field character caps: `summary` 1200, `layerTitle` 60, `rationale` 300, `decisions` 600, `checkByHand` 400, `annotation` 240, `pointTitle` 90, `pointBody` 600, `testBehavior` 120, `diagram` 1500 |
| `tests.patterns` | `['**/*.test.*', '**/*.spec.*', '**/__tests__/**']` | Which paths count as tests, for the layering rules and the `test` pill. Name your own for other languages (`**/test_*.py`, `**/*_test.go`) |
| `chat.enabled` | `true` | `false` removes the chat pane and its routes; everything else is unchanged |

Building Blocks sets `generation.mode: surfacing`. The canvas helps the next reviewer understand
and take ownership of the implementation through a reading path, linked code, diagrams, decisions,
and test evidence, and it reports the problems found while reading.

Both modes read the project rulebook and the bundled quality standards. `strict` writes the audit
alone; `surfacing` writes it inside the walkthrough, and weighs three things a walkthrough
otherwise reads past: a guarantee the README, a comment, or the PR description states that the code
does not deliver; values chosen against each other, such as a retry period against the schedule
that runs it; and structural drift. Both modes use the same artifact format, validation, and review
controls. The mode applies to canvas generation; AI Chat continues to answer the reader's selected
question.

Both modes put every surfaced decision, trade-off, and manual check in an anchored attention
point. A sound design choice uses `decision` / `fyi`; a choice needing agreement uses `decide`,
and a manual verification uses `check` with an action and expected result. Generators omit the
optional layer `decisions` and `checkByHand` fields and keep explanations in the points. Related
items can share a point when they can be reviewed together, within the 12-point canvas limit
including points generated from missing tests.

Both tasks can start routine code collapsed. A file's `collapsed: true` keeps its header visible;
`folds` holds title-only source ranges (`title`, `side`, `startLine`, `endLine`) for individual tests,
functions, or classes. The generator reads the relevant code and assertions before choosing a fold,
and writes no fold explanation. Every diff row stays available on expansion, and links into a fold
open it. Collapsing does not mark anything reviewed. The validator rejects overlapping ranges,
ranges outside an assigned hunk, and folds that cover annotations or attention points; the browser
also keeps ranges with GitHub discussions visible.

The two tasks live in [`generation-strict.md`](../prompts/generation-strict.md) and
[`generation-surfacing.md`](../prompts/generation-surfacing.md). Code selects one before rendering;
the generator receives only that task. Both insert the data and output-format rules from
[`generation-format.md`](../prompts/generation-format.md). Changing the config affects the next `prepare` run.
For an existing canvas, regenerate with `/pr-review-canvas <n> --force`; changing the setting alone
does not rewrite a saved canvas. Older prepared contexts default to `strict`.

With `tests.patterns` of your own, `TEST_NOT_LAST` still fires: it only asks which files are tests.
The `TEST_IN_OTHER` check also has to name the source file behind a test, which it does by
stripping `.test`, `.spec`, and `__tests__/` from the path, so it stays quiet for a `test_views.py`
next to a `views.py`. Mapping other conventions to their source is an open follow-up.

An invalid file does not stop the server: the defaults are used and the problem shows as a page
banner and in `warnings[]`.

`.pr-review/settings.yml` holds the personal, gitignored scope: the skin, the theme, the chat agent,
its model, the chat timeout, and the turn cap. It is written with comments the first time it is
needed, and both `PUT /api/settings` and `PUT /api/appearance` edit the document rather than
rewriting it, so hand-written comments survive. `/api/appearance` is its own route because the chat
routes answer 404 in a repository with chat off, and such a repository still has a page to paint. The
chat pane width is the one thing left in the browser's own storage. See [AI Chat](#ai-chat).

A merged PR is diffed against its base as it was at merge time (the merge commit's first parent),
so a merged PR reviews the same files GitHub showed.

## AI Chat

The right-hand pane asks a coding agent about the pull request. It runs through
[acpx](https://www.npmjs.com/package/acpx) against `claude` or `codex`. Every call carries
`--approve-reads --non-interactive-permissions deny --no-terminal --suppress-reads`, and the seed
prompt tells the agent it reads code and changes nothing. `chat.enabled: false` in the project
config removes the pane and answers 404 on every chat and settings route. A missing `acpx` does
the same at runtime, with a banner saying so.

**What "read-only" rests on.** `--no-terminal` means acpx does not advertise the ACP terminal
capability, and `--non-interactive-permissions deny` denies any permission prompt. It is not a
sandbox: an agent that ships its own shell tool still has it, and `--approve-reads` approves
read-like calls without asking, which is how the agent inspects the materialized files. A write
therefore has to pass the agent's own permission policy, and a probe asking for one was refused,
but the refusal came from the agent rather than from a boundary this tool controls. Treat the
chat as "an agent running under your own settings, pointed at this pull request", and turn it off
with `chat.enabled: false` where that is not acceptable.

**One context per message, set-not-toggle.** `[ ask ]` on a layer, a file, an attention point, or a
line selection replaces the chip; asking the same target again changes nothing, and `[ clear ]` is
the only way back to the whole pull request. Hovering or focusing any `[ ask ]` opens a menu with
four fixed questions plus "ask something else…"; picking one sets the context and sends. The `a`
key asks about whatever is in focus, and `/` puts the cursor in the box.

An attention point sends the point itself: the browser carries only its fingerprint, and the
server resolves that against the canvas and gives the agent the point's title, kind, level, and
body along with the lines it sits on. A fingerprint the canvas does not have is refused.

**The pane is pinned to the viewport** on a wide screen, and a wheel turn anywhere over it moves
the transcript rather than the page, so reading an answer never scrolls the canvas out from under
you. The transcript stops at its own ends instead of handing the scroll to the page. Below
1360px the pane joins the page as an ordinary column and the wheel behaves normally again.

**Threads** are acpx sessions named `pr-review-<owner>-<repo>-<n>-<agent>-t<k>`, with the
transcript in `prs/<n>/chat/<name>.jsonl` and the raw agent stream in `<name>.events.ndjson`.
Changing the agent starts a new thread. The first turn of a thread, and any turn after the head sha
moved, is prefixed with [`prompts/chat-seed.md`](../prompts/chat-seed.md): the pull request, the
layers, the attention points, the test map, where the files are materialized, a six-sentence length
rule, and the **answer protocol** (verdict first, then evidence with `path:line`, then a proposed
comment only when it recommends a change).

A proposed comment is a fenced ```comment block holding `{ path, line, side?, startLine?, body }`.
The page checks it against the diff of this head and renders a card with
`[ post to github ] [ edit ] [ copy ]`; a block naming a file or a line the diff does not show
stays a code block with the reason.

### acpx facts this runner relies on

Verified against acpx 0.13.2 while building this:

- `--format json` prints one ACP JSON-RPC message per line: `session/update` notifications whose
  `params.update.sessionUpdate` is `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
  `tool_call_update`, `usage_update`, or `plan`; the `session/prompt` result with its `stopReason`;
  and errors carrying `data.detailCode` such as `AUTH_REQUIRED`.
- Exit codes are 0 ok, 1 error, 2 usage, 3 timeout, 4 no session, 5 permission denied, 130
  interrupted. **acpx exits 0 when its own `--timeout` elapses, with no terminal event at all**, so
  the runner keeps its own deadline and calls a turn without `stopReason: end_turn` incomplete.
- `acpx <agent> cancel -s <name>` ends the running turn cooperatively; the prompt then exits 0 with
  `stopReason: "cancelled"`. The runner asks for that first and stops the child after.
- `acpx <agent> -s <name> prompt -f -` **fails on a session that does not exist** (codex answers
  "No acpx session found" and exits), so a thread's first turn runs
  `acpx <agent> sessions ensure -s <name>` first. A later prompt in the same session reuses the
  running agent and its context, so only the first turn pays for it.
- **`--auth-policy fail` is not used.** `codex` refuses to start under it even while `codex login
  status` reports a signed-in account. A real auth failure still arrives as an `AUTH_REQUIRED`
  error line.
- **`--suppress-reads` blanks the visible tool output but leaves the file's content under
  `_meta.claudeCode.toolResponse`**, and the auth notification carries the signed-in account. The
  runner therefore drops `_meta` from every line and the auth line entirely before anything is
  written to `events.ndjson`.
- When the provider rejects acpx's bundled Claude binary, export
  `CLAUDE_CODE_EXECUTABLE="$(command -v claude)"` before `pr-review serve`; the runner passes the
  environment through.

## Security model

- Binds `127.0.0.1` only. A `Host` header outside `localhost`, `127.0.0.1`, and `[::1]` answers 403,
  which is what stops DNS rebinding.
- Every non-GET request must be same-origin (`Sec-Fetch-Site` and `Origin`), because the server can
  post to GitHub as the user. A table test walks every route with a foreign `Host` and every write
  route with a foreign origin and expects 403.
- Every answer carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`;
  `/api/*` adds `Cache-Control: no-store`, so PR text and comments stay out of caches.
- HTML pages carry a Content-Security-Policy: `default-src 'none'`, scripts and styles and images
  from this origin only, `data:` images, and no frame, object, or base URI. The two inline script
  blocks the shell needs (the import map and the bootstrap JSON) carry a per-response nonce; the page
  runs no inline script of its own, there is no inline event handler anywhere, and the form is a plain
  GET that the server redirects. Inline **styles** are allowed because the page sets dynamic values
  that way and mermaid injects a style element per drawing.
- Every child process runs through `execFile` with an argument array; no shell is ever involved, and
  a test greps the source to keep it that way. Comment bodies go to `gh` over stdin, never in an
  argument list.
- Patches reach the browser as JSON from `/api/prs/:n/patches` and are never inlined into HTML.
- Model text, PR descriptions, and GitHub comments render through `marked` with raw HTML off and
  `DOMPurify` with an allowlist; `href` may only be `http(s):` or `#`. Only two fields draw a
  diagram, the summary and a layer rationale, so a ```mermaid fence in a PR description or a comment
  stays a code block. Mermaid runs at `securityLevel: 'strict'`, a source that sets mermaid options
  through `%%{init}%%` or front matter is shown rather than drawn, and the SVG goes through
  DOMPurify's SVG profile before it reaches the page.
- Attachment downloads go to `github.com` and `objects.githubusercontent.com` only, follow at most
  three redirects, stop at 20 MB and 30 s, and accept only a zip holding exactly `manifest.json`
  and `review.json`. The gh token is read per request, sent to `github.com` alone (never to the
  signed storage URL), and never logged or written to the data dir; a test captures a run and greps
  for it.
- `model.json` is untrusted input: it is schema-validated before anything reads a field, and zip
  entry names that traverse are ignored.

## Troubleshooting

| Code | What to do |
|---|---|
| `NOT_A_REPO` | Start from a clone, or pass `--repo <dir>` |
| `NO_ORIGIN` | Add an `origin` remote that points at github.com |
| `GH_MISSING` | Install `gh` from https://cli.github.com |
| `GH_UNAUTHENTICATED` | `gh auth login` |
| `GITHUB_API_ERROR` | A rate limit or an outage; retry in a moment |
| `PR_NOT_FOUND` | Check the number and that `origin` is the right repository |
| `NOT_FOUND` on `/patches` | The PR head or merge base is not in the clone; `[ refresh ]` fetches them |
| `CANVAS_NOT_FOUND` | No canvas for this head: generate one, or import a zip |
| `CHAT_BUSY` | A chat turn is running for this pull request; press `[ stop ]` or wait |
| `AGENT_AUTH_REQUIRED` in the chat | Log the agent in from a terminal (`claude auth status`, `codex login status`) |
| `AGENT_MISSING` in the chat, or no pane at all | Install `acpx` and the agent CLI, then reload |
| `AGENT_INCOMPLETE` in the chat | The agent stopped before finishing; ask again, or raise `chatTimeoutSec` |
| `CANVAS_INVALID` | The zip or the stored `review.json` does not match the current format; regenerate |
| `CANVAS_REPO_MISMATCH` | The zip came from another repository; `--force` overrides on the CLI |
| `CANVAS_TOO_LARGE` | Over 20 MB: not a canvas zip |
| `CANVAS_STALE` | The head moved while you worked. Reload the page, or `prepare` again |
| `MODEL_INVALID` (exit 5) | `publish` printed one line per problem; fix `model.json` and publish again |
| `SKILL_DIR_EXISTS` | Something else sits at the skill path; remove it or pass `--force` |
| `COMMENT_FORBIDDEN` | `gh auth refresh -h github.com -s repo` |
| `COMMENT_LINE_NOT_IN_DIFF` | Comment on a line the diff shows |
| `SIGNOFF_INCOMPLETE` | Mark every layer outside Other reviewed for the current head |
| `FORBIDDEN_HOST` / `CROSS_ORIGIN` | Open the page as `localhost` or `127.0.0.1`, and drive it from the page itself |

`pr-review doctor` answers most of the first rows in one line, including whether the data dir
is writable and the skill is installed. `GET /api/health` reports the four checks a running server
can answer for itself: git, origin, `gh`, and `gh` auth.

## Develop

```bash
pnpm test          # vitest
pnpm coverage      # enforces 95% lines/branches/functions
pnpm typecheck     # tsc --noEmit, includes static/js via checkJs
pnpm exec playwright install chromium  # first browser-test run
pnpm test:browser  # Chromium: desktop, tablet, and mobile widths
```

Before opening a pull request: run the checks above, then a manual pass over
`/review/<n>` with a real canvas, checking that every command shows its pending label and that the
browser console stays quiet.

The browser smoke tests in `browser/` load the real page, JavaScript, and CSS from a temporary
localhost server. Each test gets its own synthetic PR and temporary data directory. Git and GitHub
use the existing process fakes, so the tests need no credentials. They cover dismissing and restoring
attention points, persistence across reloads, notification expiry, file and layer collapse, the
shared visibility rule, and the appearance: `theming.spec.ts` checks the resolved colors of the page,
the cards, and the diff for each skin in light and in dark, checks that both the skin and the theme
survive a reload through the settings file, and runs collapse and dismissal in both skins. The `PR review browser tests` workflow runs them for changes to this package
or its dependencies and saves screenshots and traces on failure.

`static/styles.css` imports the styles under `static/styles/` in cascade order. Base styles own tokens,
element defaults, and visibility; the other files group commands, header, layout, review cards, diffs,
chat, panels, responsive rules, review actions, and chat tools. Keep related rules together and preserve
the import order when moving them. `skin-github.css` is last, because it repaints every file above it:
its rules all hang off `[data-skin="github"]` on `<html>`, so the component files are written in the
terminal skin alone, and a new component needs an entry there only when its github look differs. Both
skins write their colors through `light-dark()`, which is how one skin covers light and dark. The shared `[hidden]` rule takes priority over component display
styles; controls change visibility through the `hidden` attribute. Browser tests check visibility with
the full stylesheet loaded.

Browser modules are plain ES modules under `static/js/` with `// @ts-check` and JSDoc types. They
import `diff`, `marked`, `dompurify`, `hljs`, and `mermaid` by bare name through an import map that
the page shell maps to `/vendor/*`, which serves those files from `node_modules`. Mermaid is the one
name the page does not preload: `diagram.js` imports it the first time a screen holds a diagram, and
`/vendor/mermaid/*` serves its whole `dist/` because it fetches the chunk of a diagram type at render
time.

A diagram panel is a header and a body. The header carries the same `>` chevron the layer and file
cards use, a label naming the kind of drawing ("diagram · stateDiagram"), and a `[ copy ]` command
that puts the source on the clipboard as a fenced ```mermaid block, so it can be pasted into a
GitHub comment. A panel is open when the page draws it; a closed one is drawn the moment it is
opened, which is what a reader sees after closing a diagram and flipping the theme. The open or
closed state lives in the page and is not saved.

### Measured page weight

Measurements from the single-file stylesheet version, serving the PR #278 fixture (40 files, 121 hunks):

| What | Value |
|---|---|
| HTML shell | 1.5 kB |
| `styles.css` | 35 kB, one request |
| `app.js` and the modules it pulls | 12 kB entry, 62 files, 1.2 MB unminified over the page's life |
| Vendored ESM preloaded (`marked`, `dompurify`, `highlight.js`, `diff`) | 304 kB |
| Bundle route, cold (fetches the PR and builds `derived/`) | 6.4 s |
| Bundle route, warm | 13–19 ms |
| `/patches` for the whole PR | 227 kB, 6 ms |

The page itself was measured in Chrome on a desktop, on `/review/278` with a real six-layer canvas:

| What | Value |
|---|---|
| Largest contentful paint | 291 ms |
| Time to first byte | 3 ms |
| Cumulative layout shift | 0.00 |
| Console errors | none |
| Lighthouse accessibility | 97 |
| Lighthouse best practices | 100 |

That version had no web fonts, a fixed header bar height, and diffs rendered into a host reserved
per file card. The stylesheet now loads component files through CSS imports; rerun the measurements
after changing page assets. Two Lighthouse audits failed: touch
target size, on a tool that is used with a keyboard and a mouse, and a missing meta description on a
page nothing indexes. Interaction to next paint is not measured; it needs a scripted interaction.
