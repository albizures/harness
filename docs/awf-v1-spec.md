# `@albizures/awf` v1 product/design spec

This document is the implementation handoff for the v1 `@albizures/awf` package and canonical `awf` binary. It consolidates the closed Wayfinder decisions from [#24](https://github.com/albizures/harness/issues/24) without repeating each issue body; follow the linked decision issues for rationale and rejected alternatives.

## Decision sources

- [#25 Research prior art](https://github.com/albizures/harness/issues/25)
- [#26 Prototype manifest-driven state-machine semantics](https://github.com/albizures/harness/issues/26)
- [#27 v1 Workflow definition schema](https://github.com/albizures/harness/issues/27)
- [#28 state, log, and reconciliation invariants](https://github.com/albizures/harness/issues/28)
- [#29 Tracker API and GitHub v1 mapping](https://github.com/albizures/harness/issues/29)
- [#30 CLI contract](https://github.com/albizures/harness/issues/30)
- [#31 bundled Spec/Ticket workflow](https://github.com/albizures/harness/issues/31)
- [#32 implementation handoff plan](https://github.com/albizures/harness/issues/32)

## Product shape

`@albizures/awf` is a small package containing:

1. the `awf` CLI;
2. a generic Workflow runtime;
3. a strict declarative Workflow definition loader and validator;
4. an in-memory Tracker API adapter for tests and local smoke paths;
5. a GitHub Tracker API adapter for v1 production use; and
6. one Bundled workflow for agent-development work using Spec and Ticket Workflow issue kinds.

The Workflow runtime is generic. It evaluates Workflow issue state, legal transitions, command schemas, relationships, logs, tracker mutations, readiness, and reconciliation from a Workflow definition. It must not hard-code Spec or Ticket logic outside the bundled Workflow definition and narrow runtime services needed to execute that definition.

## Domain model

- A **Workflow definition** is a TypeScript-authored, declarative manifest exported through `defineManifest`, loaded with `jiti`, and validated at runtime. TypeScript is for authoring ergonomics only; v1 does not allow executable hooks or workflow scripts.
- A **Workflow issue** is the runtime's core object: one tracker issue with exactly one manifest-defined kind, explicit Current workflow fields, relationships, artifacts, and append-only Workflow logs.
- **Current workflow fields** are tracker-backed fields such as kind, state, action, optional reason, active run id, and projection version/hash. They are authoritative for normal command executability.
- A **Workflow log** is an append-only, machine-marked event record. Logs are authoritative for audit/history and drift diagnosis, not a replacement for Current workflow fields during normal execution.
- A **Workflow run** is one action attempt. A running Workflow issue carries exactly one active run id, and that run can have exactly one immutable terminal outcome.
- **Workflow reconciliation** compares Current workflow fields, metadata, logs, and tracker projection to detect drift or corruption. It is read-only by default and may apply only deterministic safe repairs.
- A **Handoff artifact** is structured context attached to a source Workflow issue through command output or logs. It is not a v1 Workflow issue kind and does not by itself mean human intervention is required.

## CLI contract

All commands write a stable JSON envelope to stdout:

```json
{ "ok": true, "data": {}, "meta": {} }
```

Errors use the same envelope shape and a nonzero exit code:

```json
{
  "ok": false,
  "error": { "code": "INVALID_TRANSITION", "message": "...", "details": {} },
  "meta": {}
}
```

stderr is diagnostics-only. Inputs passed with `--input <file|->` are raw command payloads, not envelopes.

Fixed runtime verbs:

```text
awf get <issue>
awf ready [--filter <name>=<value>]... [--limit <n>]
awf logs <issue>
awf start <issue>
awf succeed <issue> --run <run> --input <file|->
awf fail <issue> --run <run> --input <file|->
awf escalate <issue> --input <file|->
awf resume <issue> --action <action>
awf create <target> --input <file|->
awf apply <target> [subject] --input <file|->
awf reconcile <issue> [--apply]
```

The bundled workflow declares these canonical targets:

```text
awf create spec --input spec.md
awf apply plan <spec-issue> --input plan.json
awf create handoff --source <issue> --input handoff.json
```

Aliases may exist only as thin conveniences over the canonical generic/noun-first commands.

Core runtime error families include invalid input, unknown command target/filter, issue not found, not a Workflow issue, invalid transition, dependency or concurrency blocking, run mismatch, already-completed run, tracker conflict or unavailability, corrupt workflow state, and unsafe reconciliation. Manifest-specific validation may add namespaced validation codes.

## Workflow definition schema

A v1 Workflow definition declares:

- `version: "v1"` and a workflow id;
- global state/action/reason/event vocabularies;
- Workflow issue kinds, each with an initial status and exact event-triggered transitions;
- manifest-owned create/apply command targets with input/output schemas;
- artifact reference declarations for inline JSON, inline Markdown, file, issue, pull request, URL, git ref, handoff, and findings-style outputs;
- semantic issue relationships projected as hierarchy or dependency;
- manifest-declared readiness filters; and
- concurrency rules by global, kind, scope, action, or issue as needed.

Excluded from v1: executable hooks/scripts, wildcard transitions, arbitrary guard expressions, custom tracker operations in the manifest, custom artifact transports, recursive workflow definitions, and plugin loading from the manifest.

## Runtime and state-machine semantics

Normal commands use Current workflow fields to decide executability. They do not replay issue prose, human comments, or logs to guess current state.

`start` is atomic from the Workflow runtime perspective: it sets state/action to running, stores exactly one active run id, and appends the matching action-started Workflow log. Partial evidence is reconciliation input, not a successful start.

`succeed` validates the active run id, validates structured input against the current transition schema, records required artifacts, appends the terminal Workflow log, and advances through the manifest's exact transition. `fail` validates the active run id, records failure details, appends the terminal Workflow log, and by default returns a running action to the same `ready/<action>` retry target; manifests may still define explicit failure transitions or constrain retry policy. Retrying the same terminal operation is idempotent only when the payload is identical; a different payload or terminal outcome is an error.

`ready` is read-only. It returns legally executable Workflow issues in deterministic order from explicit state plus live gates. Dependency and concurrency blocking are computed readiness results, not durable Current workflow fields.

`reconcile` is read-only unless `--apply` is present. Applied reconciliation is limited to deterministic safe repairs. Malformed machine logs/current metadata, duplicate current labels, missing required current fields, ambiguous log ordering, and unknown reserved projections make the Workflow issue non-executable until repaired or marked for human intervention.

## Tracker API boundary

The Tracker API is an intent-oriented, lowest-common-denominator boundary. The Workflow runtime talks in normalized concepts: issue refs, Current workflow fields, relationships, changes/artifacts, Workflow logs, projection versions/hashes, and readiness queries.

Mutating operations are conditional: the runtime supplies an expected projection version/hash; the adapter re-reads, performs minimal tracker operations, and verifies the resulting projection. Precondition or post-verification mismatch returns a reconciliation-needed error instead of silently normalizing drift.

Parent-agent commands must not expose generic label/comment mutation as workflow operations.

## GitHub v1 mapping

The GitHub adapter maps a Workflow issue to a GitHub issue with exactly one kind and reserved workflow projection:

- enum Current workflow fields are queryable reserved labels shaped `awf:<workflow-id>:<field>:<value>` by default;
- high-cardinality fields such as active run id and projection version/hash live in strict singleton current metadata comments;
- append-only Workflow logs are strict machine-marked comments;
- native GitHub sub-issues represent Spec child Tickets;
- native GitHub issue dependencies represent Ticket dependencies;
- missing native hierarchy/dependency capability is a v1 adapter initialization failure; and
- implementation or integration changes are explicit pull-request artifact references, not inferred from closing links, branches, or prose.

Manual corruption of reserved labels or machine comments must produce reconciliation-needed behavior, not silent repair during normal commands. Human labels and comments outside the reserved namespace are ignored by the runtime.

## Bundled Spec/Ticket workflow

The bundled workflow has two Workflow issue kinds: `spec` and `ticket`.

Durable states are `ready`, `running`, `need-human`, and `done`. Blocking from dependencies or concurrency is computed readiness, not a durable blocked state. Explicit escalation uses `need-human/none`; resumption chooses the next action and returns the issue to `ready/<action>`.

Actions are `plan`, `implement`, `review`, `fix`, `integration-test`, `merge`, and `none`.

Spec lifecycle:

1. `create spec` creates `ready/plan`.
2. Applying a complete plan creates child Tickets, creates Ticket dependencies, logs the plan, and leaves the Spec unschedulable while children execute.
3. When all child Tickets are `done`, the Spec becomes ready for `integration-test`.
4. Integration success with a Spec PR artifact advances to `ready/merge`.
5. Integration changes-needed with findings/handoff context returns to `ready/plan` for more Tickets.
6. Merge success advances the Spec to `done/none`.

Ticket lifecycle:

1. Tickets start as `ready/implement`; dependencies gate only this initial action.
2. Implement success requires exactly one implementation PR artifact and advances to `ready/review`.
3. Review approval advances to `ready/merge`.
4. Review changes-requested may attach findings or a Handoff artifact and advances to `ready/fix`.
5. Fix success reuses the same implementation PR and returns to `ready/review`.
6. Merge success advances the Ticket to `done/none`.

## Invariants

- One Workflow issue has exactly one manifest-defined kind.
- A running Workflow issue has exactly one active run id.
- A Workflow run has exactly one immutable terminal outcome.
- Workflow logs are append-only and machine-marked entries are strict.
- Current workflow fields drive normal executability; logs diagnose drift.
- Dependency/concurrency readiness gates are live computations.
- Plan application is atomic from the runtime perspective; failed application rolls back when safe, otherwise escalates to `need-human/none`.
- Handoff artifacts do not automatically create `need-human` state.
- Pull request artifacts are explicit workflow outputs.

## Explicit v1 out of scope

- Handoff as a Workflow issue kind.
- Ticket-level integration testing.
- Multiple or replacement implementation PRs per Ticket.
- Automatic escalation merely because a Handoff artifact exists.
- Distributed locking between orchestrators.
- Body/task-list fallback for GitHub hierarchy or dependencies.
- Inferring changes from GitHub prose, closing keywords, branch names, or timeline events.
- Custom workflow code hooks or adapter-specific manifest operations.

## Implementation issue order

1. [#33 Bootstrap `@albizures/awf` package and `awf` CLI envelope](https://github.com/albizures/harness/issues/33)
2. [#34 Load and validate declarative Workflow definitions](https://github.com/albizures/harness/issues/34)
3. [#35 Implement in-memory Tracker API and Workflow issue projection](https://github.com/albizures/harness/issues/35)
4. [#36 Execute lifecycle transitions with current fields, logs, and runs](https://github.com/albizures/harness/issues/36)
5. [#37 Implement ready query with dependencies and concurrency gates](https://github.com/albizures/harness/issues/37)
6. [#38 Implement bundled Spec/Ticket workflow creation and plan application](https://github.com/albizures/harness/issues/38)
7. [#39 Implement bundled workflow action completion and artifact validation](https://github.com/albizures/harness/issues/39)
8. [#40 Implement reconciliation diagnostics and safe repair boundaries](https://github.com/albizures/harness/issues/40)
9. [#41 Implement GitHub tracker adapter mapping](https://github.com/albizures/harness/issues/41)
10. [#42 Write this v1 product/design spec and implementation handoff](https://github.com/albizures/harness/issues/42)

## Final smoke walkthrough

This walkthrough is intended to be runnable once the implementation tickets above are complete and `awf` is configured to use a persistent Tracker API adapter, such as the GitHub adapter or a single-process smoke harness. It shows the agent-facing command loop; replace placeholder ids and run ids with values from the preceding JSON envelopes.

```sh
pnpm --filter @albizures/awf build

cat > /tmp/awf-spec.md <<'EOF'
# Add greeting command

Build a tiny CLI greeting feature.
EOF

awf create spec --input /tmp/awf-spec.md

cat > /tmp/awf-plan.json <<'EOF'
{
  "tickets": [
    { "key": "implement", "title": "Implement greeting", "content": "Add the command and tests." },
    { "key": "docs", "title": "Document greeting", "content": "Update help/docs.", "dependsOn": ["implement"] }
  ]
}
EOF

awf apply plan <spec-issue> --input /tmp/awf-plan.json
awf ready --filter spec=<spec-issue> --limit 1

awf start <ticket-issue>
awf succeed <ticket-issue> --run <run-id> --input - <<'EOF'
{ "implementationPr": "https://github.com/albizures/harness/pull/123" }
EOF

awf start <ticket-issue>
awf succeed <ticket-issue> --run <run-id> --input - <<'EOF'
{ "verdict": "approved" }
EOF

awf start <ticket-issue>
awf succeed <ticket-issue> --run <run-id> --input - <<'EOF'
{ "merged": true }
EOF

awf ready --filter spec=<spec-issue>
awf start <spec-issue>
awf succeed <spec-issue> --run <run-id> --input - <<'EOF'
{ "verdict": "passed", "specPr": "https://github.com/albizures/harness/pull/124" }
EOF

awf start <spec-issue>
awf succeed <spec-issue> --run <run-id> --input - <<'EOF'
{ "merged": true }
EOF

awf get <spec-issue>
awf logs <spec-issue>
```

Expected result: each command emits a JSON envelope, `ready` only returns legally executable work, Ticket dependencies block only initial implementation, each `start` returns the run id required by terminal commands, pull requests are recorded as artifacts, and the final Spec reaches `done/none`.
