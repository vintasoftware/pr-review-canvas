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
  "budget": { "why": 2, "whyMax": 4, "decisions": 5, "quiz": 5 },
  "guide": "docs/pr-tour.md",
  "status": "prepared"
}
```

- `sharing` is `"shared"` when publish will post the tour as its own PR/MR comment, or `"off"`
  (including refs and local runs). Tell the user before publishing when sharing is on.
- `blastRadius` is what the change touches among the project's high-risk areas; it raised the
  budget. Tell the user: a team that routes review by risk wants to know.
- `guide` is the project's guide, `docs/pr-tour.md` by default (`tour.guide` in the config): how
  to run the app, how to make synthetic data, which non-functional requirements matter, where
  specs live, what you may run. When it is `null` the project has none. Run the `/pr-tour-setup`
  interview then, unless the user says to skip it, and run prepare again so the prompt carries the
  new guide. A tour without a guide has no try-it recipes and names non-functional
  requirements only where the code makes them plain.
- `status: "exists"` means a tour already exists for this head. Stop and tell the user: "tour
  already exists for <headSha>; run with --force to regenerate".
- An `{ "error": … }` line means prepare failed. Report the code, message, and hint verbatim and
  stop.

For a local run the JSON carries `local` with the review's name, the base, the branch, and whether
uncommitted work is in it. Tell the user all four.

### 2. Read the task

Read `promptPath` in full: it holds the change, the guide, the manifest, the diffs, the budget,
the rules for landmarks, decisions, and the quiz, the caps, and the JSON schema. Read
`sceneGuidePath` in full before drawing a scene: how to pick a technique, the change grammar, the
catalog, the frame, and the kit. Then look at the gallery beside it: real pull requests drawn
well. Read `gallery/README.md`, run `pr-review tour gallery <slug> …` for the entries nearest the
pictures you plan, and look at the pictures it prints. Read any
untouched file with `git show <headSha>:<path>` from the repository root. Do not check anything
out.

### 3. Write the model and the scenes

Write `<tourDir>/tour-model.json` matching the schema in the prompt, JSON only. Write each
landmark's scene to `<scenesDir>/<landmark id>.scene.html`, and at most two micro-worlds to
`<scenesDir>/<landmark id>.micro.html`; a micro-world may stand in for its landmark's scene. Use the host's file-writing tool (such as Write); a shell
heredoc into a data directory may be refused by write guards. If you cannot write there, run
prepare again with `--data-dir <a directory you can write>/.pr-review` and use the paths it prints;
tell the user `pr-review serve` shows the tour only with that same `--data-dir`.

The prompt is the spec. In short: the first landmark is the background (the world before the
change, and why the change matters), then the world, then the whys with the decisions anchored on
them, then what to respect; every landmark has a scene and its code chunks with a literate diff;
every decision has both sides' costs, a recommended side, a reason with its place, and
an anchor in the diff; the quiz checks reading, never gotchas. A state landmark is required when
the change touches stored data. Stay within the budget prepare printed.

### 4. Try-it recipes

A product decision may carry a `tryIt` recipe, from the guide's run instructions. Run the recipe
yourself in the head checkout (`pr-review tour checkout <tourDir> head` prints its `dir`, a free
`port`, and an empty `scratch` folder), never in the reader's checkout, with the synthetic data the
guide names and nothing else. Install dependencies there first, serve on `port`, keep the run's
state (a data directory, a database file) in `scratch`, stop what you started, and set
`verified: true` only when you saw what `look` describes. Write the steps as the reader runs them,
with the guide's own command. A ref comparison has no checkout, so its recipes are left out. A recipe you could not run is left out of the model, with a
line to the user on why. The review server executes nothing: the reader runs the recipe in their
own terminal.

### 5. Validate, preview, publish

```bash
pr-review tour validate <tourDir>/tour-model.json --tour <tourDir> --human
pr-review tour preview <tourDir>
pr-review tour publish <tourDir> --agent <your agent id> --model <model id if you know it> --harness <claude-code|codex|other>
```

Validate prints `ok: …` or one line per problem, `CODE where: message`; fix exactly what it names
and run it again. Preview writes, under `<tourDir>/preview/`, each landmark's page on a desktop and
on a phone, each scene and micro-world alone at the widths a desktop and a phone give it
(`-scene.png`, `-scene-phone.png`, `-micro.png`, `-micro-phone.png`), and each decision and
question; it prints their paths. A phone page is taller than the phone shot, so judge a picture's
phone composition from its `-phone` picture, not from the page. Look at every one and fix
what reads badly: text that collides, a scene that says nothing at rest, a picture too small to
read, a picture that is the same as the last. `--landmark <id>` retakes one landmark. Without a
browser it prints a `previewUrl` to open in a browser tool instead. Then publish: it reads the
model and the scene files again, so what you fixed after the preview is what gets published. On failure the
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
- At most `why` why landmarks, one more with `overBudget` saying why, never more than `whyMax`; a
  state landmark does not count. Decisions at most one more than the why landmarks, quiz questions
  at most one fewer than all landmarks (at least two), each under its ceiling.
- A state landmark when the change touches stored data.
- Every decision anchors on a why or respect landmark of this tour and on a new-side line inside a
  hunk; every quiz question names a landmark of this tour.
- Code chunks and literate snippets name files of the diff and start with their `@@` header; a
  literate `chunk` index exists.
- Every landmark has a picture: the background a scene, any other landmark a scene or a
  micro-world standing in for it.
- Scenes pass the frame's checks (the scene guide lists them); a scene takes no input, a
  micro-world takes it only through its controls; at most two micro-worlds.
- Every scene names its technique (`data-technique` on its root), and no technique draws more
  than two scenes of a tour.
- Categories the project turned off are not used; a `tryIt` is `verified` or absent.
- Every text within its cap, measured on what a reader sees.

## Updating a shared tour

After new commits, run this skill again for the pull request number. A new head gets a new tour;
the reader's picks carry by decision key, so keep the keys of decisions that still hold. Add
`--force` to regenerate the tour of the same commit.
