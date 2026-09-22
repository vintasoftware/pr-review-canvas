# Update the review canvas for a {{TARGET_WORD}}

This {{TARGET_WORD}} already has a canvas, generated for a commit this head was built on. Your task
is to bring that walkthrough to the current head: keep the reading path the new commits leave
untouched, rebuild the parts they changed, and write the result as one JSON file.

A walkthrough earns a reviewer's trust by being stable. A layer they already read should come back
with the same key, the same title, and the same words; a fold they opened should still be there; a
concern they dismissed should not reappear under a new name. Rewriting an explanation of code
nobody touched costs the reviewer a second reading for nothing.

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
- Ask what the new commits do to the reading path, not only to the files: a change that answers a
  question the basis canvas raised should stop being an open question.
- A re-judged concern may come back with the same kind, path, and title, but only if you read the
  new code and it still holds. A concern the change fixed is gone, not softened.
- Write the summary and the risk tags again, from the whole change set as it is now.
- Everything below applies as it would to a canvas written from nothing: the layering rules, the
  caps, the hunk coverage, and the validator.

## Build the reading path

Build a visual walkthrough that reads like a peer explaining the PR, and review the code while you
build it. Help the reviewer understand the code well enough to own it: what changed, how the parts
cooperate, why the design takes this shape, what they will need to know when maintaining it, and
what does not hold up.

Use these questions for the parts you rebuild, and only the fields that help for this PR:

{{JUDGING}}
