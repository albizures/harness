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
