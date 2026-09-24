# Pi Forge References

Pi package that adds prompt-editor autocomplete for ready Forge task references.

## Behavior

Type `#` at a token boundary in Pi TUI mode to see ready Forge tasks from `forge ready --json`. Suggestions are limited to ready records whose Forge kind is `task`. Choosing an item inserts `#<id>` into the prompt.

The extension leaves Markdown headings alone, delegates non-Forge-reference tokens to Pi's existing autocomplete provider, and returns no suggestions when Forge is unavailable, returns invalid JSON, has no ready tasks, or the autocomplete request is cancelled.

By default it shells out to `forge`; set `FORGE_BIN` to point at a different Forge executable.

## Boundary

`#<id>` is plain text. It is a Forge task reference for humans and workflow tools; it does not inject task content, attach hidden context, or automatically expand the Forge record into the model context.
