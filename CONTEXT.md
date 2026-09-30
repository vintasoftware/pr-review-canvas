# PR Review Canvas

PR Review Canvas helps authors explain a pull request and reviewers examine its changes by intent.

## Language

**Canvas**:
A guided review of one change set of a pull request, combining semantic layers, source diffs, and review notes. It is generated for a particular commit, and keeps applying to any later commit whose diff is identical.
_Avoid_: Hosted review, automated approval

**Semantic layer**:
A group of related changes that explains one behavior, concern, or decision, even when those changes span files. Different parts of one file can belong to different layers.
_Avoid_: Directory, commit, stacked PR

**Chunk**:
A contiguous section of a file’s diff, including its changed lines and surrounding context. Each chunk belongs to exactly one semantic layer in a canvas.

**Fold**:
A collapsed range of a diff that a reviewer can expand to inspect. Folding a change does not mean it has been reviewed.
_Avoid_: Excluded code, deleted context

**Attention point**:
A concern anchored to changed code that asks the reviewer to decide, check, or take note.
_Avoid_: Proven bug, automatic finding

**Missing-test point**:
An attention point generated from a behavior with no test. It belongs to the reviewer unless the
writer assigns it to the author, and counts alongside explicitly written attention points.
A carried entry keeps its published title and audience; its anchor follows the carried code.

**Audience**:
Who an attention point is for. An author point asks something the author can answer alone; a reviewer point needs someone else's judgment.
_Avoid_: Severity, priority

**Self-review**:
The author's pass over their own canvas before asking for review, resolving the attention points they can answer.
_Avoid_: Self-approval, pre-review

**Resolved point**:
An author attention point answered with a reason saved in the canvas. It leaves the open-point list and stays readable with its reason for anyone loading that canvas.
_Avoid_: Dismissed, approved, closed

**Dismissal**:
A reviewer's personal mark that hides an attention point from their own list. It does not answer the point for other readers or complete the author's self-review.
_Avoid_: Resolution, approval

**Review progress**:
The reviewer's record of which changes they have examined, kept against the canvas they examined them on rather than against a commit. Progress survives every later commit that canvas keeps applying to.
_Avoid_: Test coverage, approval

**Pending review**:
A review the reviewer is still writing: comments anchored to lines, kept in the local review state
and posted to nobody, until one submission sends them together with a verdict. Discarding it
withdraws nothing, because nothing was ever sent.
_Avoid_: Draft pull request, unsaved comment, queued request

**Local review app**:
The review interface and saved review state on the reviewer's machine. GitHub operations and AI requests still communicate with their respective services.
_Avoid_: Offline AI, code never leaves the machine

**Carried-over canvas**:
A canvas generated for an earlier commit of the pull request, shown as current because the head's diff is identical to the one the canvas was generated from.
_Avoid_: Merge-tolerant canvas, approximately matching canvas

**Incremental canvas**:
A canvas generated for a new commit of a pull request that already had one, built by updating that earlier canvas rather than by starting from a blank page.
_Avoid_: Partial canvas, diff of canvases

**Basis canvas**:
The earlier canvas an incremental canvas is built from: the newest one generated for a commit the head was built on. A canvas from a line of work the head no longer contains is never a basis.
_Avoid_: Parent canvas, carried-over canvas

**Carried**:
Content of the basis canvas reused as it stands, because the head's diff leaves the code it is anchored to untouched. An attention point whose own lines are unchanged is carried even when they moved; only its line numbers follow them.
_Avoid_: Cached, approved, still valid

**Re-judged**:
Content of the basis canvas that the head's diff touched, which the generator decides anew. It may come back the same, changed, or not at all.
_Avoid_: Invalidated, rejected, expired

**Outdated canvas**:
A canvas of another commit of the pull request that the head's diff no longer matches, shown with the diff of its own commit and a bar saying so. Review marks made on it stay with it and never count for a later canvas.
_Avoid_: Stale review, expired canvas

