---
name: thermo-nuclear-review-loop-v2
description: Iteratively review and fix a commit, branch, ref, range, current change set, or historical feature until an independent reviewer approves it, with a growth budget so fixes shrink the code, an interview gate so hypothetical scenarios are decided by the human, and poka-yoke remedies over defensive runtime code. Use for a thermo-nuclear review loop, strict review/fix cycles, or when a change must survive an adversarial reviewer without bloating.
---

# Thermo-Nuclear Review Loop v2

You are the **fixer**: the agent running this skill in the host session (Claude Code or Codex). You spawn one **reviewer**, verify its findings, fix the justified ones, and repeat until it approves. There is no separate fixer agent.

Two forces shape every cycle. The **budget** keeps the scope from growing while findings are addressed. The **gate** sends decisions about scenarios, requirements, and behavior to the human instead of letting either agent assume them.

## Establish the scope

1. Read the repository instructions (`AGENTS.md`, `CLAUDE.md`, rules, README).
2. Take the review target from the user: a commit, branch, ref, range, the current working-tree changes, or a described historical feature. Without a target, ask one question and wait.
3. Resolve the baseline: a commit's parent, a branch's merge base, the explicit range, the repository baseline for current changes, or the commits that introduced a historical feature. Trace a historical feature into the current tree and edit the current tree.
4. Inspect status before editing. Preserve unrelated user changes and generated artifacts. If the tree already holds unrelated uncommitted changes, the loop runs uncommitted (see Commit).
5. Record the **budget baseline**: `git diff --stat <baseline>` for the scope, as net lines and files touched. Every later report compares against it.

If the ref cannot be resolved or the scope is ambiguous, stop and ask.

## Spawn the reviewer

**Model**: an Opus-like model, meaning the highest or second-highest model on the default plan for that agent (Claude: Opus; Codex: the top or second reasoning model at `xhigh` effort), at its highest reasoning effort. Name the tier, never a specific model id.

**Host**: when the reviewer runs on the same agent as the host, spawn a subagent with a stable name (`tnr-reviewer`) and keep it for the whole loop so later passes reuse its context. When the reviewer runs on a different agent, use `acpx` with a named persistent session (see Host notes). The user chooses; default to the same host.

**Brief**: before spawning, check for a project-root `REVIEW.md`. If it exists, the reviewer reads only that file as its standard. Otherwise the reviewer reads the Review Standard section of this skill: point at this file's path, or paste the section when the reviewer is a different agent that cannot see this skill.

**Access**: the reviewer may read and run commands (tests, `git blame`, greps) but makes no edits. Record `git rev-parse HEAD` and `git status --porcelain` before each pass and compare after. Any change made by the reviewer stops the loop: report it and ask the user what to do with those changes.

Prompt template:

> Read `<REVIEW.md or Review Standard path/paste>` and apply it to `<resolved scope>` in the current working tree, compared against `<baseline>`. Verify every claim against code, history, tests, and repository instructions; behavior claims need a file:line citation, not an inference from naming. Do not edit. Return prioritized findings with evidence, remedy, label (`deletes/simplifies` or `adds`), and confidence, or explicit approval.

Wait for the verdict; the loop cannot proceed without it.

## Triage every finding

Reviewer output is a list of leads, not orders. For each finding, verify it yourself against code and tests, then place it in exactly one bucket:

- **Fix**: verified, behavior-preserving or a clear bug, and either labeled `deletes/simplifies` or an `adds` whose addition the project's own patterns already call for.
- **Gate**: verified in principle but depends on a decision that is the human's:
    1. handling for a scenario no current caller, type, or data can reach;
    2. a defensive check on data already typed or validated upstream;
    3. a fix that changes externally observable behavior, including security hardening;
    4. a product or requirements ambiguity;
    5. a destructive or irreversible operation in scope (deletes, migrations, production-touching scripts).
- **Reject**: unsupported, pre-existing and outside scope, or fails the evidence bar (see Review Standard). Keep the concrete counter-evidence for the next reviewer prompt and the final report.

**Assumptions belong to the project or the human, never to you or the reviewer.** Before adding machinery for a rare case, look for the project's existing pattern in README, `AGENTS.md`, `CLAUDE.md`, rules, and neighboring code. The existing pattern is the default answer. No pattern means gate, not assume. Typical assumptions (examples; non-functional requirements and rare functional edge cases produce more): backward compatibility with in-flight data or old clients, zero-downtime or online migration, concurrent writers, retries and idempotency, partial-failure recovery, multi-tenant isolation, scale beyond current volume, offline or network-loss handling, locale and timezone, permission tiers beyond those in the code.

## Run the gate

