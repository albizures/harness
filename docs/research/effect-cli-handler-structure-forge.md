# Idiomatic `@effect/cli` handler structure for Forge

Date: 2026-09-27

## Sources checked

- Installed package: `@effect/cli@0.77.2` from `packages/forge` dependency tree (`pnpm list @effect/cli --filter @albizures/forge`).
- API types: `node_modules/.../@effect/cli/dist/dts/Command.d.ts`.
- Implementation: `node_modules/.../@effect/cli/src/internal/command.ts`.
- First-party README/tutorial: `node_modules/.../@effect/cli/README.md`.
- Current Forge implementation: `packages/forge/src/cli.ts` and `packages/forge/test/unit/cli.test.ts`.

## Findings

### Handler attachment in the installed version

`Command.make` in `@effect/cli@0.77.2` supports three forms: `Command.make(name)`, `Command.make(name, config)`, and `Command.make(name, config, handler)`. The handler receives the parsed config and returns `Effect<void, E, R>`; this is visible in the installed declaration for `make` and the `Command` interface's `handler` field in `dist/dts/Command.d.ts`.

Handlers can also be attached or replaced later with `Command.withHandler(handler)`. The installed implementation sets the command's `handler` and resets `transform` to identity. `Command.transformHandler` wraps a command's handler effect with access to the parsed config; `provide`, `provideEffect`, `provideEffectDiscard`, and `provideSync` are implemented in terms of this transform seam. Source: `src/internal/command.ts`.

`Command.run(command, { name, version })(argv)` is the command-level runner and returns an Effect. The README examples run that Effect through `Effect.provide(NodeContext.layer)` and `NodeRuntime.runMain`. The declarations also expose `CliApp.run`, which Forge currently uses directly around `forgeRootCommand.descriptor`, but the more idiomatic command-owned path is `Command.run(forgeRootCommand, ...)` once handlers live on commands.

### Parent/root options and subcommand options

Root/global options and subcommand options can be composed without reconstructing a legacy `Parsed` object.

The README's "Accessing Parent Arguments in Subcommands" section documents that `Command` is an Effect; a subcommand handler can `Effect.flatMap(parentCommand, parentConfig => ...)` to access parsed parent config. The installed `withSubcommands` implementation provides the parent command config as a service under `self.tag` when it runs a subcommand handler. That means Forge subcommands can read `{ json, store, cwd }` from the root `forge` command by depending on the root command Effect instead of by flattening native config into `Parsed`.

The combined parsed type for `withSubcommands` also includes `subcommand: Option<...>` in the parent parsed config, which is why parent command handlers can still dispatch or print top-level help when no subcommand is selected. Source: `dist/dts/Command.d.ts` and `src/internal/command.ts`.

One parser rule matters for compatibility: the first-party README FAQ says options/args for a command must appear before any subcommands, and options must appear before positionals. Forge already exposes global `--store`, `--cwd`, and root `--json` before subcommands; many leaf commands also define their own `--json` so `forge show 1 --json` remains valid.

### Current Forge shape

Forge already declares a complete `@effect/cli` command tree in `packages/forge/src/cli.ts`, but it does not attach action handlers to most `Command.make` calls. Instead it passes `forgeRootCommand.descriptor` into `CliApp.make`, receives a native parsed config in `CliApp.run`, converts it into a legacy `Parsed` shape with `parsedFromNativeConfig`, and dispatches through `cliCommandRegistrations` / `operationalCliActions`.

This dispatch table is the migration target: the command descriptors are useful, but command behavior still lives outside the commands. Current tests call the Promise `runCli` helper and assert stdout/stderr/exit codes. That helper also owns injected `cwd`, `env`, `stdin`, `stdout`, and `stderr`, so a replacement test seam must preserve those injectable edges.

## Recommended migration slice plan

1. **Introduce an Effect-native invocation context service.** Keep the external binary behavior the same, but create a `CliInvocationContext` service/layer populated from `CliOptions` and process defaults. This lets command handlers read injected stdout/stderr/stdin/env/cwd/store defaults without needing a synthetic `Parsed` object.

2. **Migrate one small command family to command-owned handlers.** Start with low-risk `store path` / `store doctor` or `config get` / `config set`. Attach handlers with the third `Command.make(..., handler)` argument or `.pipe(Command.withHandler(...))`. In subcommands, read root config with `Effect.flatMap(forgeRootCommand, root => ...)` or provide a small helper that combines the root command config with the invocation context service.

3. **Keep a temporary legacy adapter only for unmigrated commands.** During incremental migration, root command or group command handlers may still delegate to `executeParsedCommandEffect` for commands that have not moved. Do not grow the legacy `Parsed` shape; treat it as compatibility scaffolding to delete.

4. **Switch the runner from descriptor-owned `CliApp.run` toward `Command.run`.** Once the root command has meaningful handlers, prefer `Command.run(forgeRootCommand, { name: "forge", version: "0.0.0" })(["node", "forge", ...argv])`, then provide Node/platform and the invocation context layer. This aligns Forge with the first-party examples and keeps command parsing plus handler selection in one Effect pipeline.

5. **Remove `cliCommandRegistrations`, `operationalCliActions`, `parsedFromNativeConfig`, and command-specific positional reconstruction after all families migrate.** Help text should continue to come from the command tree (`Command.getHelp` or built-in `--help`), not from bespoke usage strings except for domain-level validation errors.

## Recommended test shape after the refactor

- Replace production Promise wrappers with an exported Effect seam such as `runCliEffect(argv, options): Effect<number, never, RuntimeDeps>` or `makeCliEffect(argv): Effect<void, ...>`. Keep `runCliMain` only as the binary edge that runs the Effect and sets process exit code.
- Unit tests should run the Effect with test/in-memory stdout/stderr/stdin and temporary store/home/cwd context, then assert code/output exactly as today. This preserves the current `capture()` style while avoiding a production `runCli` Promise API.
- Add focused tests for parent/root option access in migrated handlers: e.g. `--store <tmp> store path`, `--cwd/-C <path> here`, and leaf `--json` after the subcommand. These prove the replacement uses `@effect/cli` parent config/services rather than `parsedFromNativeConfig`.
- Keep smoke tests against the packaged binary for user-visible compatibility and parser ordering behavior.

## Bottom line

The installed `@effect/cli` version supports the desired end state: command-owned handlers, parent-config access through the command Effect, subcommand composition through `withSubcommands`, and an Effect runner via `Command.run`. Forge should migrate incrementally by command family, but the target should remove the legacy parsed/dispatch table rather than recreating it under a different name.
