# @albizures/awf

## 1.0.0

### Major Changes

- c87de74: Remove the legacy `agent-development` bundled workflow, including its root exports and the `@albizures/awf/workflows/agent-development` subpath. Use `agent-workflow` or a project-owned workflow module instead.
- c87de74: Remove unsupported generic workflow-authoring/runtime APIs from the public AWF boundary. AWF is now `agent-workflow`-first: generic manifest authoring, project-defined command surfaces, workflow-module authoring exports, workflow-position reasons, generic source/apply command dimensions, user-facing `awf apply` dispatch, and normal-help `run-command` exposure are no longer public capabilities.
- c87de74: Remove the stale `generic-task` workflow exports and `@albizures/awf/workflows/generic-task` subpath in favor of the canonical `agent-workflow` bundled workflow module.

### Minor Changes

- c87de74: Change the filesystem tracker path to a tracker directory with one numeric issue file per issue.
- c87de74: Narrow the public AWF boundary by removing artifact/change exports and documenting runtime-owned concepts as issues, lifecycle state, relationships, readiness, and text logs.
- c87de74: Add generic waiting-human pause and respond lifecycle commands.
- c87de74: Persist workflow semantic versions on manifest-created issues and require migration or reconciliation before manifest commands mutate issues recorded with a different workflow version.
- c87de74: Model integration-test and merge as ready-gated Task profiles, add explicit Spec completion validation, and document integration-test freshness as an agent obligation.
- c87de74: Replace manifest transition run effects with Workflow attempt effects.
- c87de74: Require workflow semantic versions and expose lifecycle active/terminal state semantics in manifest validation and workflow descriptions.
- c87de74: Route manifest-declared CLI verbs beyond create/apply, add hidden `run-command <command-id>` dispatch, and stop exposing runtime lifecycle verbs as top-level built-ins.
- c87de74: Remove artifact/change recording from tracker APIs, workflow effects, lifecycle handler contributions, and bundled command handling.

### Patch Changes

- c87de74: Move AWF runtime dispatch internals under the runtime layer and CLI composition/output internals under the CLI layer while preserving the public execute compatibility seam.
- c87de74: Constrain lifecycle transition handlers to read-only tracker access while keeping handler-contributed artifacts and generic effects applied by AWF core.
- c87de74: Migrate bundled generic task lifecycle controls to manifest-owned task commands.
- c87de74: Preserve generic Spec execution by starting Specs in planning, advancing them to integration-test after child Tasks complete, and allowing merge-to-done lifecycle transitions.
- c87de74: Add Grilling as a top-level collaborative agent-workflow kind with in-discussion lifecycle state and optional Spec or Wayfinder parent links.
- c87de74: Remove manifest lifecycle retry, escalation, and resume allow-list policy from the public contract while keeping bundled agent-workflow lifecycle commands working.
- c87de74: Document and lock the filesystem tracker Markdown issue-file format, including the readable logs heading.
- c87de74: Store file-backed workflow logs as readable markdown list entries and restore them with strict corruption checks.
- c87de74: Narrow workflow issue reads to workflow projections and relationships, and store workflow logs as text-only messages.
- c87de74: Project and display Task subkind separately from workflow kind/state/action/reason fields.
- c87de74: Document the Failure definition API and standardize runtime and CLI internals on module-owned Failure catalogs, guarded by convention tests that prevent migrated source from regressing to raw failure string literals.
- c87de74: Remove manifest payload schema support outside command input declarations.
- c87de74: Remove configurable relationship projection direction from workflow manifests while preserving supported relationship projection types.
- c87de74: Declare generated-by Task provenance as a first-class manifest relationship projection distinct from parent-child containment and dependency blocking.
- c87de74: Add generic Task subkind workflow data with work/research/prototype declarations and work as the default.

## 0.2.0

### Minor Changes

- 6a3faee: Add workflow module command handlers keyed by manifest command ids, with core-owned input and output validation plus generic create/apply fallback behavior.
- 6a3faee: Require an explicit workflow config or `--config` for CLI execution, document explicit workflow module setup, and keep bundled `agent-development` usage behind explicit imports.
- 6a3faee: Record generated Task provenance via optional `generatedBy` without using it as a readiness gate.
- 6a3faee: Add the bundled generic-task workflow for explicit AWF project opt-in.
- 6a3faee: Add workflow-module Lifecycle transition handlers that can contribute validated log payload additions, artifact requests, changes, and declarative workflow effects to lifecycle transitions.
- 6a3faee: Add a Workflow description DTO builder that exposes manifest-only declarative data with schema presence markers.
- 6a3faee: Add public Workflow manifest and Workflow definition boundaries while preserving legacy manifest behavior.
- 6a3faee: Add a public Workflow module loader boundary for loading Workflow manifest exports and runtime integration bindings.

