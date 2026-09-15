---
name: pr-review-canvas
model: sonnet
description: Generate a review canvas for a GitHub pull request (or two refs) with the pr-review tool. Runs `pr-review prepare`, writes the layered model.json the prompt asks for, and runs `pr-review publish` until the validator passes. Use when the user runs `/pr-review-canvas <pr-number>`, `/pr-review-canvas --base <ref> --head <ref>`, or asks for a review canvas for a PR.
---

# pr-review-canvas

You produce one JSON file that groups a pull request's diff into semantic layers with attention
points, and hand it to the `pr-review` CLI. The CLI does the deterministic work (fetching, diffs,
validation, storage); you do the reading and the writing of `model.json`. Nothing here checks out
a branch or writes outside the canvas directory.

Arguments: `<pr-number> [--force]` or `--base <ref> --head <ref> [--force]`. `--force` regenerates
a canvas that already exists for the head commit: prepare removes the old `model.json` and any
other leftovers from the canvas directory, keeping `derived/`, `publish.log` (the attempts history),
and the published `review.json` + `manifest.json` (the page keeps showing the old canvas until your
publish replaces it), so you start a fresh `model.json`. Run every `pr-review` command from the
repository root.

## Flow

### Model choice

Claude Code defaults this skill to Sonnet. If the prepared diff changes authentication, access
policy, or protected health information (PHI) handling, use an Opus agent for the generation and
validation steps when available. Pass it the prepared prompt and context paths; it writes the
same model file. Honor an explicit user model choice. Other hosts keep their selected model.
Record the model that actually generated the canvas when publishing.

### 1. Prepare

```bash
pr-review prepare --pr <n> [--force]
# or, before a PR exists:
pr-review prepare --base <ref> --head <ref> [--force]
```

Progress goes to stderr. The last stdout line is JSON:

```json
{ "canvasDir": "...", "headSha": "...", "mergeBaseSha": "...", "promptPath": "...", "contextPath": "...", "status": "prepared" }
```

- `status: "exists"` means a canvas already exists for this head. Stop and tell the user:
  "canvas already exists for <headSha>; run with --force to regenerate".
- A line of the form `{ "error": { "code", "message", "hint" } }` means prepare failed. Report the
  code, message, and hint verbatim and stop. `pr-review doctor` names which of git, origin,
  `gh`, the data dir, and the skill install is missing.

### 2. Read the task

Read `promptPath` in full: it holds the pull request, the manifest with every hunk id, the diffs
(inline or by file path), the layering and length rules, the rulebook, and the JSON schema. Read
`contextPath` when you need the paths of the head files, the base files, or the patches. Read any
untouched file with `git show <headSha>:<path>` from the repository root, using the SHA returned
by prepare. The working tree may be on another branch. Do not check anything out.

### 3. Write model.json

Write `<canvasDir>/model.json` matching the schema in the prompt. Write JSON only; no prose in the
file, no comments, no markdown fence.

Prefer the host's file-writing tool (such as Write) for the canvas directory reported by prepare.
Shell heredocs may be blocked by write guards when that directory is under the user's home.

### 4. Check before publishing

```bash
pr-review validate <canvasDir>/model.json --canvas <canvasDir> --human --fix
```

Same checks the publish step runs. It prints `ok: model.json passes against <n> files`, or one
line per problem in the same form publish uses. Fix what it names and run it again until it says ok.

`--fix` first shortens the titles that are over their cap, by dropping the explainer after the
first `:` or `—`, and writes the file back. Each one is reported as
`fixed <where>: "<before>" -> "<after>"`; read them, since the shortened title is what publishes.
A title with nothing to drop is left alone for you to rewrite. Prose is never cut for you: an
over-cap rationale, note, or body reports where the cap falls in your own words
(`what fits ends at "..."`), and the rewrite is yours.

Run this before every publish, including after a repair. A publish round-trip costs more than this
command, and length caps are the usual reason a publish is rejected: they are measured on the text
a reader sees, which you cannot count reliably while writing.

### 5. Publish

```bash
pr-review publish <canvasDir> --agent <your agent id> --model <model id if you know it> --harness <claude-code|codex|other>
```

- `--agent`: a free-text id of the agent product you are: `claude`, `codex`, `gemini`, ...
- `--model`: the model id when you know it (`claude-opus-4-1`, `gpt-5`, ...); omit it otherwise.
- `--harness`: `claude-code` when you run inside Claude Code, `codex` inside Codex, `other`
  anywhere else.

