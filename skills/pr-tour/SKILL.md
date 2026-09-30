---
name: pr-tour
description: Generate a tour of a GitHub pull request or GitLab merge request, of the work in this clone before a pull request exists, or of two refs, with the pr-review tool. A tour is a guided pass over one change that builds the reader's theory of it, landmarks with scenes, decisions to keep or change, and a quiz, shared like a canvas and taken in the review page at /tour/<key>. Runs `pr-review tour prepare`, writes the tour model and its scene files, validates and previews them, and runs `pr-review tour publish`. Use when the user runs `/pr-tour <pr-number>`, `/pr-tour branch`, `/pr-tour uncommitted`, `/pr-tour --base <ref> --head <ref>`, or asks for a tour of a change.
---

# pr-tour

You produce one JSON file, the tour model, plus one scene file per landmark, and hand them to the
`pr-review` CLI. The CLI does the deterministic work (fetching, diffs, the budget, validation,
storage, sharing); you do the reading, the writing, the drawing, and the looking. Nothing here
checks out a branch or writes outside the tour directory. Run every `pr-review` command from the
repository root.

Arguments: `<pr-number> [--force]`, `branch [--base <ref>] [--force]`,
`uncommitted [--base <ref>] [--force]`, or `--base <ref> --head <ref> [--force]`. `--force`
regenerates a tour that already exists for the head commit: prepare clears the tour directory but
the published `tour.json` and the log, so you start fresh while the page keeps showing the old tour
until your publish replaces it.

## Model choice

The project picks the model. Prepare prints `models`, keyed by agent id: `tour.models` in
`pr-review.config.yml` over `generation.models`, so Claude generates with Opus unless the project
names another model. Generate with the model under your own agent id; with no entry, keep the model
you run on. When the prepared diff changes authentication, access policy, or protected health
information handling, use a more capable model when available. Honor an explicit user choice.

When the model to use is not the one you run on, delegate generation and validation to a subagent
on that model with the prepared prompt and paths; it writes the same files. Record the model that
actually generated the tour when publishing.

## Flow

### 0. The guide

The tour reads the project's guide, `docs/pr-tour.md` by default (`tour.guide` in the config):
how to run the app, how to make synthetic data, which non-functional requirements matter, where
specs live, what you may run. Prepare reports `guide: null` when the project has none. Then run
the `/pr-tour-setup` interview first, unless the user says to skip it; a tour without a guide has
no try-it recipes and names non-functional requirements only where the code makes them plain.

### 1. Prepare

```bash
pr-review tour prepare --pr <n> [--force]
pr-review tour prepare --branch [--base <ref>] [--force]
pr-review tour prepare --uncommitted [--base <ref>] [--force]
pr-review tour prepare --base <ref> --head <ref> [--force]
```

The skill word maps to the flag, as for the canvas: `/pr-tour branch` runs `tour prepare --branch`.
`--branch` is the tip of the current branch; `--uncommitted` snapshots the working tree into a
commit of its own. They are separate reviews with separate pages and threads. When the user only
says "tour my work", ask which.

Progress goes to stderr. The last stdout line is JSON:

```json
{
  "tourDir": "...",
  "headSha": "...",
  "mergeBaseSha": "...",
  "promptPath": "...",
  "contextPath": "...",
  "scenesDir": "...",
  "sceneGuidePath": "...",
  "models": { "claude": "opus" },
  "sharing": "shared",
  "blastRadius": ["auth"],
  "budget": { "landmarks": 5, "decisions": 3, "quiz": 3 },
  "guide": "docs/pr-tour.md",
  "status": "prepared"
}
```

- `sharing` is `"shared"` when publish will post the tour as its own PR/MR comment, or `"off"`
  (including refs and local runs). Tell the user before publishing when sharing is on.
- `blastRadius` is what the change touches among the project's high-risk areas; it raised the
  budget. Tell the user: a team that routes review by risk wants to know.
- `status: "exists"` means a tour already exists for this head. Stop and tell the user: "tour
  already exists for <headSha>; run with --force to regenerate".
- An `{ "error": … }` line means prepare failed. Report the code, message, and hint verbatim and
  stop.

For a local run the JSON carries `local` with the review's name, the base, the branch, and whether
uncommitted work is in it. Tell the user all four.

### 2. Read the task

