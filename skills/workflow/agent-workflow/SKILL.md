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

If no config is present, AWF falls back to the filesystem tracker under `.awf/tracker` in the current working directory.

Supported public commands for this workflow include:

- `awf create spec --input <file|->`
- `awf create wayfinder --input <file|->`
- `awf create task --input <file|->`
- `awf create grilling --input <file|->`
- `awf ready [--filter <name=value>] [--limit <n>]`
- `awf get <id>`
- `awf logs <id>`
- `awf spec complete <issue> --input <file|->`
- Public lifecycle commands shown by `awf --help` or by a `Usage:` line in `awf workflow describe`, such as `awf task start <issue>`, `awf task fail <issue>`, `awf task recover <issue>`, and `awf task escalate <issue>`.

If a lifecycle operation you need is not exposed by `awf --help` or a `Usage:` line for the loaded workflow, stop and ask for the AWF command surface to be upgraded. Do not reach for hidden `run-command` forms or command ids.

## Issue kinds

- **Spec**: a workflow issue that describes an implementation outcome and contains delivery Tasks and Grilling. Create with `{ "title": string, "body" | "content": string }`.
- **Task**: an executable workflow issue. Create under a Spec or Wayfinder with `{ "spec" | "parent": string, "title": string, "description": string, "profile": string, "subkind"?: "work" | "research" | "prototype", "dependsOn"?: string[], "generatedBy"?: string }`.
- **Wayfinder**: a map for discovering a route through fog. Create with `{ "title": string, "body" | "content": string }`.
- **Grilling**: collaborative human-in-the-loop discussion. Create with `{ "title": string, "description": string, "parent"?: string }`.

## Relationship rules

- Use `spec`/`parent` in AWF create input to attach children. Do not create tracker sub-issues directly.
- Use `dependsOn` in Task create input to preserve blocking edges. Do not call raw GitHub dependency APIs directly.
- Use `generatedBy` only as provenance. It is not dependency ordering and does not gate readiness.
- Use `awf ready` as the source of truth for executable frontier work. It applies dependency, lifecycle, concurrency, and parent/child gates.
- Use `awf get <id>` and `awf logs <id>` to inspect workflow state and history.

## Lifecycle boundaries

- Specs start ready for planning. After planning, child Tasks run; integration testing and merging are ordinary Tasks, not Spec lifecycle actions.
- Complete a delivered Spec only with `awf spec complete <issue> --input <file|->`, after AWF validates child completion.
- Wayfinders are maps. Update the map body through AWF-supported map revision/lifecycle behavior, and complete it only through public Wayfinder lifecycle commands when available and all children are done.
- Grilling is HITL. Do not let the agent answer for the human side of a Grilling issue.
- Record outcomes through AWF lifecycle/log commands. Do not edit AWF machine comments, labels, frontmatter, relationships, or logs by hand except as documented filesystem repair.

## Profile conventions

Profiles are project-owned routing data. Use names that say who or what should pick up the work. For code Specs, default to:

- implementation work: the project's implementation profile (for example `implement`)
- review work: the project's review profile when explicit review Tasks are created
- verification: `integration-test`
- merge/release handoff: `merge`
- documentation-only work: `docs`
- research work: `research` with `subkind: "research"`
- prototypes: `prototype` with `subkind: "prototype"`

AWF gates `integration-test` and `merge` readiness by profile. It does not prove integration-test freshness after later follow-up work; if new implementation or review Tasks are added after an integration pass, add another `integration-test` Task before merge.

## HITL checkpoints

- Before publishing Tasks, get human approval for the Task breakdown and blocking edges.
- Grilling and most Wayfinder decision work are HITL. Stop at the checkpoint and wait for the human rather than simulating agreement.
- If scope is ambiguous during implementation, create or use Grilling / `need-human` flow instead of silently expanding executable work.

## GitHub target

For normal GitHub-backed operation, run public AWF commands from the repo root with the configured repo `awf.config.ts`. AWF is responsible for projecting workflow labels, machine comments, child relationships, and dependencies.

When configuring or validating GitHub-backed AWF setup, use [`GITHUB-SETUP.md`](GITHUB-SETUP.md).

## Filesystem fallback

Without a configured tracker, AWF stores readable Markdown issue files in `.awf/tracker`. You may inspect these files, but still create and operate workflow issues with public `awf` commands. Manual file repair is only for documented corruption recovery.

## Unsupported internals

Do not instruct agents to use private runtime APIs, raw command ids, hidden `run-command` invocations, direct GitHub relationship/dependency endpoints, AWF machine-comment edits, legacy tracker labels such as `ready-for-agent`, or the old `agentDevelopment*` / agent-development workflow conventions for AWF-backed planning.
