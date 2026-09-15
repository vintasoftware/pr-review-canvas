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

| Option | Applies to | Default and behavior |
|---|---|---|
| `--repo <dir>` | All commands | Uses the current directory when omitted; resolves the repository root from there |
| `--data-dir <dir>` | All except `install-skill` | Overrides `PR_REVIEW_DATA_DIR`, then the default `<main checkout>/.pr-review` |
| `--port <n>` | `serve` | Overrides `PR_REVIEW_PORT`, then `3010`; accepts 1–65535 |
| `--agent claude\|codex` | `serve` | Overrides the saved chat agent for this run |
| `--model <id>` | `serve` | Overrides the saved chat model for this run |
| `--fixture-canvas <review.json>` | `serve` | Development preview: uses the supplied canvas for every requested PR, with its head replaced by the live PR head |

Repository operations require an `origin` remote on **github.com**. GitHub Enterprise Server
hosts are not supported. Fetching a PR does not check out its branch.

### Prepare, validate, and publish

These commands support custom generation workflows. The bundled
[generation skill](../skills/pr-review-canvas/SKILL.md) describes the complete sequence and model rules.

```text
pr-review prepare (--pr <n> | --base <ref> --head <ref>) [--force]
pr-review validate <model.json|review.json> --canvas <dir> [--human] [--fix]
pr-review publish <canvasDir> --agent <id> [--model <id>] --harness claude-code|codex|other [--allow-stale]
```

`prepare` returns `canvasDir`, `headSha`, `mergeBaseSha`, `promptPath`, `contextPath`, and `status`.
A status of `exists` means that head already has a canvas. With `--force`, preparation clears the
previous generation's working files while keeping the published canvas available until a new
publish succeeds.

For a comparison before a PR exists, use local refs:

```bash
pr-review prepare --base origin/main --head HEAD
```

`validate` checks the supplied file against the context in `--canvas`. By default it returns
`{ ok, errors }`; `--human` prints readable diagnostics. `--fix` edits overlong titles by removing
the explanation after the first `:` or `—` and reports the changes. Titles that still exceed the
limit and overlong prose require rewriting.

`publish` returns `status`, `headSha`, `reviewJsonPath`, `attempts`, and a `reviewUrl` for PR runs.
Its `--agent`, `--model`, and `--harness` describe who generated the canvas; they do not launch or
select an agent. `--allow-stale` permits publishing for the prepared commit after the PR head has
moved. Use it only when that older commit is the intended review target.

For more than 400 changed files or 50,000 added/deleted lines, preparation leaves diffs out of the
prompt and directs the generator to read patch files individually. Smaller diffs are inlined up
to `generation.inlineDiffMaxLines`.

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
- `import --pr` compares the imported canvas with that PR's current head. Without it, import does
  not check against a live PR.
- Import returns `ready`, `stale`, or `exists`, plus commit information and warnings. `exists`
  keeps a stored canvas generated at the same time or later. `derivable: false` means the canvas
  was accepted but its source diffs could not be rebuilt from Git.
- `import --force` allows a canvas from another repository. It does not force an older canvas to
  replace a newer one.

Imports accept archives up to **20 MiB**. The required `manifest.json` and `review.json` entries
must be at the archive root and pass format validation. If the necessary commits are missing,
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

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error, including a failed `doctor` check |
| `2` | Command usage error, such as an unknown command or missing required flag |
| `4` | GitHub CLI missing or unauthenticated |
| `5` | Validation failed in `validate` or `publish` |

`doctor` reports failed checks with exit `1`, including authentication failures.

## Project config

All keys are optional. See the [example configuration](../pr-review.config.example.yml) for a
starting file. Invalid YAML or invalid values produce a warning and fall back to the defaults.
Lists you supply replace their defaults.

Path patterns match repository-relative paths. `**` crosses directories; `*` and `?` match
within one path segment.

