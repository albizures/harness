# Repo-wide Vitest and package test folders

Harness uses Vitest as the repository-wide test runner, with tests kept in package-local `test/` folders instead of colocated beside source files. This records a deliberate trade-off: explicit Vitest imports and `expect(...)` assertions make tests consistent across packages, while `test/unit/...` and `test/integration/...` layouts keep source roots clean and make package-scoped test execution predictable.

## Consequences

- Root `pnpm test` runs Vitest for all package tests.
- Packages with tests expose package-level Vitest scripts that point at the shared root config.
- Unit tests live under `test/unit/...`; extension packages preserve the `extensions/` source-root segment under that folder.
- Integration tests live under `test/integration/...` when a package needs them.
