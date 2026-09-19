# AWF hierarchical Task kinds replace Task subkind and profile semantics

## Status

Accepted

## Context

ADR 0004 and ADR 0005 moved integration testing and merge handoff into ready-gated Tasks, but they encoded workflow semantics in Task `subkind` and reserved profile values such as `integration-test` and `merge`. That made `profile` carry both routing and workflow meaning, and left research/prototype classification outside the manifest kind hierarchy.

## Decision

Replace Task `subkind` with hierarchical workflow kind IDs. The bundled taxonomy is `task` as the Task family and lifecycle parent, concrete `task:work`, `task:research`, `task:prototype`, `task:work:integration-test`, and `task:work:merge` kinds, with `task:work` available for ordinary executable work. Task lifecycle action remains `work`; semantic distinctions live in the kind ID, not in the action.

`profile` remains project-owned routing data only. Readiness gates that previously depended on reserved profiles must use Task kind semantics or kind groups instead. ADR 0004 and ADR 0005 still govern the shape of integration-test and merge as ready-gated ordinary Tasks and optional merge handoff, but this ADR supersedes their profile-based classification details.

Kind parentage starts as implicit colon-segment ancestry with centralized delimiter-safe matching and normalized inherited defaults in the manifest/runtime seam. Public creation should expose direct bundled commands for concrete Task kinds while retaining a validated generic creation seam for future code and tests. Because existing tracker issues store `workflow.kind: task` plus `workflow.data.subkind`, this is a hard break that requires an explicit migration command/tool; the migration preserves `profile` and maps only canonical legacy verification/merge profiles to semantic Task kinds.

## Consequences

AWF must stop treating arbitrary profile names as workflow semantics. Legacy `task` issues with `subkind` are invalid until migrated to concrete hierarchical Task kinds, and docs, skills, tests, CLI output, manifest validation, readiness filters, relationship checks, and tracker examples need to speak in kind IDs instead of Task subkind.