| Key | Default | Details |
|---|---|---|
| `version` | `1` | The only supported configuration version |
| `rulebook` | Unset | Path to a Markdown file of project code standards, resolved from the repository root; these standards take precedence over bundled standards |
| `layers` | `[]` | Optional review guidance; each entry has `id`, `title`, `description`, and optional `paths` patterns. The agent may combine, split, or reorder groups. When omitted or empty, it chooses semantic sections from the change |
| `highRisk` | `[]` | Entries with a `pattern` glob and `label`; matching changes receive risk labels and cannot go in the Other layer |
| `generation.mode` | `strict` | See [generation modes](#generation-modes) |
| `generation.maxRepairRounds` | `3` | Failed validation rounds allowed by the generation skill |
| `generation.inlineDiffMaxLines` | `1500` | Maximum diff length to include directly in the generation prompt |
| `generation.smallPrHunks` | `10` | At or below this hunk count, the prompt asks for one layer unless concerns differ |
| `generation.caps` | See below | Overrides individual text limits |
| `tests.patterns` | `['**/*.test.*', '**/*.spec.*', '**/__tests__/**']` | Paths treated as tests for review ordering and labels |
| `chat.enabled` | `true` | Set to `false` to disable AI Chat |
| `prompts` | Bundled templates | See [prompt templates](#prompt-templates) for supported keys and behavior |

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

| Key | Purpose |
|---|---|
| `generation-format.md` | Schema and output rules |
| `generation-strict.md` | Instructions for strict mode |
| `generation-surfacing.md` | Instructions for surfacing mode |
| `quality-standards.md` | Bundled code standards |
| `layering-guidance.md` | Guidance for grouping related changes |
| `chat-seed.md` | Opening AI Chat instructions |

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

| Key | Default |
|---|---|
| `summary` | 1200 |
| `layerTitle` | 60 |
| `rationale` | 300 |
| `decisions` | 600 |
| `checkByHand` | 400 |
| `annotation` | 240 |
| `pointTitle` | 90 |
| `pointBody` | 600 |
| `testBehavior` | 120 |
| `diagram` | 1500 |

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

| Key | Default | Accepted values |
|---|---|---|
| `version` | `1` | `1` |
| `skin` | `terminal` | `terminal`, `github` |
| `theme` | `auto` | `auto`, `light`, `dark` |
| `agent` | `claude` | `claude`, `codex` |
| `model` | `null` | A model ID, or `null` for the agent's default |
| `chatTimeoutSec` | `600` | Integer seconds, 30–3600 |
| `maxTurns` | `null` | Integer 1–100, or `null` for the agent's default |

Invalid settings fall back to defaults. URL parameters `?skin=github&theme=light` can override
appearance for one page load without saving it.

By default, Git worktrees of the same clone share the main checkout's data directory. Separate
clones have separate data. An explicit data-directory override also relocates `settings.yml`,
canvases, review progress, and chat history.

The data directory contains exported archives, saved canvases, generation inputs, cached GitHub
data, source diffs, and personal review progress. Its own `.gitignore` excludes its contents.
Deleting the directory loses saved preferences, canvases, progress, and chat history.

## Review controls

### Links to specific code

Append a fragment to `/review/<pr-number>`:

| Target | Fragment example |
|---|---|
| Layer | `#layer:data-access` |
| File | `#file:src/store.ts` |
| Hunk | `#hunk:src/store.ts#2` |
| New-side line range | `#line:src/store.ts:40-52` |
| Old-side line | `#line:src/store.ts:40:old` |

Use the layer key and file path from the canvas. Links open the target file when needed; if a
line is unavailable, navigation uses the nearest visible row. Recipients need their own running
server and the corresponding canvas to use a localhost link.

### Collapsed diffs

Import-only changes, whitespace changes, moved code, and ranges selected by the generator may
start collapsed. Click the summary to expand them. Moves are detected within a file; moves
between files appear as deletions and additions. Edited moves keep their changed text visible.
Collapsing content does not mark it reviewed.

Files with patches longer than 2,000 lines wait behind **show diff**. A link into the file opens
it automatically.

### Finding shared canvases

Discovery checks the PR description and comments for canvas ZIP links. It prefers a filename
matching the current head, then the PR number, then the most recently edited source text.
If a download fails, it tries other matching attachments. Keep the exported filename so the
canvas can be recognized.

When automatic download fails, download the archive in GitHub's UI and use the page's drop zone
or `pr-review import <zip> --pr <n>`.

### Comments and sign-off

You can post inline comments, replies, PR-level comments, and attention points. Inline comments
must target lines in the diff. Posting uses your GitHub CLI account and remains subject to its
repository permissions.

The sign-off dialog previews an editable review body summarizing reviewed layers, dismissed
attention points, and comments posted from the canvas. Approval requires every layer except
**Other changes** to be reviewed for the current head. Requesting changes does not require that
completion. If the head moves before submission, reload and review the current commit.

## AI Chat

**Ask** on a layer, file, attention point, or line selection chooses the context for your message.
Choosing another target replaces it; **clear** returns to the whole PR. The `a` key asks about
the focused target, and `/` focuses the message box.

Chat can propose an inline GitHub comment. A valid proposal appears with controls to post, edit,
or copy it. A proposal outside the current diff remains text with an explanation.

Use **stop** to interrupt a reply. Only one chat turn can run per PR at a time. A timeout or
incomplete answer can be retried; increase `chatTimeoutSec` if replies need more time.

## Network access and permissions

The server binds to `127.0.0.1` and rejects browser writes from other origins. It is intended for
local use with your GitHub login.

GitHub requests fetch PR data and attachments and submit the comments or reviews you choose to
post. Rendered Markdown can load images from HTTPS hosts. Generation and chat send review
context to the selected coding agent and its configured provider.

Chat is instructed to read code without changing it, but the tool does not provide a filesystem
sandbox for the agent. Its access also depends on the agent's own permissions. Disable chat with
`chat.enabled: false` if those permissions are unsuitable for the project.

## Troubleshooting

| Symptom or code | Next step |
|---|---|
| `NOT_A_REPO` | Run inside a Git clone or pass `--repo <dir>` |
| `NO_ORIGIN` | Check that `origin` points to a repository on github.com |
| `GH_MISSING` / `GH_UNAUTHENTICATED` | Install [GitHub CLI](https://cli.github.com), run `gh auth login`, and check authentication in the same environment that runs the server |
| `GITHUB_API_ERROR` | Read the underlying error for permissions, rate limits, connectivity, or GitHub service problems |
| `PR_NOT_FOUND` | Check the PR number, repository, and your access |
| `CANVAS_NOT_FOUND` | Generate or import a canvas for the requested commit |
| `CANVAS_INVALID` | Read the format errors; re-export or regenerate the canvas |
| `CANVAS_REPO_MISMATCH` | Check which clone is open; use `import --force` only when importing from the other repository is intentional |
| `CANVAS_TOO_LARGE` | The archive exceeds the 20 MiB import limit |
| `CANVAS_STALE` | The PR head moved; prepare again for the current commit |
| `MODEL_INVALID` | Fix the reported problems in `model.json`, validate, then publish again |
| `SKILL_DIR_EXISTS` | The destination contains a customized directory; preserve it elsewhere before replacing it with `--force` |
| `CHAT_BUSY` | Wait for the running reply or press **stop** |
| `AGENT_AUTH_REQUIRED` | Sign in through the selected agent's CLI, then retry |
| `AGENT_MISSING` or missing chat pane | Check `chat.enabled` and confirm the server can find `acpx` and the selected agent; run `pr-review doctor --all-checks` |
| `AGENT_INCOMPLETE` | Retry the message or increase the chat timeout |
| `COMMENT_FORBIDDEN` | Check the GitHub account's repository access and token permissions |
| `COMMENT_LINE_NOT_IN_DIFF` | Choose a line shown in the current diff |
| `SIGNOFF_INCOMPLETE` | Mark every layer except Other reviewed for this head |
| `FORBIDDEN_HOST` / `CROSS_ORIGIN` | Open the local server using `localhost` or `127.0.0.1` and submit actions from that page |

### Validation diagnostics

Validation reports name the field, file, hunk, or line to fix. Common groups are:

| Codes | What to check |
|---|---|
| `SCHEMA`, `TEXT_TOO_LONG` | Required fields, types, and text limits |
| `HUNK_UNASSIGNED`, `HUNK_DUPLICATE`, `HUNK_UNKNOWN` | Each known hunk belongs to exactly one layer |
| `PATH_UNKNOWN`, `TEST_PATH_UNKNOWN` | Referenced files exist in the relevant diff or PR head |
| `LAYER_EMPTY`, `LAYER_KEY_DUPLICATE` | Layers contain hunks and have unique keys |
| `OTHER_DUPLICATE`, `OTHER_NOT_LAST`, `RISK_IN_OTHER` | At most one Other layer, last, without risk-tagged changes |
| `TEST_NOT_LAST`, `TEST_IN_OTHER` | Tests follow the code they cover and use the appropriate layer |
| `ANNOTATION_OUTSIDE_HUNK`, `POINT_OUTSIDE_DIFF`, `FOLD_INVALID` | Locations and fold ranges fit the assigned diff |
| `TOO_MANY_POINTS` | Count explicit points and missing-test entries together |
| `LINK_UNRESOLVED`, `DIAGRAM_NODE_UNKNOWN`, `DIAGRAM_LIMIT` | Link targets, diagram node IDs, and diagram counts |
