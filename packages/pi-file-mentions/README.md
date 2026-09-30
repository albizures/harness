# @albizures/pi-file-mentions

Pi package that improves Pi's `@` file mention autocomplete with editor-like folder and file suggestions.

## User behavior

After installation, File Mentions augments Pi's native `@` autocomplete:

- Type a non-empty `@` query such as `@src` or `@packages/pi` to see matching project folders.
- Matching folders appear before useful files beneath each matched folder.
- If File Mentions has no smart result, Pi's native autocomplete handles the query.
- A bare `@` is left to Pi's native autocomplete.
- Relative queries insert project-relative file mention paths.
- Absolute queries insert absolute file mention paths.
- Paths with spaces, or queries already typed with quotes, insert Pi-compatible quoted syntax such as `@"some path/file.txt"`.

File Mentions also registers `/file-mentions-refresh` to rebuild the current working directory's File Mention Index during a Pi session. The command does not accept path arguments in v1.

## How it works

The extension wraps Pi's current autocomplete provider instead of replacing it. On the first non-empty smart `@` query for a working directory, it lazily builds a session-scoped File Mention Index of normalized project paths and reuses that index for later queries.

Indexing prefers `fd`, falls back to `git ls-files`, and finally uses a bounded Node filesystem walk that skips common heavy directories. Matching uses fuzzy full-path scoring with basename-first priority, expands each matched folder to shallow recursive files, and enforces internal caps so typing stays responsive.

## Local development

This repository includes a project-local dev shim at `.pi/extensions/pi-file-mentions.ts`.

After changing the extension, run:

```bash
pi /reload
```

Or run tests from the repository root:

```bash
pnpm test -- packages/pi-file-mentions/extensions/*.test.ts
```
