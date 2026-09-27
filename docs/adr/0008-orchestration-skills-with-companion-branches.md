# Orchestration skills use companion workflow branches

The shared design workflows expose only `/spec` and `/wayfinder` as user-facing orchestration skills. Their phase-specific procedures live in non-invocable companion documents (`to-spec`, `to-tasks`, `work-spec`, `chart-map`, and `work-map`) because these are workflow branches rather than independent capabilities; this reduces invocation and catalog cognitive load while preserving progressive disclosure and explicit routing.

## Consequences

- Direct `/to-spec` and `/to-tasks` invocations are retired.
- The orchestration skills must retain shared Forge and lifecycle guards and route explicitly to the correct companion.
- Companion documents are not independently discoverable through skill invocation; the routers are the stable user-facing entry points.
