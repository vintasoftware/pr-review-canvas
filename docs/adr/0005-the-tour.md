# The tour: a guided pass that builds the reader's theory of a change, apart from the canvas

A **tour** is a guided pass over one change. It builds the reader's theory of the change through
landmarks that explain, decisions the reader keeps or changes, and a quiz. A tour and a canvas
(layers, folds, attention points) are generated from the same diff, but we generate the tour with
its own skill, store it as its own file per head commit, and share it as its own pull request
comment. The two meet only through links between their pages. Author and reviewer may use the
tour, the canvas, or both.

This record holds the design settled on 2026-09-28, before any code. The glossary for it is the
"Tour" section of [CONTEXT.md](../../CONTEXT.md).

## Why

Two objectives, in this order:

1. Learn what was implemented without reading all the code.
2. Decide the trade-offs, the architecture, the non-functional requirements, and the product
   implications (UI, UX, performance, feel) of the change.

Both with as little cognitive load as possible, and with some fun.

The reading behind it:

- Naur, [Programming as Theory Building](https://pages.cs.wisc.edu/~remzi/Naur.pdf): the product
  of programming is the theory held by the people who built it, not the text. Having the theory
  means you can say how the code maps to the world, why each part is what it is, and how to change
  it. Documentation is auxiliary. A program dies when the team holding its theory dissolves.
- Storey and Willison, [cognitive debt](https://simonwillison.net/2026/Feb/15/cognitive-debt/):
  the debt lives in developers' heads. Features prompted into existence without review made every
  later feature harder to reason about.
- Litt, [Understanding is the new bottleneck](https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck):
  explanations as literate prose arranged by idea with figures, quizzes as speed regulators,
  micro-worlds where agents write code to help us understand code, shared spaces for team models.
  His [explain-diff skill](https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524)
  is the same idea as a prompt: background, intuition with toy data and figures, a code
  walkthrough grouped in an understandable order, five medium questions with feedback, one long
  page. A "literate diff" is that walkthrough: prose in a sensible order with embedded snippets,
  faster to review than a raw diff.
- Litt, [AI HUDs](https://www.geoffreylitt.com/2025/07/27/enough-ai-copilots-we-need-ai-huds) and
  [the generated debugger](https://www.geoffreylitt.com/2024/12/22/making-programming-more-fun-with-an-ai-generated-debugger):
  show rather than converse; a bespoke tool built for the moment turns a slog into puzzles.
- Litt, [Code like a surgeon](https://www.geoffreylitt.com/2025/10/24/code-like-a-surgeon): agents
  prepare the operating room; the human keeps the primary work with fast feedback loops.
- [Kun Chen](https://x.com/kunchenguid/status/2094609213532332528): agents cannot judge "how does
  it feel". Only a human who experiences the thing can.
- [staysaasy](https://x.com/staysaasy/status/2101692598674993592): people do not want more
  decisions. Every decision a tool asks is a cost.
- [Berkopec](https://x.com/nateberkopec/status/2099617912550289763):
  [pokayoke](https://en.wikipedia.org/wiki/Poka-yoke). Structures that make a class of mistake
  impossible are what to validate in generated code.
- [cekrem on Naur](https://cekrem.github.io/posts/programming-as-theory-building-naur/): generated
  code is "nobody's theory"; review for theoretical consistency.
- The Pragmatic Engineer, [The end of coding by hand](https://newsletter.pragmaticengineer.com/p/the-pulse-end-of-coding-by-hand)
  (September 2026): coding by hand is over at 37signals; "nobody is reading anything"; sloppy
  features ship because nobody felt them.
- The Pragmatic Engineer, [What is happening with code reviews?](https://newsletter.pragmaticengineer.com/p/what-is-happening-with-code-reviews)
  (September 2026): teams triage review by blast radius, review the plan, the tests, and the
  schema rather than the implementation, and keep human review for accountability, knowledge
  sharing, and compliance. In more detail, seven approaches now that agents write most code:
  humans review the AI review; triage by blast radius, with human review required only for a
  change to the public API, auth, the design system, the database schema, or an agent skill;
  review the plan, the tests, and the schema, because stored data is the one part that cannot be
  regenerated and because tests cannot say whether a UI looks and feels right; produce less code;
  review everything by hand; and no human review at all, so far only at early-stage startups
  behind heavy guardrails. The reasons review exists at all: architecture conversations, missing
  tests and ignored conventions, less tech debt, knowledge sharing and the bus factor,
  accountability and traceability, compliance. Two reader comments are the tour in a sentence
  each: one wants each change to "explain the reason why it's implemented this way and either
  have me agree or push back with more context"; the other now reviews "what decisions did you
  make vs did you let the agent make" and "does this back us into a corner in terms of
  reversibility".

## The flow

1. **Setup** (optional, once per project): `/pr-tour-setup` interviews the user and writes the
   guide. `/pr-tour` runs the same interview when no guide exists, and the user may skip it.
2. **Generate**: `/pr-tour <n|branch|uncommitted>` prepares the diff, reads the guide and any specs
   it names, writes the tour, validates it, previews every landmark as a screenshot and fixes what
   reads badly, verifies the try-it recipe, and shares the tour on the pull request.
3. **Take**: the reader opens `/tour/<key>`, reads the landmarks, plays the micro-world, picks keep or
   change on each decision, is grilled on each change, answers the quiz.
4. **Finish**: the agent restates the whole plan once; the reader confirms; the tour writes the
   re-implementation prompt and shares the record, which now lists the reader as having toured.
5. **Apply**: `/pr-tour-apply` implements the plan, runs the project checks, and offers a fresh
   tour. A new head regenerates the tour and carries picks by decision key.

The author and every reviewer take the same tour. A reviewer's change requests become comments in
their pending review, posted with their verdict, plus the same prompt for the author.

## Landmarks

Landmarks open with a background, then come in Naur's order:

1. The world before the change, and why the change matters: the part of the existing system the
   change touches, told for a reader who does not know it, and the cost of leaving it as it was.
   This is the background section of Litt's explain-diff skill. It has no code and no decisions.
2. What the change means to the world: the user's or the spec's view of it.
3. Why each part is the way it is. Decisions anchor here.
4. What a later change must respect: extension points, invariants, pokayoke.

Each landmark has a scene, a picture drawn for this change. One landmark may be a micro-world: an
interactive model of the changed behavior, when the change has behavior worth playing with. The
diff chunk behind a landmark is one key away and never required.

The code behind a landmark comes in two views. The **literate diff** is the change as prose in
reading order, the rule before its uses and the bug before its fix, with each chunk embedded where
the prose reaches it. The **raw diff** is the same chunks as the diff has them. The two never
disagree about the code, because the literate view embeds the raw chunks.

Two micro-worlds from the prototype are the seed of the generation skill's catalog. A
**simulator**: the reader picks the inputs of the changed behavior (a command, a terminal or a
pipe, a flag) and watches a faithful model of the code's branches print to its streams. A **layout
switchboard**: each move of a UI change (a size, a box, a gap) toggles off and on over the same
content, and the page reports what changed. The skill gives the generator the model's full range,
scripts, SVG, and its own CSS inside the sandbox, plus a catalog of patterns like these, not a
fixed kit.

Each landmark names what **guards** the behavior it explains: the tests that pin it, found the way the
canvas finds tests per layer. A behavior with no guard becomes a decision: write the test now, or
accept the gap with a reason. Tests are reviewed through the tour, not read.

When the change touches a schema, a migration, or the shape of stored data, one landmark is the
**state landmark**: the shape before and after, what happens to existing rows, and how it is undone.
Stored data is the part of a system that cannot be regenerated, so this landmark is never cut by the
budget, and it always carries a reversibility decision.

The budget is proportional to the diff with a configurable ceiling. What the budget leaves out is
listed at the end, one line each with a link to the code, as **not toured**.

## Blast radius

The cover says what the change touches, from the project's existing `highRisk` patterns: for
example "touches: auth, schema". Those areas raise the budget, so a change to a public API, a
schema, authentication, the design system, or an agent skill gets more landmarks and decisions, and a
change that touches none of them gets a short tour. Teams that route review by risk can require
the tour for the first kind and leave it optional for the second, and reviewers know at a glance
where to spend attention.

## Decisions

A decision is a choice the change makes that a reasonable engineer could make another way. The
reader **keeps** it or asks to **change** it. The generator's recommendation is preselected, so a
keep is one tap.

Categories:

- Trade-offs: rare cases, compatibility, generality, failure policy, performance against plainness,
  reversibility, and accepting a test gap.
- Architecture and shape: where logic lives, reuse against build, new pattern against convention,
  public names.
- Product and feel: UI, UX, copy, animation, perceived performance, accessibility.
- Pokayoke: what the change makes impossible to get wrong, and where it lacks such a structure.
- The project's non-functional requirements, as the guide names them.
- Spec fidelity: where the change departs from the spec or the design it was built from.

A kept decision records a **reason** and where it belongs: a code comment (a maintainer needs it),
a comment on the pull request line (a reviewer would ask), a lint rule (the reason is a rule the
codebase can enforce, so a check is cheaper than a comment), or the tour only. The generator
proposes the place; the author confirms. Code comments and lint rules become part of the plan, and
the apply skill writes them. Pull request comments post once, when the tour is finished.

For product decisions the landmark also carries a **try-it** recipe: how to run the change, which
synthetic data to use, and what to look at. The reader marks that they tried it.

## Grilling

A change pick opens the chat with a tour seed. The agent asks its questions in prose. When it can
restate the change, it emits a fenced restatement block: what changes, where, what stays the same.
The page turns the block into a card with approve, edit, and reject. Only an approved restatement
enters the plan. The reader may also run a **reverse quiz**: ask the agent how it would carry the
plan out, to catch a wrong understanding before it runs.

At the end the agent restates the whole plan as one block. The reader confirms it, and the tour
writes the prompt. The plan needs no further review.

The reader may speak instead of type. Speech goes through the browser's Web Speech API. The page
says once where the browser sends audio; a project can turn audio off.

## Quiz

A few plain questions after the decisions that check the reader read the landmarks: what an end user
or a caller would notice, and which decisions the change made and why. Not gotchas, not edge cases
the landmarks did not cover, not details only the code shows, and not UI values nobody needs to
remember. A wrong answer reopens the landmark. The result stays with the reader and never reaches the shared tour or the pull request. A
project can turn the quiz off or require it before the prompt is written.

## Look

The tour has one look: Space Grotesk for display text, and an accent that follows the skin, so
the tour's accent button is that skin's own primary. In the github skin the accent is GitHub's
green, as Approve is, and blue stays a link; in the olive skin it is the site's olive, lime in
the dark. Each pair goes through light-dark(), so the light and dark themes both work. The page
offers the github and olive skins and the light and dark themes; the base terminal look is not
offered. A per-tour mood catalog was tried in the prototype and dropped on 2026-09-29: four
accents and display fonts added choice without adding meaning, and a fixed blue read as a link
in the github skin. Scenes and micro-worlds run in the sandboxed frame from PR 44 (no origin,
inline code only, no network). No badges, streaks, or scores.

## The guide

A committed markdown file, `docs/pr-tour.md` by default (`tour.guide` in the config points
elsewhere). It holds:

- how to run the app;
- how to make synthetic test data, and where fixtures may be written (fixture, seed, and test
  directories only);
- which non-functional requirements matter here;
- where specs and designs live (plan files, a task tool, Figma);
- what the agent may run.

The guide is an allowlist. An action it does not name is asked first and then recorded, so it is
asked once. It never holds credentials and never names a production target. The skills edit it as
the user steers them.

The generation skill runs the recipe, seeds fixtures, and records the exact steps. The review
server executes nothing: the reader runs the recipe in their terminal or hands it to their agent.

## Sharing and storage

A tour is stored beside the canvases, per head commit. On a pull request it is shared as its own
hidden comment holding the ZIP as base64. When the comment does not fit the host's limit, the skill
exports the ZIP and asks the author to attach it to the pull request; discovery finds attachment
links. Local reviews (`branch`, `uncommitted`) never share. The record is shared at generation and
again once at finish.

The shared record lists who finished the tour and when, and nothing of their quiz. On the pull
request that is a visible human sign-off: who took the change in before it merged, for the team
that wants to know and for the auditor who asks for evidence of human review. Finishing is the
signal, not approving; the verdict stays with the pull request review.

## Configuration

Under `tour:` in `pr-review.config.yml`:

| Key           | Values                                                                            | Default                                                      |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `budget`      | ceilings for landmarks, decisions, quiz questions, and changed lines per landmark | about one landmark per 150 changed lines; ceilings 8 / 5 / 5 |
| `finalQuiz`   | `on`, `off`, `required`                                                           | `on`                                                         |
| `reverseQuiz` | `on`, `off`                                                                       | `on`                                                         |
| `grill`       | `change`, `always`, `off`                                                         | `change`                                                     |
| `audio`       | `on`, `off`                                                                       | `on`, with the notice                                        |
| `microWorld`  | `on`, `off`                                                                       | `on`                                                         |
| `tryIt`       | `on`, `off`                                                                       | `on` when the guide has a run recipe                         |
| `categories`  | list                                                                              | all six                                                      |
| `share`       | `on`, `off`                                                                       | same as canvas sharing                                       |
| `models`      | per agent id                                                                      | `generation.models`                                          |
| `guide`       | path                                                                              | `docs/pr-tour.md`                                            |

The chat agent and model follow the existing chat settings. The blast radius reads the existing
`highRisk` patterns; there is no second list.

## Boundaries

- Skills: `pr-tour`, `pr-tour-setup`, `pr-tour-apply`. Skill install and upgrade handle several
  skills.
- The page is `/tour/<n|branch|uncommitted>`, with its own module, keyboard and mobile parity,
  and links from the home page and the canvas header. Every step is a browser history entry: the
  back and forward buttons move through the tour, a reload lands on the step the reader was on,
  and a step's URL can be shared.
- A tour needs no canvas: its own prepare builds the diff, its own chat subject and seed template
  serve the grilling, one chat thread per tour, and the chat agent stays read-only.
- Model choice follows `generation.models`. GitHub and GitLab both work.
- The README and the site present the tour as the recommended pass before review. The canvas's
  own self-review (resolving author points) stays and is optional. Author and reviewer may use the
  tour, the canvas, or both.
- Not in the first version: incremental tours, structured turns in acpx, local transcription,
  screenshots of the running app taken by the skill.

## Apart from the canvas

### Considered options

- **Tour content inside the canvas model.** One generation pass and one shared comment, but the
  canvas prompt grows past what a generator handles well, the canvas comment is already near
  GitHub's size limit, and a reader who wants only the tour would still need a canvas.
- **Tour decisions fed into canvas generation as settled decisions**, as PR 44's deck did. Fewer
  repeated questions on the canvas, but the two artifacts become coupled by carry rules and
  validation errors, which is what would stop the tour from becoming its own project.

### Consequences

- A change can have a tour and no canvas, or a canvas and no tour.
- The diff is prepared twice when both exist. Reading it twice was cheaper than one larger prompt.
- The tour cannot become a separate package without carrying its own prepare and sharing code,
  which is the intent.

## PR 44

PR 44 (the self-review deck) is closed. Its scene sandbox (ADR 0005 there), scene runtime, scene
guide, and preview loop are ported onto this branch. Its A/B cards, fix list, and settled
decisions fed into the canvas are not.

## Next step

Before building, iterate on a prototype tour with the maintainer: the look, the order of things,
and the interactions, without integrated functionality.

Done: the prototype was iterated on 2026-09-28 and 2026-09-29 (its findings are in the Landmarks,
Look, and Boundaries sections above), then the tour was built on this branch and the prototype
removed. Issue #44 was closed pointing here.
