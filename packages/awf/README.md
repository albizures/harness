# @albizures/awf

Agent Workflow (AWF) provides a generic workflow runtime and CLI for tracker-backed Workflow issues.

## Runtime boundary

AWF runtime-owned concepts are Workflow issue kinds, current workflow state/action/reason fields, lifecycle events, legal actions, relationships, readiness filters, and append-only text logs. Command inputs are ordinary Zod schemas owned by workflow modules. AWF does not expose or manage runtime artifact records, change records, command output schemas, or artifact-specific schema helpers.

## Workflow configuration

AWF does not load a workflow implicitly. Run CLI commands from a directory with an `awf.config.ts` file, or pass one explicitly:

```sh
awf --config ./awf.config.ts ready
```

A workflow module must export at least `manifest`. It may also export runtime bindings such as `tracker`, `commandHandlers`, and `lifecycleHandlers`.

```ts
import { defineManifest } from "@albizures/awf";
import { createFileSystemTracker } from "@albizures/awf/trackers/filesystem";

export const manifest = defineManifest({
	workflow: { id: "my-workflow", version: "1.0.0" },
	// kinds, commands, and policies...
});

export const tracker = createFileSystemTracker({ path: "./.awf/tracker.json" });
```

## Using the bundled agent-development workflow

The bundled `agent-development` workflow remains available, but it must be imported explicitly from the package.

```ts
import { createFileSystemTracker } from "@albizures/awf/trackers/filesystem";

export {
	agentDevelopmentManifest as manifest,
	agentDevelopmentCommandHandlers as commandHandlers,
	agentDevelopmentLifecycleHandlers as lifecycleHandlers,
} from "@albizures/awf/workflows/agent-development";

export const tracker = createFileSystemTracker({ path: "./.awf/tracker.json" });
```

If neither `./awf.config.ts` nor `--config <path>` is provided, AWF exits with an error instead of falling back to the bundled workflow.

## Using the bundled agent-workflow workflow

The bundled `agent-workflow` workflow is opt-in. A project chooses it by exporting the agent-workflow manifest and handlers from its own `awf.config.ts` (or another config passed with `--config`).

```ts
import { createFileSystemTracker } from "@albizures/awf/trackers/filesystem";

export {
	agentWorkflowManifest as manifest,
	agentWorkflowCommandHandlers as commandHandlers,
	agentWorkflowLifecycleHandlers as lifecycleHandlers,
} from "@albizures/awf/workflows/agent-workflow";

export const tracker = createFileSystemTracker({ path: "./.awf/tracker.json" });
```

Example commands:

```sh
awf --config ./awf.config.ts create spec --input ./spec.json
awf --config ./awf.config.ts create task --input ./task.json
awf --config ./awf.config.ts create grilling --input ./grilling.json
awf --config ./awf.config.ts ready
```

A generic Spec create input provides `title` plus `body` or `content`:

```json
{
	"title": "Improve importer reliability",
	"body": "Define the acceptance criteria and generate implementation tasks."
}
```

A generic Task create input belongs to a Spec, carries a project-owned profile, may declare a durable subkind (`work`, `research`, or `prototype`; defaults to `work`), and may record provenance or dependency ordering explicitly. Grilling is a separate top-level collaborative kind, not a Task subkind:

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

AWF core owns lifecycle and readiness semantics: current workflow fields, legal transitions, active-run gates, dependency gates, concurrency gates, parent/child readiness gates, tracker projection, and append-only logs. Generic Task subkind is durable workflow data separate from the lifecycle tuple; readiness still matches kind, state, action, and reason. Project-owned profile policy stays outside the core. A Task profile is freeform routing data such as `test-engineering`, `docs`, or `release`; AWF stores and displays it but does not decide which humans, agents, prompts, tools, or SLAs that profile implies.

In `agent-workflow`, a Spec starts ready for `planning`. Completing planning leaves the Spec at `ready/none` while its implementation Tasks run. When the required child Tasks are done, generic lifecycle relationship policies advance the Spec to `ready/integration-test`; from there it can run integration-test, merge, and finish at `done/none` through ordinary legal lifecycle transitions. Task generation remains an explicit command or handler outcome recorded through normal tracker mutations.

`generatedBy` records generated-by provenance only. This means generated-by provenance is not dependency ordering, is not a readiness gate, and is separate from Spec containment. Use `spec`/parent-child relationships to attach Tasks to a Spec, `dependsOn` to block one Task on another, and `generatedBy` to explain why a Task exists.

## Compatibility with agent-development

The bundled `agent-development` workflow remains supported in maintenance mode for existing Spec/Ticket graphs. New generic work can opt into `agent-workflow`, but existing `agent-development` issues are not automatically migrated, rewritten, or mixed with agent-workflow graphs. Do not mix agent-development and agent-workflow issues in one graph; choose one workflow id per issue graph and keep cross-workflow relationships as external references outside AWF readiness semantics.
