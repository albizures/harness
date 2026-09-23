# Forge

Forge is a personal global workflow CLI package.

## Language

**Global store**: The logical Forge persistence boundary outside project repositories that owns configuration-derived workflow data, registered projects, records, comments, updates, indexes, and write serialization. It is currently filesystem-backed.

**Project registry entry**: A store configuration record for one stable lowercase kebab-case project id, display name, absolute roots, optional remote URL, and optional aliases.

**Project id**: A stable lowercase kebab-case slug matching `[a-z0-9][a-z0-9-]*[a-z0-9]`.
