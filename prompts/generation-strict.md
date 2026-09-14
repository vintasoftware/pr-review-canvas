# Review canvas for a {{TARGET_WORD}}

Produce a code-quality review that a human can navigate. Read the changed behavior, its tests,
and the surrounding boundaries. Apply the project rulebook and bundled quality standards to
identify consequential structural problems, risks, and decisions that need the reviewer's judgment.
Assume no prior structural review unless evidence of one is supplied.

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
