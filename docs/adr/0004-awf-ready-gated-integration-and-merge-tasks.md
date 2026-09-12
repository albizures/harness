# ADR 0004: AWF integration-test and merge are ready-gated Tasks

## Status

Accepted

## Context

`agent-workflow` Specs previously carried `integration-test` and `merge` as Spec lifecycle actions. That made Specs execution-phase containers instead of minimal planning and delivery-completion containers, and it hid verification and merge work from ordinary Task routing.

## Decision

Move integration testing and merging out of the Spec lifecycle. A Spec now executes planning and then stays `ready/none` until an explicit Spec completion command validates delivery state and marks it `done`.

Integration-test and merge work are ordinary Task issues with `subkind=work`. The bundled workflow distinguishes them by Task profile:

- `integration-test` Tasks are blocked by non-terminal sibling Tasks in the `implementation-gate` profile group.
- `merge` Tasks are blocked by non-terminal sibling Tasks in the `implementation-gate` profile group, by non-terminal sibling `integration-test` Tasks, and until at least one sibling `integration-test` Task is done.

AWF readiness gates are coarse scheduling gates only. They do not prove freshness of an integration-test pass after later implementation or review follow-up work.

## Consequences

Agents that create follow-up implementation or review Tasks after an Integration-test Task must also schedule a later Integration-test Task before merge proceeds. Ambiguous scope discovered during integration testing should be resolved with Grilling and/or Task `need-human` rather than silently expanding executable work.

Specs remain simple containers for planning and explicit validated completion, while verification and merge work use normal Task routing, dependencies, concurrency, and readiness reporting.
