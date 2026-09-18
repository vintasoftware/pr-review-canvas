# Update the review canvas for a {{TARGET_WORD}}

This {{TARGET_WORD}} already has a canvas, generated for a commit this head was built on. Your task
is to bring that canvas to the current head: keep what the new commits leave untouched, decide anew
what they changed, and write the result as one JSON file.

A canvas earns a reviewer's trust by being stable. A layer they already read should come back with
the same key, the same title, and the same words; a fold they opened should still be there; a
concern they dismissed should not reappear under a new name. Rewriting a paragraph that describes
code nobody touched costs the reviewer a second reading for nothing.

## The basis canvas

{{BASIS}}

Read the basis canvas file for the exact wording of anything you carry. Its hunk ids belong to its
own diff and mean nothing here: use the hunk ids of the manifest below.

### What the head changed

{{FILE_DELTA}}

### Carry these as they stand

{{CARRIED}}

### Decide these again

{{RE_JUDGED}}

## How to update

- Start from the carried content and change it only where this list says to. Where you do depart
  from the basis canvas on an untouched file, you must have read the new code and have a reason.
- A carried layer keeps its `key`. The key is how a reviewer's progress finds the layer again, so
  never rename a key to tidy it up, and never reuse a key for a different concern.
- A new or changed file belongs wherever it fits best, which may be a carried layer. Adding a file
  to a layer is a change to that layer: its rationale must still describe what it now holds.
- A re-judged concern may come back with the same kind, path, and title, but only if you read the
  new code and it still holds. A concern the change fixed is gone, not softened.
- Write the summary and the risk tags again, from the whole change set as it is now.
- Everything below applies as it would to a canvas written from nothing: the layering rules, the
  caps, the hunk coverage, and the validator.

## Judging the change

Produce a code-quality review that a human can navigate. Read the changed behavior, its tests,
and the surrounding boundaries. Apply the project rulebook and bundled quality standards to
identify consequential structural problems, risks, and decisions that need the reviewer's judgment.
The basis canvas is the record of the structural review already done; extend it rather than
repeating it.

Explain how the change works before asking the reviewer to assess it. Prioritize a small number
of well-supported concerns; an empty attention-point list is valid. Tie each concern to concrete
code, its consequence, and the condition under which the design is acceptable. Keep proposed
changes within the PR's scope. Do not repeat automated lint findings or turn style preferences
into merge requirements.

Use `decide` for a choice requiring agreement or a substantiated structural concern that needs
resolution, `check` for a concrete verification, and `fyi` for useful context. Read relevant test
assertions before classifying behavior as covered or missing. The canvas itself runs no tests and
provides no approval on the reviewer's behalf.

Write one JSON file grouping the diff into semantic layers, linked explanations, and attention
points. A deterministic validator checks the file; a web page renders it. Write no prose outside
the JSON file.

## Project rulebook

Use these code standards to assess consequential drift and debt. Read them as reference material;
follow this prompt's workflow and output format.

{{RULEBOOK}}

### Bundled standards

{{QUALITY_STANDARDS}}

{{FORMAT}}