Fix every Fix-bucket finding first. Then, once per iteration, put all Gate items to the user in one batch: each with the finding, the evidence, what handling it would cost, and your recommendation. The default recommendation for triggers 1 and 2 is "reject the finding". Use the host's structured question tool when it has one; otherwise end the turn with the questions in plain text. Wait for the answers.

Record each answer as a **settled decision**: what was asked, what was decided, and the date. Settled decisions go into every later reviewer prompt. The reviewer may re-raise one only with new evidence; you decide whether the evidence changes the answer, and a re-raise without new evidence is dropped, not fixed.

Gate interviews do not count as iterations.

## Implement

Address the Fix bucket and the gate-approved items as one coherent change per iteration. Prefer changes that delete concepts, branches, duplicated state, and boundary leaks.

**Poka-yoke over defense.** When a finding needs a guarantee, choose the highest rung available:

1. make the illegal state unrepresentable in types (exhaustive unions, enums over strings, non-optional fields);
2. a static check (type strictness, a lint rule, a schema);
3. a scripted check (a test, a CI script, a git hook);
4. one assertion at the trust boundary where untrusted data enters (user input, network, files, environment);
5. a runtime check inside the flow, the last resort.

Adding a lint rule, tightening typing, or adding a script counts as a fix and needs no gate. Internal callers are trusted: code past the boundary works on typed data without re-validating it.

**Cohesion over extraction.** Judge every split by the cognitive load it removes, not by line count. A new file or module is justified when a reader would otherwise hold unrelated concerns at once. Splitting code that changes together is a regression: it raises accidental load and file count without reducing essential load. A file passing 1000 lines is a smell to weigh against cohesion, not an automatic blocker. State the justification for each new file in the iteration report.

**Tests.** Add a test only when a fix changes behavior or a verified bug was found. Strengthen an existing test before adding a file. Delete tests a simplification made redundant. Tests for hypothetical scenarios are gate items, not fixes.

**Verify.** Run the repository's build and test commands, plus focused checks the affected code warrants (sanitizers, concurrency checks, format and lint). Separate environment-only failures from regressions; report both.

**Commit.** One commit per iteration on the current branch, message naming the iteration and the findings it addresses, so each cycle stays reviewable. Run uncommitted only if the user asked for that or the tree held unrelated changes at the start. Never push or publish unless the user asks.

**Iteration report** (to the user, every iteration):

- findings fixed, gated, rejected (with counter-evidence);
- lines added, lines removed, files added, against the budget baseline;
- if net lines grew, which findings caused it;
- justification for each new file;
- verification results.

## Re-review

Send the same reviewer the iteration commit hash (or the diff when uncommitted), the settled decisions, and the rejected findings with counter-evidence. Require it to inspect the diff rather than trust your summary, and to reapply the full standard with the pass-two rules from the Review Standard: blockers only, and each new blocker explains why the previous pass missed it.

Count each pass that returns blockers as one unsuccessful iteration. After four, pause before the fifth and tell the user:

- what changed across the four cycles and the budget totals so far;
- which blockers remain, and which of them you verified, disputed, or consider diminishing returns;
- your own view of whether more work is worth it;
- the risks that remain.

Ask whether to continue. Yes resets the counter for four more. No ends the loop with the reviewer unapproved. Silence is not permission.

The loop ends successfully only when the reviewer explicitly approves. Passing tests are not approval. If progress requires the user's authority, missing dependencies, or a scope expansion, report the blocker and ask rather than lowering the bar.

## Report the outcome

- structural improvements made;
- findings rejected and why, and settled decisions taken;
- budget: start versus end net lines and files, and which additions came through the gate;
- verification performed and environment-only failures;
- the final reviewer verdict;
- iteration commits created (or why the tree stayed uncommitted), and that nothing was pushed.

## Review Standard

The reviewer's brief when the project has no `REVIEW.md`. Self-contained: a reviewer may read only this section.

### Stance

Review the scope in the current working tree against its baseline. Verify every claim against code, history, tests, and repository instructions. You make no edits. Be ambitious about **code judo**: restructurings that keep behavior while deleting whole branches, helpers, modes, or layers. Prefer the version that feels inevitable in hindsight. Be direct and demanding; state major problems as major problems.

### Evidence bar

No evidence, no finding. Every finding answers four questions: Can I cite the exact file and line? Can I describe the failure mode or the maintainability cost concretely? Have I read the surrounding context and callers? Is the severity defensible to a senior engineer? Attach a confidence from 0 to 100 and drop anything under 80.

These are not findings: pre-existing issues outside the scope, issues a linter or type checker already catches, nits a senior engineer would skip, generic input validation without a proven impact, paths no current caller or data can reach, denial-of-service or rate-limiting concerns without a threat model, and handling for scenarios the project's own patterns do not handle elsewhere. If a scenario is genuinely undecided, report it as a **question for the human** with your recommendation, separate from blockers.

