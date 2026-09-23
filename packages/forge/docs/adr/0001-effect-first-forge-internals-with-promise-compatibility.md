# Effect-first Forge internals with Promise compatibility

Forge will migrate IO and orchestration internals toward Effect-first APIs while preserving the existing Promise-returning public surface during the migration. The Effect runtime boundary will be centralized through `src/runtime.ts` helpers, with the executable CLI eventually using `NodeRuntime.runMain`; command handlers should keep using Promise wrappers until a deliberate CLI migration slice.

This keeps current consumers and tests stable while allowing Forge to adopt `@effect/platform` for filesystem, path, command, and runtime concerns. The first implementation slice should add platform dependencies, introduce `runForgePromise`, and migrate `filesystem-store.ts` bottom-up with internal `*Effect` functions plus Effect-native tests. Low-level helpers may depend directly on platform services first; a higher-level Forge store service should wait until repeated patterns justify it.

Promise wrappers should map known domain failures to `ForgeError` but preserve unexpected platform failures instead of flattening everything. Existing synchronous schema decoding remains unchanged. Existing `now` injection should be used where already present, but broader time/process abstraction is deferred; the first slice should only improve temp-file cleanup around atomic writes where interruption or failure can leave garbage.