Read `promptPath` in full: it holds the change, the guide, the manifest, the diffs, the budget,
the rules for landmarks, decisions, and the quiz, the caps, and the JSON schema. Read
`sceneGuidePath` before drawing a scene: the kit, the frame, and the catalog of pictures. Read any
untouched file with `git show <headSha>:<path>` from the repository root. Do not check anything
out.

### 3. Write the model and the scenes

Write `<tourDir>/tour-model.json` matching the schema in the prompt, JSON only. Write each
landmark's scene to `<scenesDir>/<landmark id>.scene.html`, and at most one micro-world to
`<scenesDir>/<landmark id>.micro.html`. Use the host's file-writing tool (such as Write); a shell
heredoc into a data directory may be refused by write guards. If you cannot write there, run
prepare again with `--data-dir <a directory you can write>/.pr-review` and use the paths it prints;
tell the user `pr-review serve` shows the tour only with that same `--data-dir`.

The prompt is the spec. In short: the first landmark is the background (the world before the
change, and why the change matters), then the world, then the whys with the decisions anchored on
them, then what to respect; every landmark has a scene, its code chunks with a literate diff, and
its guards; every decision has both sides' costs, a recommended side, a reason with its place, and
an anchor in the diff; the quiz checks reading, never gotchas. A state landmark is required when
the change touches stored data. Stay within the budget prepare printed.

### 4. Try-it recipes

A product decision may carry a `tryIt` recipe, from the guide's run instructions. Run the recipe
yourself, with the synthetic data the guide names and nothing else, and set `verified: true` only
when you saw what `look` describes. A recipe you could not run is left out of the model, with a
line to the user on why. The review server executes nothing: the reader runs the recipe in their
own terminal.

### 5. Validate, preview, publish

```bash
pr-review tour validate <tourDir>/tour-model.json --tour <tourDir> --human
pr-review tour preview <tourDir>
pr-review tour publish <tourDir> --agent <your agent id> --model <model id if you know it> --harness <claude-code|codex|other>
```

Validate prints `ok: …` or one line per problem, `CODE where: message`; fix exactly what it names
and run it again. Preview writes two screenshots per landmark, desktop and phone, under
`<tourDir>/preview/`, and prints their paths; look at every one and fix what reads badly: text that
collides, a scene that says nothing at rest, a picture that is the same as the last. Without a
browser it prints a `previewUrl` to open in a browser tool instead. Then publish. On failure the
command prints one line per problem, then an error line, and exits 5; fix the named problems and
publish again, giving up after the prompt's `maxRepairRounds`.

`CANVAS_STALE` means the head, branch, or working tree moved while you worked. Tell the user and
offer to run prepare again; pass `--allow-stale` only when the user asks for the tour of the old
commit.

### 6. Report

On success the last line is `{ "status": "published", "sharing", "headSha", "tourJsonPath",
"attempts", "tourUrl" }`. Report `tourUrl` (start `pr-review serve` to open it) and inspect
`sharing` as for a canvas: `shared` links to `sharing.url`; `off` says nothing was posted and does
not offer to; `failed` warns, quotes `sharing.warning`, and gives the ZIP path to attach by hand;
`local` is a run with no pull request.

Then hand over: the tour is the recommended pass before review. Ask the author to take it at
`tourUrl`: read the landmarks, keep or change each decision, take the quiz, confirm the plan. Say
how many landmarks, decisions, and questions it has, what the blast radius is, and which decision
you recommend changing, if any.

## Rules the validator enforces

- The first landmark is the background, the second the world, the last what to respect; every
  landmark between is a why; each of the other three appears once.
- At most the budget's landmarks, decisions, and quiz questions; a state landmark does not count.
- A state landmark when the change touches stored data, with a trade-off decision on reversibility.
- Every decision anchors on a why or respect landmark of this tour and on a new-side line inside a
  hunk; every quiz question names a landmark of this tour.
- Code chunks and literate snippets name files of the diff and start with their `@@` header; a
  literate `chunk` index exists.
- Guards name test files that exist at the head.
- Scenes pass the frame's checks (the scene guide lists them); a scene takes no input, a
  micro-world takes it only through its controls; at most one micro-world.
- Categories the project turned off are not used; a `tryIt` is `verified` or absent.
- Every text within its cap, measured on what a reader sees.

## Updating a shared tour

After new commits, run this skill again for the pull request number. A new head gets a new tour;
the reader's picks carry by decision key, so keep the keys of decisions that still hold. Add
`--force` to regenerate the tour of the same commit.
