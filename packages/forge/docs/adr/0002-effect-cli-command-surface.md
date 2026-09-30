# Effect CLI command surface

Forge will migrate its full command surface to `@effect/cli`: commands, arguments, options, validation, usage, and help will be modeled as an Effect CLI command tree instead of a hand-rolled argv parser. This makes the CLI structure explicit and library-generated, while keeping `runCli(argv, options): Promise<number>` as the stable test and integration seam.

The migration may introduce intentional command-surface breaking changes where `@effect/cli` provides a cleaner shape. Global options become root command options parsed according to `@effect/cli` semantics, generated help replaces hand-authored help text, native `@effect/cli` parse/runtime error output replaces Forge's custom parser style, presentation modes are limited to `human` and `json`, and parsed-but-unused flags such as `--plain`, `--quiet`, and `--verbose` should be removed. Existing JSON output shapes should be preserved unless a specific command has a documented reason to change them.

Handlers should be Effect-native and return values for a shared presenter to render as human or JSON output. Implementation should be split across multiple specs and tasks, with each slice keeping `forge` usable and tests green. Breaking changes must be captured in spec acceptance criteria and reflected in skills, docs, and release notes that reference Forge commands.
