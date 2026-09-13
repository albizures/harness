---
name: to-tickets
description: Break an approved plan into AWF agent-workflow Tasks under an existing Spec, preserving blockers and adding verification/merge work for code changes.
disable-model-invocation: true
---

# To Tickets

Break a plan, Spec, or conversation into AWF `agent-workflow` **Tasks**: tracer-bullet vertical slices under an existing AWF Spec, each declaring the Tasks that block it.

Before publishing, use the /agent-workflow skill as the Agent Workflow reference for current command/input shapes and use only public AWF CLI/config behavior.

## Required parent Spec

This skill requires an existing AWF Spec. If the user did not supply a Spec id/URL, and one is not unambiguously discoverable from the request, stop and ask for the Spec. Do not create orphan Tasks and do not silently create a new Spec.

When a candidate parent is supplied, inspect it with public AWF commands from the Agent Workflow reference and confirm it is an AWF `kind: spec` issue before publishing child Tasks.

## Process

### 1. Gather context

Work from the existing conversation context. If the user passes a Spec id, URL, or other reference, fetch it through the public AWF inspection/history commands from the Agent Workflow reference and read the full body/history you need.

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

### 4. Add verification and merge Tasks for code work

For code work, add these Tasks by default unless the human explicitly opts out:

- **Integration-test Task**: `profile: "integration-test"`, `subkind: "work"`; verifies completed implementation/review work against the parent Spec.
- **Merge Task**: `profile: "merge"`, `subkind: "work"`; performs the final integration/merge after verification.

Rely on AWF readiness gates for these Tasks. Do not model integration test or merge as Spec lifecycle actions. If follow-up implementation or review Tasks are added after an integration pass, add another Integration-test Task before merge to preserve freshness.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each Task, show:

- **Title**: short descriptive name
- **Profile/subkind**: routing profile and durable subkind
- **Blocked by**: which proposed Tasks must complete first, if any
- **What it delivers**: the end-to-end behaviour this Task makes work

Ask the user:

- Does the granularity feel right?
- Are the blocking edges correct?
- Should any Tasks be merged or split further?
- Are the profiles right for this repo's agents/humans?

Iterate until the user approves the breakdown. Do not publish unapproved Tasks.

### 6. Publish the approved Tasks

Publish the approved breakdown under the existing Spec with the public Task creation command and current input shape from the Agent Workflow reference. Create blockers before dependents so dependency fields can reference real AWF ids.

For each Task, include the approved title, description, routing profile, durable subkind, dependency edges, and provenance where relevant, using the field names defined by the Agent Workflow reference. Preserve every approved blocking edge.

Publishing is complete only when every approved Task exists under the parent Spec, every approved blocker is represented by an AWF dependency edge, and the created ids are reported to the user.

Work the **frontier** via the AWF readiness command: any Task whose blockers and readiness gates are clear may start. Do not close or complete the parent Spec; Spec completion is a separate AWF lifecycle action after delivery.

## Boundaries

- Do not create Tasks without an existing AWF Spec parent.
- Use AWF parent/dependency inputs from the Agent Workflow reference instead of native tracker relationship APIs.
- Use only AWF public commands from the Agent Workflow reference.
