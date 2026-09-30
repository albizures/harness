# ADR 0005: Remove GitHub tracker adapter

## Status

Accepted

AWF removes the GitHub tracker adapter and the tracker-specific manifest metadata that existed only to support its label projection. The filesystem tracker is the supported durable tracker boundary for AWF issue storage, with the in-memory tracker retained for tests and programmatic callers that need ephemeral storage.

This is an immediate breaking removal rather than a compatibility deprecation. Keeping aliases, adapter shims, or unused manifest fields would preserve obsolete tracker-specific vocabulary in the public model and make the runtime harder to reason about. Projects should use the default `.awf/tracker` filesystem storage or configure `createFileSystemTracker` explicitly.

Future external durable tracker adapters are not forbidden, but they require a new architectural decision. Any future adapter must introduce tracker-neutral manifest and domain vocabulary instead of reusing the removed GitHub-shaped projection concepts.
