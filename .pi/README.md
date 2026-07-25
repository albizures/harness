# Pi development setup

This directory contains project-local dev shims for smoke-testing Harness Pi packages during development.

Run from the repo root:

```sh
pnpm dev:pi
```

After editing package extension code, use `/reload` inside Pi.

The shims in `.pi/extensions/` load the package source extensions directly from `packages/*/extensions/`.