### Labels

Every finding carries a label: `deletes/simplifies` when the remedy removes code, concepts, or branches; `adds` when it introduces any. Prefer remedies from the poka-yoke ladder: types first, then static checks, then scripted checks, then a single trust-boundary assertion, with runtime defensive code last.

### What to review, in priority order

1. **Correctness and security.** Logic errors, broken edge cases that current inputs can reach, injection, missing or weakened authorization, unscoped queries in multi-tenant code, secrets or PII in logs and error messages, unsafe deserialization, race conditions with a concrete interleaving. Treat any logic alteration as high risk until shown otherwise, refactors included. Count callers to size the blast radius; flag unchanged callers that depend on changed behavior; `git blame` removed checks before accepting their removal.
2. **Destructive or irreversible operations.** Hard deletes where the project uses soft deletes, migrations without a rollback step, scripts that touch production without a dry run, non-atomic multi-step updates that can leave state half-applied.
3. **Drift from project conventions and duplicated judgment.** Bespoke helpers where a canonical one exists, re-implemented framework primitives, a decision (parse, validate, classify) answered in two places, domain-language drift from the project's own terms, logic in the wrong layer or package, hand-edited generated artifacts.
4. **Structural regressions and missed simplifications.** Ad-hoc conditionals bolted onto unrelated flows, one-off booleans and nullable modes, feature logic leaking into shared paths, thin wrappers and pass-through helpers, magic generic mechanisms hiding simple data shapes, refactors that move complexity without deleting it. Also the reverse: splits that separate code which changes together, trading cohesion for file count and raising the reader's load.
5. **Brittle or flaky tests.** Timing sleeps, order dependence, real network or clock, assertions rewritten to match new behavior instead of the requirement, tests deleted or skipped, coverage or lint thresholds lowered, tests that restate the implementation or pass vacuously.
6. **Boundary and type contracts.** Unnecessary optionality, `any`, `unknown`, casts, silent fallbacks that degrade to a simpler behavior without logging, validation duplicated past the trust boundary, ad-hoc object shapes where a typed model would remove branches.
7. **Legibility.** Only after the above, and only when a senior engineer would stop on it.

Also check **requirement fidelity**: the code does what was asked, not something adjacent, and dependency changes are intentional.

### Output

Prioritized findings, each with file:line evidence, failure mode or cost, remedy, label, confidence. Then questions for the human. Then, if nothing blocks, explicit approval in one sentence. Fewer high-conviction findings beat a long list.

### Pass two and later

Report blockers only. Every new blocker states why the previous pass did not raise it: a regression from the fix, or a concrete miss. Findings equivalent to ones already approved or settled by the human are dropped unless you bring new evidence, which you name. Approve when the bar is met; the loop has no other exit.

### Approval bar

Approve when the scope has: no verified correctness or security defect, no unguarded destructive path, no duplicated judgment or drift the project's patterns forbid, no structural regression or plausible code-judo move left on the table, no brittle test, no boundary churn obscuring the contract, and no growth the human did not approve. Behavior that merely works is not enough; behavior that works with less code than before is the goal.

## Host notes

- **Claude Code host, same-host reviewer**: `Agent` tool with `model` set to the Opus-like tier, `name: tnr-reviewer`, `run_in_background: false`; continue it with `SendMessage` on later passes. Ask gate questions with `AskUserQuestion`.
- **Codex host, same-host reviewer**: Codex has built-in subagents; spawn one, keep its handle, and message it on later passes. Its structured question tool works only in Plan mode, so ask gate questions by ending the turn in plain text. Under the default workspace-write sandbox a commit may trigger an approval prompt because `.git` can be protected; accept it, the commit is part of the loop.
- **Cross-host reviewer via acpx**: create one named session and reuse it every pass so context persists; deny ACP writes while keeping reads and terminal:

    ```bash
    acpx --approve-reads --non-interactive-permissions deny <agent> sessions ensure --name tnr-reviewer
    acpx --approve-reads --non-interactive-permissions deny <agent> -s tnr-reviewer -f review-prompt.md
    ```

    `<agent>` is `claude` or `codex`. Use `--model` to request the Opus-like tier when the adapter advertises models (Codex also takes `--config-option reasoning_effort=xhigh`). From a Codex host, acpx needs network, which the default sandbox blocks: expect one approval prompt. Paste the Review Standard (or `REVIEW.md`) into the prompt file when the reviewer agent cannot read this skill. The tree-integrity check in Spawn the reviewer is the real guard; the flags reduce the chance of needing it.
