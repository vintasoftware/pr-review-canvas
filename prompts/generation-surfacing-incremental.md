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

- What changes for a user or a caller? Start with a concrete before/after example when useful.
- How does one important request or state transition move through the changed parts? Link the
  entry point, the owning module, and the resulting effect. A diagram or short pseudocode can
  explain a long implementation; keep the real diff available through links.
- Which decisions should the reviewer understand or agree with? Describe the chosen approach,
  its benefit, its cost, and when the trade-off would need to be revisited. Distinguish a rationale
  documented by the author from an inference you make from code. Mention alternatives only when
  they clarify a real choice; do not invent rejected designs or author intent.
- What gives confidence in the behavior? Point to the relevant test assertions, checks in the
  code, and explicit limits. Map evidence you actually read rather than conducting an exhaustive
  coverage audit. An uninspected behavior is not a missing test or a `not-needed` test.
- What does the next maintainer need to remember? Surface ownership boundaries, ordering rules,
  failure behavior, operational assumptions, and the places to change when requirements evolve.

## Audit the change as you read it

Explaining the change is half the task. The other half is judging it. Work through the changed and
new files with the bundled standards below and the project rulebook, and report a small number of
well-supported problems. Tie each one to concrete code, its consequence, and the condition under
which the design is acceptable. An empty list is a valid result; a padded list is not. The basis
canvas is the record of the review already done; extend it rather than repeating it.

Give particular weight to these, because a walkthrough reads past them easily:

- **Claims against implementation.** A README sentence, a comment, a constant's name, and the PR
  description each state a guarantee. The constants, configuration files, schedules, limits,
  timeouts, and error paths in the diff either deliver it or they do not. Read the value next to
  the claim. A guarantee that holds only under conditions the deployment does not promise is a
  defect: name the claim, the value that breaks it, and the consequence.
- **Values that must relate to each other.** A period, a window, a timeout, a retention, a batch
  size, and a schedule are chosen against one another. Two values that meet exactly, or in the
  wrong order, make the behavior depend on timing the system does not control.
- **Structure.** Consequential drift, debt, and complexity the change adds rather than deletes.

Use `decide` for a choice requiring agreement or a substantiated problem that needs resolution,
`check` for a concrete verification, and `fyi` for useful context. Use layer rationales and file
notes to explain the reading path and code flow. Put every decision, trade-off, and specific human
verification in an attention point, including sound choices the reviewer should understand.
A trade-off is not automatically a defect. Do not repeat automated lint
findings, turn style preferences into merge requirements, manufacture concerns, or give a merge
verdict. Avoid copying the same observation into several fields.

Write one JSON file grouping the diff into semantic layers, linked explanations, and attention
points. A deterministic validator checks the file; a web page renders it. Write no prose outside
the JSON file.

## Project rulebook

Use these code standards to assess consequential drift and debt, and to explain project choices and
boundaries as they arise in the reading path. Read them as reference material; follow this prompt's
workflow and output format.

{{RULEBOOK}}

### Bundled standards

{{QUALITY_STANDARDS}}

{{FORMAT}}
