# Harness

Harness is a collection of small Pi packages and agent workflow tools maintained in one pnpm workspace.

## What's included

- [`@albizures/awf`](./packages/awf/README.md) — Agent Workflow runtime and CLI for bundled Spec, Wayfinder, Task, and Grilling workflows.
- [`@albizures/pi-context-inspector`](./packages/pi-context-inspector/README.md) — Pi command for inspecting estimated active context usage by source.
- [`@albizures/pi-exit-command`](./packages/pi-exit-command/README.md) — Pi command that adds `/exit` as a quit alias.
- [`@albizures/pi-footer-status`](./packages/pi-footer-status/README.md) — Pi footer replacement with a dedicated context fill bar.
- [`@albizures/pi-suggested-replies`](./packages/pi-suggested-replies/README.md) — Pi extension that lets agents offer suggested replies for quick insertion.

## Installing packages

Install the Pi extension packages with Pi:

```sh
pi install npm:@albizures/pi-context-inspector
pi install npm:@albizures/pi-exit-command
pi install npm:@albizures/pi-footer-status
pi install npm:@albizures/pi-suggested-replies
```

See [`packages/awf/README.md`](./packages/awf/README.md) for AWF CLI usage and workflow configuration.

## Development

Install dependencies:

```sh
pnpm install
```

Run common checks:

```sh
pnpm check
pnpm typecheck
pnpm test
```

Run Pi with the project-local development shims:

```sh
pnpm dev:pi
```

See [`.pi/README.md`](./.pi/README.md) for the local Pi smoke-testing setup.

## Releasing

Releases use Changesets; see [`docs/release.md`](./docs/release.md) for the repository release process.
