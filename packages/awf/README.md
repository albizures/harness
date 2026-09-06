# @albizures/awf

Agent Workflow (AWF) provides a generic workflow runtime and CLI for tracker-backed Workflow issues.

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
	workflow: { id: "my-workflow" },
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

## Using the bundled generic-task workflow

The bundled `generic-task` workflow is opt-in. A project chooses it by exporting the generic-task manifest and handlers from its own `awf.config.ts` (or another config passed with `--config`).

```ts
import { createFileSystemTracker } from "@albizures/awf/trackers/filesystem";

export {
	genericTaskManifest as manifest,
	genericTaskCommandHandlers as commandHandlers,
	genericTaskLifecycleHandlers as lifecycleHandlers,
} from "@albizures/awf/workflows/generic-task";

export const tracker = createFileSystemTracker({ path: "./.awf/tracker.json" });
```

Example commands:

```sh
awf --config ./awf.config.ts create spec --input ./spec.json
awf --config ./awf.config.ts create task --input ./task.json
awf --config ./awf.config.ts ready
```

A generic Spec create input provides `title` plus `body` or `content`:

```json
{
	"title": "Improve importer reliability",
	"body": "Define the acceptance criteria and generate implementation tasks."
}
```

A generic Task create input belongs to a Spec, carries a project-owned profile, and may record provenance or dependency ordering explicitly:

```json
{
	"spec": "42",
	"title": "Add importer retry tests",
	"description": "Cover retry and permanent-failure behavior.",
	"profile": "test-engineering",
	"generatedBy": "42",
	"dependsOn": ["43"]
}
```

## Policy boundaries

AWF core owns lifecycle and readiness semantics: current workflow fields, legal transitions, active-run gates, dependency gates, concurrency gates, parent/child readiness gates, tracker projection, and append-only logs. Project-owned profile policy stays outside the core. A Task profile is freeform routing data such as `test-engineering`, `docs`, or `release`; AWF stores and displays it but does not decide which humans, agents, prompts, tools, or SLAs that profile implies.

In `generic-task`, a Spec is ready at a phase boundary: it is ready when it has no child Tasks or when all child Tasks are done. Use those ready Spec boundaries to review the previous phase and, when needed, generate the next batch of child Tasks. Do not treat every child Task completion as an automatic Spec migration or hidden planning hook; Task generation remains an explicit command or handler outcome recorded through normal tracker mutations.

`generatedBy` records generated-by provenance only. This means generated-by provenance is not dependency ordering, is not a readiness gate, and is separate from Spec containment. Use `spec`/parent-child relationships to attach Tasks to a Spec, `dependsOn` to block one Task on another, and `generatedBy` to explain why a Task exists.

## Compatibility with agent-development

The bundled `agent-development` workflow remains supported in maintenance mode for existing Spec/Ticket graphs. New generic work can opt into `generic-task`, but existing `agent-development` issues are not automatically migrated, rewritten, or mixed with generic-task graphs. Do not mix agent-development and generic-task issues in one graph; choose one workflow id per issue graph and keep cross-workflow relationships as external references outside AWF readiness semantics.