**Review checkout**:
A copy of the repository at the reviewed commit, kept apart from the reader's own checkout, which the AI chat reads code from. It follows the commit being chatted about, and is removed once nobody has chatted about that review for a while; it comes back on the next chat turn. A review of uncommitted work has none: the chat reads the reader's own checkout, because that is the work under review.
_Avoid_: PR checkout, reader's checkout, working tree, materialized head

**Illustrative sample**:
An attributed walkthrough of selected changes from a public pull request, with editorial layer groupings and scripted chat examples. It demonstrates concepts without claiming to be a complete generated canvas.
_Avoid_: Live review, live AI chat

## Tour

**Tour**:
A guided pass over one change that builds the reader's theory of it: landmarks that explain, decisions the reader keeps or changes, and a quiz. It is generated once per head commit and shared like a canvas, so the author and every reviewer take the same tour; it stands beside the canvas, and either can be used without the other.
_Avoid_: Self-review, Walkthrough, Deck, Onboarding

**Landmark**:
One idea of a tour, told in order: first the world before the change and why the change matters, then what the change means to the world, then why each part is the way it is, last what a later change must respect. The code behind a landmark is available but never required.
_Avoid_: Beat, Semantic layer, Slide, File

**Scene**:
A picture, drawn for this change, of what a landmark or a decision's side does.
_Avoid_: Screenshot, Illustration

**Micro-world**:
A landmark the reader plays with: inputs of the changed behavior go in, outcomes come out. A tour has one only when the change has behavior worth playing with.
_Avoid_: Demo, Sandbox, Playground

**Decision**:
A choice the change makes that a reasonable engineer could make another way, anchored on a landmark. The reader keeps it or asks to change it; keeping records a reason, changing starts a grilling.
_Avoid_: Attention point, Card, Finding, Issue

**Pokayoke**:
A structure in the change that makes a class of mistake impossible, or a place where the change lacks one. A decision category.
_Avoid_: Validation, Guardrail, Defensive code

**Reason**:
The author's justification for a kept decision, together with where it belongs: in the code, on the pull request, as a lint rule, or in the tour only.
_Avoid_: Resolution, Justification comment

**Grilling**:
The agent's questions after a change pick, asked until it can restate the change.
_Avoid_: Chat, Interview, Clarification

**Restatement**:
The agent's own words for a requested change: what changes, where, and what stays the same. The reader approves, edits, or rejects it, and only an approved restatement enters the plan.
_Avoid_: Summary, Transcript, Spec

**Reverse quiz**:
The reader's questions to the agent about how it would carry out the plan, asked to catch a wrong understanding before anything runs.
_Avoid_: Quiz, Dry run

**Plan**:
The approved restatements of a tour, restated once as a whole at the end and confirmed by the reader. It needs no further review before an agent implements it.
_Avoid_: Fix list, Prompt, Task list

**Quiz**:
A few plain questions after the decisions that check the reader read the landmarks: what users would notice, and which decisions were made and why. A wrong answer reopens the landmark, and the result stays with the reader.
_Avoid_: Test, Score, Assessment

**Try-it**:
A recipe, verified when the tour was generated, for experiencing the real change: how to run it, which synthetic data to use, and what to look at.
_Avoid_: Screenshot, Demo, Smoke test

**Guide**:
The project's committed notes for tours: how to run the app, how to make synthetic test data, which non-functional requirements matter, where specs and designs live, and what the agent may run. Written in setup and edited as the reader steers the skills.
_Avoid_: Config, Rulebook, Runbook

**State landmark**:
The landmark a tour gives a change to a schema, a migration, or the shape of stored data: the shape before and after, what happens to existing rows, and how it is undone. Never cut by the budget.
_Avoid_: Migration landmark, Database landmark

**Blast radius**:
What a change touches among the areas the project marks as high risk, shown on the cover. It raises the tour's budget and tells a team whether the tour is required.
_Avoid_: Risk score, Severity

**Not toured**:
What a tour's budget left out, listed at the end with a link to the code.
_Avoid_: Excluded, Skipped, Fold
