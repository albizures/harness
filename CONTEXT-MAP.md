# Context Map

Harness uses multiple domain contexts. Keep shared repository vocabulary in the root context, and move terms into a package or skill context when that area clearly owns the concept.

## Contexts

- [Harness](./CONTEXT.md) — shared repo-wide vocabulary for Pi packages, package development, and releases.
- [AWF](./packages/awf/CONTEXT.md) — vocabulary owned by the `@albizures/awf` workflow runtime and CLI package.
- [Pi Context Inspector](./packages/pi-context-inspector/CONTEXT.md) — vocabulary owned by the `@albizures/pi-context-inspector` package.
- [Pi Exit Command](./packages/pi-exit-command/CONTEXT.md) — vocabulary owned by the `@albizures/pi-exit-command` package.
- [Pi Footer Status](./packages/pi-footer-status/CONTEXT.md) — vocabulary owned by the `@albizures/pi-footer-status` package.
- [Pi Suggested Replies](./packages/pi-suggested-replies/CONTEXT.md) — vocabulary owned by the `@albizures/pi-suggested-replies` package.
- [Skills](./skills/CONTEXT.md) — vocabulary owned by the shared skill catalog under `skills/`.

## Ownership rule

Keep terms in the root Harness context when they describe repository-wide conventions, release mechanics, or shared Pi package language. Move terms to a package or skill context when that context is the obvious owner and future changes to the term are expected to happen there.
