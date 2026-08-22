# Unit tests

Use unit tests to lock down behavior at the smallest useful boundary.

## Naming pattern

Prefer behavior-first test names:

- Use `describe("when ...")` to group tests by scenario or state.
- Use `it("should ...")` to state the expected behavior.

Exceptions are allowed when another name is clearer, or when preserving nearby existing style is less disruptive.

## Coverage

When changing behavior:

- Add or update unit tests for the changed behavior.
- Cover the happy path, important edge cases, and failure paths.
- Maintain or improve meaningful coverage; do not reduce coverage for the affected behavior.
- Run the package's coverage command when one is available.

Current package-specific coverage command:

```sh
pnpm --filter @albizures/awf test:coverage
```
