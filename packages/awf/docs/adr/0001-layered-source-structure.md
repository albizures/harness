# Layer AWF source by architectural role

AWF source is organized by architectural role under `packages/awf/src`: `cli`, `runtime`, `domain`, `ports`, `adapters`, `workflows`, and `shared`. This makes the package structure reflect the boundary between process-level CLI composition, Workflow runtime orchestration, pure workflow model concepts, Tracker API ports, concrete tracker adapters, bundled workflows, and cross-cutting utilities.

## Decision

- `cli` owns the `awf` binary entrypoint, AWF config file loading, process I/O, CLI-shaped argument adaptation, and envelope rendering.
- `runtime` owns Workflow runtime execution: command routing, manifest execution mechanics, Tracker Intent Module coordination, command handlers, lifecycle transition handlers, Workflow module loading, and runtime envelopes.
- `domain` owns pure Workflow definition, Workflow manifest, Workflow issue, Workflow log, Workflow attempt, and current workflow field concepts and rules. Domain code must not depend on CLI, filesystem, GitHub, or other process/integration concerns.
- `ports` owns runtime boundaries such as the Tracker API interface.
- `adapters` owns implementations of those ports, such as file-backed, in-memory, and GitHub tracker adapters.
- `workflows` owns bundled workflows, including `agent-workflow` and `generic-task`, plus default bundled handler wiring that should not be embedded in runtime core.
- `shared` owns generic helpers, such as JSON and error utilities, that are not domain or runtime concepts.

## Public exports

Public package export paths in `packages/awf/package.json` remain stable even when implementation files move. Consumers may continue importing paths such as `@albizures/awf`, `@albizures/awf/trackers/filesystem`, `@albizures/awf/manifest`, `@albizures/awf/manifest/definition`, `@albizures/awf/workflow-module`, and bundled workflow subpaths. Source-path shims may exist to preserve these public subpaths, but internal code should import directly from the new truthful implementation locations.

## Consequences

Future refactors should move code toward the layer that owns its vocabulary and dependencies rather than preserving historical filenames. The Workflow runtime may depend on domain types and Tracker API ports, adapters may implement ports, and CLI code may compose runtime calls, but pure domain modules stay independent of runtime, adapters, and process concerns. This keeps AWF easier for future agents and maintainers to navigate while allowing implementation files to change without breaking the package API.
