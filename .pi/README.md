# Pi development setup

This directory contains project-local dev shims for smoke-testing Harness Pi packages during development.

Run from the repo root:

```sh
pnpm dev:pi
```

After editing package extension code, use `/reload` inside Pi.

The shims in `.pi/extensions/` load package source resources directly from the workspace.

- Package extension shims load source extensions from `packages/*/extensions/`.
- `harness-skills-dev.ts` loads the root `skills/` catalog so Pi in this repo uses the same skill source that `npx skills add albizures/harness` installs from.
