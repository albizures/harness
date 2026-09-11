# @albizures/awf

Agent Workflow (AWF) provides the runtime and CLI for the bundled `agent-workflow` workflow.

## Runtime boundary

AWF is `agent-workflow`-first, not a generic workflow authoring platform. The public product boundary is the supported `agent-workflow` issue model, CLI commands, tracker adapters, envelopes, JSON helpers, and documented workflow data types needed to operate bundled Spec, Wayfinder, Task, and Grilling work.

AWF runtime-owned concepts are Workflow issue kinds, current workflow state/action fields, lifecycle events, legal actions, relationships, readiness filters, and append-only text logs. AWF does not publish generic manifest authoring, arbitrary project-defined CLI verbs, command-handler registration, raw-input handler conventions, reusable tracker intent APIs, runtime artifact records, change records, command output schemas, or artifact-specific schema helpers as public capabilities.

## Workflow configuration

AWF loads the bundled `agent-workflow` workflow by default. Add an `awf.config.ts` file, or pass one explicitly, when a project needs to configure a tracker:

```sh
awf --config ./awf.config.ts ready
```

A workflow config can export a `tracker`. If it exports the supported bundled `agent-workflow` manifest, AWF wires the bundled handlers for that workflow. Without a config-exported tracker, AWF stores issues in the filesystem tracker directory at `.awf/tracker` under the current working directory.

## Filesystem tracker storage

The filesystem tracker stores one readable Markdown file per Workflow issue under the configured tracker directory:

```text
.awf/
└── tracker/
    ├── 1.md
    ├── 2.md
    └── notes.md   # ignored because only numeric *.md files are issue files
```

Numeric issue files (`<id>.md`) are loaded in numeric order, and the next automatic issue id is allocated after the highest numeric file name. Temporary files containing `.tmp-` are ignored while atomic writes complete. Other files can be kept beside issue files for human notes.

Each issue file has:

1. YAML-style frontmatter delimited by `---`.
2. JSON values inside the `id`, `title`, `workflow`, and `relationships` frontmatter fields.
3. The human-editable Markdown issue body.
4. A reserved `## Logs` section containing `<!-- awf:logs v1 -->`.
5. Append-only log list entries such as `1. type: "workflow_created"` with an optional `message:` line. Multiline messages use an indented Markdown block scalar.

Example:

```md
---
id: "1"
title: "Readable issue"
workflow: {"kind":"task","state":"ready","action":"work","version":1,"hash":"..."}
relationships: {"children":[],"dependencies":[],"dependents":[]}
---

Issue **body**.

## Logs

<!-- awf:logs v1 -->

1. type: "workflow_created"
   message: "Created from create task."
2. type: "commented"
   message: |-
     First line

       indented second line
```

For local inspection or repair, keep the filename id and frontmatter `id` equal, preserve the `workflow.hash` for unchanged workflow fields, maintain inverse relationships on both sides (`parent`/`children`, `dependencies`/`dependents`), and leave log sequence numbers contiguous starting at 1. AWF reports corrupt storage as filesystem tracker directory or issue-file projection errors so the affected Markdown file can be repaired directly.

## Using the bundled agent-workflow workflow

The bundled `agent-workflow` workflow is the supported workflow. A project can use it implicitly with no config, or explicitly by exporting the agent-workflow manifest from its own `awf.config.ts` (or another config passed with `--config`).

```ts
import { createFileSystemTracker } from "@albizures/awf/trackers/filesystem";

export { agentWorkflowManifest as manifest } from "@albizures/awf/workflows/agent-workflow";

export const tracker = createFileSystemTracker({ path: "./.awf/tracker" });
```

Example commands:

```sh
awf --config ./awf.config.ts create spec --input ./spec.json
awf --config ./awf.config.ts create task --input ./task.json
awf --config ./awf.config.ts create grilling --input ./grilling.json
awf --config ./awf.config.ts ready
```

A Spec create input provides `title` plus `body` or `content`:

```json
{
	"title": "Improve importer reliability",
	"body": "Define the acceptance criteria and generate implementation tasks."
}
```

A Task create input belongs to a Spec, carries a project-owned profile, may declare a durable subkind (`work`, `research`, or `prototype`; defaults to `work`), and may record provenance or dependency ordering explicitly. Grilling is a separate top-level collaborative kind, not a Task subkind:

```json
{
	"spec": "42",
	"title": "Add importer retry tests",
	"description": "Cover retry and permanent-failure behavior.",
	"profile": "test-engineering",
	"subkind": "work",
	"generatedBy": "42",
	"dependsOn": ["43"]
}
```

A Grilling create input provides a title and description, plus an optional parent Spec or Wayfinder id. Without a parent, the Grilling stands alone:

```json
{
	"title": "Pressure-test importer scope",
	"description": "Discuss whether retry policy belongs in this Spec.",
	"parent": "42"
}
```

Grilling starts at `ready/discuss`, moves to `in-discussion/discuss` when started, and finishes at `done/none`. It is not included in the default ready-work filters, so ordinary autonomous agent-ready work does not pick it up as a Task.

## Policy boundaries

AWF core owns lifecycle and readiness semantics: current workflow fields, legal transitions, active-run gates, dependency gates, concurrency gates, parent/child readiness gates, tracker projection, and append-only logs. Task subkind is durable workflow data separate from the lifecycle tuple; readiness matches kind, state, and action. Project-owned profile policy stays outside the core. A Task profile is freeform routing data such as `test-engineering`, `docs`, or `release`; AWF stores and displays it but does not decide which humans, agents, prompts, tools, or SLAs that profile implies.

In `agent-workflow`, a Spec starts ready for `planning`. Completing planning leaves the Spec at `ready/none` while its implementation Tasks run. When the required child Tasks are done, lifecycle relationship policies advance the Spec to `ready/integration-test`; from there it can run integration-test, merge, and finish at `done/none` through ordinary legal lifecycle transitions. Task generation remains an explicit workflow command outcome recorded through normal tracker mutations.

`generatedBy` records generated-by provenance only. This means generated-by provenance is not dependency ordering, is not a readiness gate, and is separate from Spec containment. Use `spec`/parent-child relationships to attach Tasks to a Spec, `dependsOn` to block one Task on another, and `generatedBy` to explain why a Task exists.