On success the last line is `{ "status": "published", "headSha", "reviewJsonPath", "attempts",
"reviewUrl" }` (`reviewUrl` is absent for a `--base/--head` run).

On failure the command prints one line per problem, then an error line, and exits 5:

```
HUNK_UNASSIGNED packages_x_ts#3 in packages/x.ts (@@ -40,7 +41,9 @@) is in no layer
TEXT_TOO_LONG layers.0.rationale: 412 visible chars, cap 300
{"error":{"code":"MODEL_INVALID","message":"model.json has 2 problems","hint":"fix model.json and run publish again"}}
```

Fix exactly the named problems in `model.json` and run publish again. Give up after the number of
failed rounds the prompt states (`maxRepairRounds`, 3 by default) and report the last output
verbatim. Do not weaken the content to pass: shorten text, move hunks, fix links.

If publish prints `CANVAS_STALE`, the branch moved while you worked. Tell the user and offer to run
prepare again; pass `--allow-stale` only when the user asks for the canvas of the old commit.

### 6. Export the zip

```bash
pr-review export --head <headSha> [--pr <n>]
```

Pass `--pr <n>` when the run had a PR number, so the file name and the manifest carry it. The
command prints one JSON line with the absolute `path` of the zip.

### 7. Finish

For a PR run, report the `reviewUrl` from publish, the absolute zip path from export, and a link
to the GitHub PR from the prepared context. End with upload instructions:

> The canvas is ready at <reviewUrl> (start the server with `pr-review serve` if it is not running).
> ZIP: <path>
> If you're happy with the produced canvas, open <PR URL>, edit the PR description, drag the ZIP
> into the editor, wait for the upload to finish, and save.

For an update, tell the user to replace the old canvas attachment link with the new one.
Include these instructions in the final response without asking a question or waiting for a reply.

Uploading and saving the description are manual browser steps. Do not create a release or claim
the ZIP was uploaded. GitHub's `gh --attach` supports images and video, but not ZIP files
([supported types](https://github.com/cli/cli/blob/trunk/internal/attachments/userasset.go)).

For a `--base/--head` run, say the canvas is stored for `<headSha>`, that the zip has no PR number
yet, and that `pr-review export --pr <n>` re-exports it once the pull request exists. Include the
manual upload instructions for when the PR is ready.

## Rules the validator enforces (and models tend to break)

- Every hunk id from the manifest appears in exactly one layer. Check the manifest against your
  layers before you publish; a missed hunk is the most common failure.
- At most one layer with `kind: "other"`, last when present, and omitted when there are no
  mechanical hunks. It carries no risk tag. A test file may sit in Other only when the code it covers
  is in Other too.
- A small change set (the prompt states the hunk limit) gets one layer unless concerns truly differ.
- Test files come after the files they cover, inside the same layer, never in a layer of their own.
  The prompt's layering rules name the path patterns this project counts as tests; they are the
  ones the validator uses.
- Every text is within its cap, measured on the text a reader sees (link targets and backticks do
  not count). Rationales, notes, and annotations are one or two short sentences.
- At most 12 attention points, counting one per `missing` test entry.
- `covered` test entries name a `testPath` that exists at the PR head (changed or not).
- Annotations and attention points sit on lines inside a hunk, on the side you name.
- Links use only the four forms `#layer:`, `#file:`, `#hunk:`, `#line:` and must resolve.
- At most one diagram per layer (its `diagram` field plus a ```mermaid fence in its rationale)
  and one in the summary; a fence in any other field stays a code block. Draw only when relations
  beat prose and most canvases need zero to two diagrams in total, keep labels short, and write no
  `click` directives, HTML labels, `%%{init}%%` blocks, or `---` front matter.
- `diagram.links` maps a node id of the source to a canvas link, at most 12 per diagram. Spell the
  node id the way the source spells it (`store`, not the label in its brackets; `App`, not the
  name after `as`), and link only nodes that stand for a layer, a file, or a hunk of this canvas.
- Markdown is allowed; headings are not. No prose outside the JSON file.

## Updating a shared canvas

After new commits, run this skill again for the PR number. Add `--force` to regenerate a canvas
for the same commit. Export the new zip and ask the user to replace the attachment in their PR
description. Reviewers click **refresh** to load it. A canvas for a different
PR head shows **Canvas is outdated**; an older canvas remains readable with posting disabled.
