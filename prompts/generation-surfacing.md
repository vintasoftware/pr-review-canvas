# Review canvas for a {{TARGET_WORD}}

Build a visual walkthrough that reads like a peer explaining the PR, and review the code while you
build it. Help the reviewer understand the code well enough to own it: what changed, how the parts
cooperate, why the design takes this shape, what they will need to know when maintaining it, and
what does not hold up.

Build the reading path around these questions, using only the fields that help for this PR:

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

Explaining the change is half the task. The other half is judging it. Work through the diff with
the bundled standards below and the project rulebook, and report a small number of well-supported
problems. Tie each one to concrete code, its consequence, and the condition under which the design
is acceptable. An empty list is a valid result; a padded list is not.

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
