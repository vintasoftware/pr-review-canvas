---
name: pr-tour-setup
description: Write or update the project's tour guide, the committed notes a tour is generated with, by interviewing the user. Use when the user runs `/pr-tour-setup`, when `/pr-tour` reports the project has no guide, or when the user wants to change how tours run the app, make synthetic data, name non-functional requirements, find specs, or what the tour agent may run.
---

# pr-tour-setup

You write one committed markdown file, the guide, `docs/pr-tour.md` by default (`tour.guide` in
`pr-review.config.yml` names another path). A tour reads it before generating: it is the project's
own voice on how to run the app and what matters. It is also an allowlist: a tour runs nothing the
guide does not name without asking first.

## The interview

Ask, one question at a time, and write what you learn. Read the repository first (README, package
scripts, CI config, docs, fixture and seed directories) so each question proposes an answer the
user can confirm or correct rather than starting from nothing.

1. **Running the app.** The commands that start it for a look, from a clean clone: install,
   build, start, the URL, a login if one is needed and how to get a test one. Say how long a
   start takes.
2. **Synthetic test data.** How to make it, which fixtures or seed scripts exist, and where
   fixtures may be written: fixture, seed, and test directories only. Never real user data.
3. **Non-functional requirements.** The ones this project holds tours to: performance budgets,
   accessibility, offline behavior, security and privacy rules, compatibility, observability. Name
   the ones that matter here, with the number when there is one.
4. **Where specs and designs live.** Plan files, a task tool, Figma, ADRs, the PR description
   itself: where a tour looks for the intent a change is measured against.
5. **What the tour agent may run.** The commands from the answers above, and anything else it may
   run without asking; everything else is asked first and then recorded here, so it is asked once.
   Never credentials, and never a production target.

Skip a question the repository already answers plainly; say what you found and let the user
confirm it.

## The guide's shape

```markdown
# Tour guide

## Run the app

<commands, URL, login, how long a start takes>

## Synthetic data

<how to make it; where fixtures may be written>

## Non-functional requirements

<the ones that matter here, with numbers>

## Specs and designs

<where they live>

## The agent may run

<commands, one per line>
```

Keep it short and plain: a tour reads it whole. Commit it with the project; it is the team's,
not one person's. When the user asks for a change later, edit the section, do not rewrite the
file.

## After writing

Tell the user the guide's path, and that `/pr-tour <n>` now uses it. If the user came from
`/pr-tour`, offer to run that now.
