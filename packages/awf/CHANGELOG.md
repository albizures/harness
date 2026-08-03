# @albizures/awf

## 0.1.0

### Minor Changes

- 6e99d71: Add generic failure retry, explicit escalation to `need-human/none`, explicit resume to selected ready actions, and manifest lifecycle policy constraints.
- 6e99d71: Add the runtime Tracker API, in-memory tracker adapter, normalized Workflow issue projection, and seeded `awf get` smoke path.
- 6e99d71: Implement AWF lifecycle commands for get, logs, start, succeed, and fail with manifest transition enforcement, active run tracking, terminal outcome idempotency, and derived run attempts.
- 6e99d71: Implement `awf ready` with manifest readiness filters, dependency and concurrency gates, deterministic ordering, suggested start command metadata, and `--limit` support.
- 6e99d71: Implement bundled Spec/Ticket workflow commands for creating Specs and applying complete plan bundles, including validation and rollback outcomes.
- 6e99d71: Allow manifest-declared create/apply workflow commands to run for non-bundled workflow kinds.
- 6e99d71: Add TypeScript-authored declarative workflow manifest loading and validation with CLI smoke support.

### Patch Changes

- 6e99d71: Require structured workflow artifact reference objects in manifest payload schemas and normalize tracker artifact storage to structured artifact records.
- 6e99d71: Ensure GitHub workflow issue projection uses only canonical reserved current-field labels when listing and updating issues.
- 6e99d71: Use canonical v1 GitHub machine comment markers for current workflow metadata and append-only workflow logs.
- 6e99d71: Move plan application onto tracker-owned verified workflow intents that surface partial drift as NEED_RECONCILIATION.
- 6e99d71: Align bundled workflow readiness with computed dependency and concurrency gates instead of durable blocked state.
- 6e99d71: Remove legacy JSON-schema-like payload contracts from the public workflow manifest API and validate runtime payloads with manifest-owned Zod schemas.
- 6e99d71: Align bundled Spec planning so planned Specs wait at `ready/none` until all child Tickets are done before progressing to `ready/integration-test`.
- 6e99d71: Expand Workflow artifact helpers and runtime artifact handling to accept structured artifact reference objects while preserving legacy string references.
- 6e99d71: Constrain low-level Tracker mutation primitives behind adapter implementations and route runtime write paths through intent-oriented Tracker methods.
- 6e99d71: Migrate the bundled agent-development workflow manifest to first-class Zod payload contracts.
- 6e99d71: Validate loaded workflow manifest shape with Zod and reject unsupported generic link relationship projections.
- 6e99d71: Add public Zod payload schema helpers and first-class workflow artifact reference authoring primitives.
