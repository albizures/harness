---
name: to-tasks
description: Break an approved plan into Forge Tasks under an existing Spec, preserving blockers and adding verification/release work for code changes.
disable-model-invocation: true
---

# To Tasks

Break a plan, Spec, or conversation into Forge **Tasks**: tracer-bullet vertical slices under an existing Forge Spec, each declaring the Tasks that block it.

Before publishing, use the /forge skill as the workflow reference for current command, scope, relationship, readiness, lifecycle, and comment rules.

## Required parent Spec

This skill requires an existing Forge Spec. If the user did not supply a Spec id/URL, and one is not unambiguously discoverable from the request, stop and ask for the Spec. Do not create orphan Tasks and do not silently create a new Spec.

When a candidate parent is supplied, inspect it with `forge show <record>` and confirm it is a Spec before publishing child Tasks.

## Process

### 1. Gather context

Work from the existing conversation context. If the user passes a Spec id, URL, or other reference, fetch it through `forge show` and `forge history` and read the full body/history you need.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state. Task titles and descriptions should use the project's domain glossary vocabulary and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** Tasks.

<vertical-slice-rules>

- Each slice cuts a narrow but complete path through every relevant layer.
- A completed slice is demoable or verifiable on its own.
- Each slice is sized to fit in a single fresh context window.
- Any prefactoring should be done first.

</vertical-slice-rules>

Give each Task its blocking edges: the other Tasks that must complete before it can start. A Task with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** Sequence them as expand–contract: expand safely, migrate call sites in green batches, then contract after all callers move. Use an integration branch only when batches cannot stay green alone, and make the final integrate-and-verify work explicit.

### 4. Add verification tasks for code work

For code work, add these ordinary Forge Tasks by default unless the human explicitly opts out:

- **Verification Task**: ordinary `forge new task`; title and description say what integration/local verification must run.
- **Release Task**: ordinary `forge new task`; title and description say what release handoff must happen.

Use dependencies to gate verification after implementation/review and release after verification. If follow-up implementation or review Tasks are added after a verification pass, add another Verification Task before release to preserve freshness.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each Task, show:

- **Title**: short descriptive name
- **Task kind**: ordinary, `research`, `prototype`, or `review`
- **Blocked by**: which proposed Tasks must complete first, if any
- **What it delivers**: the end-to-end behaviour this Task makes work
- **Routing hint**: who or what should pick it up, if that is not obvious

Ask the user:

- Does the granularity feel right?
- Are the blocking edges correct?
- Should any Tasks be merged or split further?
- Are the Task kinds and routing hints right for this repo's agents/humans?

Iterate until the user approves the breakdown. Do not publish unapproved Tasks.

### 6. Publish the approved Tasks

Publish the approved breakdown under the existing Spec with `forge new task`. Create blockers before dependents so dependency fields can reference real Forge ids.

For each Task, prefer `--description -` or `--description-file` for long Markdown descriptions. Use `--kind research`, `--kind prototype`, or `--kind review` only when approved and semantically right. Preserve every approved blocking edge with repeatable `--depends-on` or `forge deps add`.

Publishing is complete only when every approved Task exists under the parent Spec, every approved blocker is represented by a Forge dependency edge, and the created ids are reported to the user.

Work the **frontier** via `forge ready`: any Task whose blockers and readiness gates are clear may start. Do not close or complete the parent Spec; Spec completion is a separate lifecycle action after delivery.

## Boundaries

- Do not create Tasks without an existing Forge Spec parent.
- Use Forge parent/dependency commands instead of editing backing files.
- Use only Forge public commands from the Forge reference.
