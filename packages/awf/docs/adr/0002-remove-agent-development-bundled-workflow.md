# ADR 0002: Remove the agent-development bundled workflow

## Status

Accepted. ADR 0003 supersedes only this ADR's decision and consequence to retain generic manifest/runtime capabilities; the `agent-development` removal decision remains accepted.

## Context

AWF had two bundled workflows: `agent-workflow` and the older `agent-development` Spec/Ticket workflow. Maintaining both increased public API surface, duplicated tests, and kept workflow-specific plan/handoff behavior in the package after `agent-workflow` became the supported bundled workflow.

## Decision

Remove the `agent-development` bundled workflow implementation and public export path. Keep generic AWF runtime features that are still useful for project-authored workflow definitions, even if the removed workflow was their main bundled user.

## Consequences

Existing imports from `@albizures/awf/workflows/agent-development` are no longer supported. Projects that need a development workflow should use `agent-workflow` or provide their own workflow module. Generic manifest/runtime capabilities such as reasons, raw command handlers, source CLI declarations, and tracker effects remain available.