### Patch Changes

- 6a3faee: Validate bundled workflow artifact references and Handoff artifacts before recording them.
- 6a3faee: Validate generic-task Spec and Task create input as structured JSON with required title and Markdown body/content, and declare create output validation.
- 6a3faee: Document explicit `generic-task` opt-in, project-owned Task profile policy, generated-by provenance versus dependency ordering, phase-boundary Task generation, and `agent-development` maintenance-mode compatibility.
- 6a3faee: Replace the plan-specific tracker application intent with generic ordered Workflow effects that verify projections and best-effort rollback before surfacing reconciliation.
- 6a3faee: Add shared AWF JSON boundary schemas and helpers for validating JSON-compatible values after runtime parsing.
- 6a3faee: Validate AWF lifecycle escalation payloads through schema and JSON compatibility before workflow mutation.
- 6a3faee: Validate plan application ticket and dependency payload shapes before applying tracker relationships.
- 6a3faee: Render workflow descriptions as deterministic Markdown in default text output.

## 0.1.0

### Minor Changes

- 6e99d71: Add generic failure retry, explicit escalation to `need-human/none`, explicit resume to selected ready actions, and manifest lifecycle policy constraints.
- 87e38f6: Add a file-backed tracker adapter exported from `@albizures/awf/trackers/filesystem` for durable local Workflow issue state.
- 6e99d71: Add the runtime Tracker API, in-memory tracker adapter, normalized Workflow issue projection, and seeded `awf get` smoke path.
- 6e99d71: Implement AWF lifecycle commands for get, logs, start, succeed, and fail with manifest transition enforcement, active run tracking, terminal outcome idempotency, and derived run attempts.
- 6e99d71: Implement `awf ready` with manifest readiness filters, dependency and concurrency gates, deterministic ordering, suggested start command metadata, and `--limit` support.
- 6e99d71: Implement bundled Spec/Ticket workflow commands for creating Specs and applying complete plan bundles, including validation and rollback outcomes.
- 6e99d71: Allow manifest-declared create/apply workflow commands to run for non-bundled workflow kinds.
- 87e38f6: Add a shared Tracker Intent Module factory for tracker adapters and expose explicit primitive read, operation, and verification hook contracts.
- 6e99d71: Add TypeScript-authored declarative workflow manifest loading and validation with CLI smoke support.
- 87e38f6: Add workflow module loading that validates a required manifest export and exposes an optional concrete tracker binding.

### Patch Changes

- 6e99d71: Require structured workflow artifact reference objects in manifest payload schemas and normalize tracker artifact storage to structured artifact records.
- 6e99d71: Ensure GitHub workflow issue projection uses only canonical reserved current-field labels when listing and updating issues.
- 6e99d71: Use canonical v1 GitHub machine comment markers for current workflow metadata and append-only workflow logs.
- 87e38f6: Bind CLI execution to cwd `awf.config.ts` or global `--config`; AWF now fails without an explicit workflow config, and the bundled `agent-development` workflow must be imported explicitly.
- 6e99d71: Move plan application onto tracker-owned verified workflow intents that surface partial drift as NEED_RECONCILIATION.
- 6e99d71: Align bundled workflow readiness with computed dependency and concurrency gates instead of durable blocked state.
- 6e99d71: Remove legacy JSON-schema-like payload contracts from the public workflow manifest API and validate runtime payloads with manifest-owned Zod schemas.
- 6e99d71: Align bundled Spec planning so planned Specs wait at `ready/none` until all child Tickets are done before progressing to `ready/integration-test`.
- 6e99d71: Expand Workflow artifact helpers and runtime artifact handling to accept structured artifact reference objects while preserving legacy string references.
- 6e99d71: Constrain low-level Tracker mutation primitives behind adapter implementations and route runtime write paths through intent-oriented Tracker methods.
- 87e38f6: Centralize Tracker adapter composition in the Tracker Intent Module so backend adapters only own primitive persistence, projection, and relationship operations.
- 6e99d71: Migrate the bundled agent-development workflow manifest to first-class Zod payload contracts.
- 6e99d71: Validate loaded workflow manifest shape with Zod and reject unsupported generic link relationship projections.
- 6e99d71: Add public Zod payload schema helpers and first-class workflow artifact reference authoring primitives.
