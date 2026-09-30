---
name: pr-tour-apply
description: Implement the plan a finished tour settled on, with the pr-review tool. Reads the re-implementation prompt the tour wrote (the intent, what to respect, the decisions kept, the changes approved in the grilling), makes the changes, runs the project checks, and offers a fresh tour. Use when the user runs `/pr-tour-apply <pr-number>`, `/pr-tour-apply branch`, `/pr-tour-apply uncommitted`, or asks to apply, implement, or carry out a tour's plan.
---

# pr-tour-apply

A finished tour leaves one prompt behind: what the change is for, what a later change must
respect, the decisions the author kept with their reasons, and the changes the reader approved in
the grilling, restated in their words. You carry that prompt out. The plan needed no further
review when it was confirmed, so you do not reopen it: a kept decision stays as it is, and an
approved change is made as restated.

Arguments: `<pr-number>`, `branch`, or `uncommitted`, the same targets `/pr-tour` takes. Run
every `pr-review` command from the repository root.

## Flow

### 1. Read the plan

```bash
pr-review tour plan --pr <n>
pr-review tour plan --branch
pr-review tour plan --uncommitted
```

The last stdout line is JSON: `headSha`, `tourDir`, `promptPath`, `prompt` (the whole text),
`finishedAt`, and how many `changes` and `kept` decisions it holds. `status: "unfinished"` means
the tour was not confirmed yet: stop and ask the user to take it at `/tour/<key>` and confirm the
plan. An `{ "error": … }` line means there is no tour; report it and stop.

Read `prompt` in full before touching anything. Read `promptPath` again if the user edited it by
hand since.

### 2. Check out the change

The tour was taken on `headSha`. Make sure the working tree is on that commit or contains it
(`git merge-base --is-ancestor <headSha> HEAD`); when it is not, tell the user which branch the
pull request is on and stop. Never check anything out yourself without asking.

### 3. Make the changes

For each change in the prompt, in order: what changes, where, and what stays the same. Stay
inside "where" unless the code forces you out, and say so when it does. "Stays the same" is a
constraint, not a suggestion: run the tests that guard it before and after.

For each kept decision whose reason belongs in the code (the prompt says "write this as a comment
near `path:line`"), write the reason as a comment there, in the author's words, without a preamble.
For a reason that belongs as a lint rule, add the rule to the project's linter when it has one that
can express it, and say so when it cannot.

Leave the reader's notes as they are: they are context, not instructions, unless the prompt turned
one into a change.

### 4. Run the checks

Run the project's checks as its guide names them (`docs/pr-tour.md`, "The agent may run"), or
the obvious ones from the package scripts when there is no guide. Fix what you broke. Do not
touch failures that were there before; report them.

### 5. Report and offer a fresh tour

Say what changed, file by file, which kept reasons went into the code, and what the checks said.
Then offer to commit, and to run `/pr-tour <key>` again once the new commit is on the pull request:
the new head gets a new tour, and the reader's picks carry over by decision key, so only what
changed is asked again.

## Rules

- Read-only outside the changes the plan names. No new features, no refactors the plan did not
  ask for, no reopening a kept decision.
- Never run anything the guide does not name without asking first; never credentials, never a
  production target.
- The tour's directory (`tourDir`) is the tool's; do not write there.
