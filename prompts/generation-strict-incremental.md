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

Read basis-model.json for the exact model fields and wording to carry. Chunk ids are recomputed
for each file: adding a chunk shifts later ids. Use the current manifest to reassign them, even
when carrying a point or annotation from an unchanged part of a changed file. Generated missing-test
points are recreated from tests entries; carry their title, audience, and anchor, not duplicate
explicit points. When the carried-point list prints moved lines, update the test entry's anchor too.

### What the head changed

{{FILE_DELTA}}

### Carry these as they stand

{{CARRIED}}

### Decide these again

{{RE_JUDGED}}

## How to update

- Start from the carried content and change it only where this list says to. Where you do depart
  from the basis canvas on an untouched file, you must have read the new code and have a reason.
- Check each carried attention point against the changed chunks before you copy it. When a chunk
  contradicts it (the point says nothing calls a function, and a new chunk calls it), decide it
  again: drop it, or write what is true now under a new title and name that chunk in the body. A
  new title starts the point unresolved, so the author's answer to the old claim does not follow.
  Reword a carried point for no other reason.
- A carried layer keeps its `key`. The key is how a reviewer's progress finds the layer again, so
  never rename a key to tidy it up, and never reuse a key for a different concern.
- A new or changed file belongs wherever it fits best, which may be a carried layer. Adding a file
  to a layer is a change to that layer: its rationale must still describe what it now holds.
- A re-judged concern may come back with the same kind, path, and title, but only if you read the
  new code and it still holds. A concern the change fixed is gone, not softened.
- Write the summary and model risk tags again, from the whole change set as it is now.
  A carried layer may gain or lose a model risk tag; its copied prose stays the same. Config risk
  tags are added by publish.
- Everything below applies as it would to a canvas written from nothing: the layering rules, the
  caps, the hunk coverage, and the validator.

## Judging the change

Produce a code-quality review that a human can navigate. Read the changed behavior, its tests,
and the surrounding boundaries. Apply the project rulebook and bundled quality standards to
identify consequential structural problems, risks, and decisions that need the reviewer's judgment.
The basis canvas is the record of the structural review already done; extend it rather than
repeating it.

{{JUDGING}}
