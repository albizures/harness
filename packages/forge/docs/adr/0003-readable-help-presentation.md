# Separate readable help presentation from the command tree

Forge will keep `@effect/cli`’s command tree authoritative for parsing, validation, and detailed leaf-command help, while using a separate human-facing presentation model for the root command index. The root index will be concise, responsive to terminal width, and avoid the library’s unbounded alignment; displayed repeated command paths may be normalized without changing accepted invocation behavior. This preserves generated command semantics while making `forge --help` a useful navigation surface.

## Consequences

- `forge --help` will list top-level commands, meaningful global options, and direct users to command-specific help.
- Help formatting can change without changing the command surface.
- Width and color capabilities must be injectable for deterministic tests.
- Curated root descriptions and synopses require maintenance when commands change.
