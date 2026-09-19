# ADR 0005: AWF Spec planning completion and optional Merge Tasks

## Status

Accepted. ADR 0006 supersedes inherited Task profile classification details from ADR 0004/0005; this ADR still records explicit planning completion and optional Merge Tasks.

## Context

ADR 0004 moved integration testing and merging out of the Spec lifecycle and into ready-gated Tasks. That kept Specs from becoming execution-phase containers, but it still treated a completed Merge Task as required for every Spec completion.

Some Specs do not need a separate merge or release handoff step. Documentation-only work, local workflow changes, or follow-up Specs may be fully delivered once planning is accepted, child Tasks are terminal, and child Grilling issues are closed.

## Decision

Add explicit Spec planning completion as a public lifecycle command: `awf spec planned <issue>`. It records that the accepted task breakdown has moved the Spec from `ready/planning` to `ready/none`; implementation, verification, and any handoff continue through child Tasks.

Keep Merge Tasks as ordinary ready-gated Tasks routed by the `merge` profile, but make them optional. A Spec completion command validates that planning is complete, all child Tasks are terminal, and child Grilling issues are not open. It does not require that a Merge Task exists or that one is done.

ADR 0004 still governs Integration-test and Merge Task readiness when those Tasks exist. This ADR refines ADR 0004 by removing the universal completed-Merge-Task requirement from Spec completion.

## Consequences

Agents should create Merge Tasks only when the Spec's delivery path needs explicit merge, release, or handoff work. When a Merge Task exists, AWF readiness still delays it until implementation-gate Tasks are closed, no Integration-test Task is open, and at least one Integration-test Task is done.

Integration-test freshness remains an agent-planning obligation. Follow-up implementation or review work after an Integration-test Task should schedule another Integration-test Task before merge/release handoff work or Spec completion proceeds.
