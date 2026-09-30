# Forge

Forge is a personal global workflow CLI package.

## Language

**Global store**: The logical Forge persistence boundary outside project repositories that owns configuration-derived workflow data, registered projects, records, comments, updates, indexes, and write serialization. It is currently filesystem-backed.

**Project registry entry**: A store configuration record for one stable lowercase kebab-case project id, display name, absolute roots, optional remote URL, and optional aliases.

**Project id**: A stable lowercase kebab-case slug matching `[a-z0-9][a-z0-9-]*[a-z0-9]`.

**Command surface**: The public Forge command tree, arguments, options, validation, help, and usage behavior exposed to CLI users.

**Invocation context**: The cwd, environment, stdin/stdout/stderr streams, store override, and presentation mode for one Forge CLI run.

**Root command index**: The concise, navigational help view shown by `forge --help`, listing top-level commands without attempting to document every nested option.

**Leaf-command help**: The detailed help view for a specific command, including its usage, arguments, options, and validation-relevant details.

**Help presentation model**: The human-facing representation of the command surface used for readable help output; it is distinct from the command tree that executes and validates invocations.

**Command synopsis**: A short human-facing summary of how a command is invoked, intentionally less detailed than leaf-command usage.

**Global option**: An option applicable across the Forge command surface, such as output presentation or store and working-directory selection.

**Command group**: A cohesive family of related commands within the Forge command surface, sharing a domain concern and its command behavior.
