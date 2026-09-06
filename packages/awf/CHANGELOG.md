# @albizures/awf

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
