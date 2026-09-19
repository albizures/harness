---
name: agent-workflow
description: Operate bundled AWF agent-workflow Specs, Tasks, Wayfinders, and Grilling issues through the public AWF CLI.
---

# Agent Workflow (AWF)

Use this skill when creating or operating AWF-backed Specs, Tasks, Wayfinders, or Grilling issues. This is the Agent Workflow reference: the single source of truth for AWF command shape, create input shape, relationship rules, readiness, lifecycle boundaries, tracker fallback, and unsupported internals.

## Public commands

Prefer the configured command shape for the repository:

```sh
awf --config ./awf.config.ts <command>
```

In Harness agent sessions, use the repository wrapper form `pnpm awf --config ./awf.config.ts <command>`.

If no config is present, AWF falls back to the filesystem tracker under `.awf/tracker` in the current working directory.

Supported public commands for this workflow include:

- `awf create spec --input <file|->`
- `awf create wayfinder --input <file|->`
- `awf create task --input <file|->` (generic validated seam; input must include a concrete `kind`)
- `awf create task:work --input <file|->`
- `awf create task:research --input <file|->`
- `awf create task:prototype --input <file|->`
- `awf create task:work:integration-test --input <file|->`
- `awf create task:work:merge --input <file|->`
- `awf create grilling --input <file|->`
- `awf ready [--filter <name=value>] [--limit <n>]`
  - In the bundled `agent-workflow`, the only named readiness filter is `--filter spec=<spec-id>`.
  - `--filter spec=<spec-id>` narrows readiness to executable work whose direct parent is that Spec.
  - Parent-generic and Wayfinder-scoped readiness filters such as `--filter parent=<id>` or `--filter wayfinder=<id>` are not currently supported.
- `awf get <id>`
- `awf logs <id>`
- `awf spec planned <issue>`
- `awf spec complete <issue> --input <file|->`
- `awf task start <issue>`
- `awf task succeed <issue> --input <file|->`
- `awf task fail <issue>`
- `awf task recover <issue>`
- `awf task escalate <issue>`
- `awf wayfinder start <issue>`
- `awf wayfinder succeed <issue> --input <file|->`
- `awf grilling start <issue>`
- `awf grilling succeed <issue> --input <file|->`
- `awf migrate legacy-task-subkinds [--dry-run|--apply]`

If a lifecycle operation you need is not exposed by `awf --help` or a `Usage:` line for the loaded workflow, stop and ask for the AWF command surface to be upgraded. Do not reach for hidden `run-command` forms or command ids.

## Issue kinds

- **Spec**: a workflow issue that describes an implementation outcome and contains delivery Tasks and Grilling. Create with `{ "title": string, "body" | "content": string }`.
- **Task**: an executable workflow issue. Create under a Spec or Wayfinder with direct concrete Task commands. Use `create task:work`, `create task:research`, `create task:prototype`, `create task:work:integration-test`, or `create task:work:merge` with `{ "spec" | "parent": string, "title": string, "description": string, "profile": string, "dependsOn"?: string[], "generatedBy"?: string }`. The generic `create task` command is a validated seam for tests/future tooling and requires a concrete `kind` in input.
- **Wayfinder**: a map for discovering a route through fog. Create with `{ "title": string, "body" | "content": string }`.
- **Grilling**: collaborative human-in-the-loop discussion. Create with `{ "title": string, "description": string, "parent"?: string }`.

## Relationship rules

- Use `spec`/`parent` in AWF create input to attach children. Do not create tracker sub-issues directly.
- Use `dependsOn` in Task create input to preserve blocking edges. Do not call raw tracker dependency APIs directly.
- Use `generatedBy` only as provenance. It is not dependency ordering and does not gate readiness.
- Use `awf ready` as the source of truth for executable frontier work. In this workflow it exposes Specs ready for planning and Tasks ready for work; it does not list Grilling.
- Use `awf ready --filter spec=<spec-id>` to ask for executable work directly under a Spec. Do not use `--filter parent=<id>` or `--filter wayfinder=<id>`; those filters are undeclared and AWF will reject them.
- For Wayfinder children, inspect the Wayfinder with `awf get <id>` / `awf logs <id>` and then use unfiltered `awf ready` to identify executable Task children manually until a Wayfinder-scoped readiness filter exists.
- Use `awf get <id>` and `awf logs <id>` to inspect workflow state, history, and HITL Grilling children.

## Lifecycle boundaries

- Specs start ready for planning. After the human-approved task breakdown is published, run `awf spec planned <issue>` so delivery Tasks can proceed while the Spec waits at `ready/none`.
- Integration testing and merging are ordinary Tasks with concrete `task:work:integration-test` and `task:work:merge` kinds, not Spec lifecycle actions or profile conventions. Create Merge Tasks only when the Spec's delivery path needs explicit merge/release handoff work.
- Complete a delivered Spec only with `awf spec complete <issue> --input <file|->`, after AWF validates planning is complete, all child Tasks are terminal, and child Grilling issues are not open.
- Wayfinders are maps. Start them with `awf wayfinder start <issue>` and complete them with `awf wayfinder succeed <issue> --input <file|->` after all children are done.
- Tasks are completed with `awf task succeed <issue> --input <file|->`; Wayfinder child Tasks require structured outcome input so the child log records the result and optional map revision.
- Grilling is HITL. Start it with `awf grilling start <issue>` and complete it with `awf grilling succeed <issue> --input <file|->` after the human-side discussion resolves; do not answer for the human.
- Record outcomes through these public lifecycle commands. Do not edit AWF machine comments, labels, frontmatter, relationships, or logs by hand except as documented filesystem repair.

## Task kinds and routing profiles

Task kind carries AWF workflow semantics; profile is project-owned routing data. Choose the concrete Task kind first, then set `profile` to say who or what should pick up the work. For code Specs, default to:

- implementation work: `task:work` with the project's implementation profile (for example `implement`)
- review work: `task:work` with the project's review profile when explicit review Tasks are created
- verification: `task:work:integration-test` with an appropriate verification routing profile
- optional merge/release handoff: `task:work:merge` with an appropriate release/handoff routing profile
- documentation-only work: `task:work` with a docs routing profile
- research work: `task:research` with a research routing profile
- prototypes: `task:prototype` with a prototype routing profile

AWF readiness gates use Task kind semantics and kind groups, not reserved profile values. It does not prove integration-test freshness after later follow-up work; if new implementation or review Tasks are added after an integration pass, add another `task:work:integration-test` Task before completing any merge/release handoff or the Spec.

## HITL checkpoints

- Before publishing Tasks, get human approval for the Task breakdown and blocking edges.
- Grilling and most Wayfinder decision work are HITL. Stop at the checkpoint and wait for the human rather than simulating agreement.
- If scope is ambiguous during implementation, create or use Grilling / `need-human` flow instead of silently expanding executable work.

## Filesystem target

Harness configures AWF to store readable Markdown issue files in `.awf/tracker` through `awf.config.ts`. If no tracker is configured, AWF uses the same filesystem tracker location by default.

You may inspect these files, but still create and operate workflow issues with public `awf` commands. Manual file repair is only for documented corruption recovery.

## Unsupported internals

Do not instruct agents to use private runtime APIs, raw command ids, hidden `run-command` invocations, direct tracker relationship/dependency endpoints, AWF storage edits except documented filesystem repair, legacy tracker labels such as `ready-for-agent`, or the old `agentDevelopment*` / agent-development workflow conventions for AWF-backed planning.
