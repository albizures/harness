# ADR 0003: Agent-workflow compatibility boundary

## Status

Accepted

## Context

ADR 0002 removed the legacy `agent-development` bundled workflow while retaining a broad generic manifest/runtime compatibility promise for project-authored workflows. Follow-up removal work intentionally narrowed that public boundary: AWF no longer aims to be a generic workflow-authoring platform with arbitrary project-defined command surfaces.

Future maintainers and release consumers need a clear compatibility statement that separates ADR 0002's historical `agent-development` removal decision from its now-obsolete generic-runtime retention decision.

## Decision

AWF is the runtime and CLI for the bundled `agent-workflow` workflow. Its public compatibility boundary is the supported `agent-workflow` issue model, CLI commands, tracker adapters, envelopes, JSON helpers, and documented workflow data types needed to operate that workflow.

This ADR supersedes only ADR 0002's decision and consequence to retain generic manifest/runtime capabilities for project-authored workflow definitions. ADR 0002's decision to remove the `agent-development` bundled workflow remains accepted and historical.

AWF does not publish generic workflow-authoring APIs as public product capabilities. Unsupported capabilities include generic manifest authoring, arbitrary project-defined CLI verbs, public command-handler registration, raw-input handler conventions, reusable tracker intent APIs, and generic bundled workflow compatibility.

`run-command` remains available only as an internal/automation compatibility escape hatch for command-id dispatch. It is not part of normal user help and should not be documented as the primary command surface.

## Consequences

Release notes for the removal are a breaking public API boundary change for `@albizures/awf`.

Projects should use the bundled `agent-workflow` workflow and the documented CLI commands, or treat any remaining internal runtime hooks as unsupported implementation details. Future AWF documentation should describe the simplified `agent-workflow` product and avoid presenting generic workflow authoring or raw handler extension conventions as stable public capabilities.
