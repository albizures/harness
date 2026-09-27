# Pi Forge References

Pi package that adds prompt-editor autocomplete for ready Forge record references.

## Behavior

Type `#` at a token boundary in Pi TUI mode to see ready Forge records from `forge ready --json`. Suggestions include every ready record returned by Forge. Choosing an item inserts `#<id>` into the prompt.

The extension leaves Markdown headings alone, delegates non-Forge-reference tokens to Pi's existing autocomplete provider, and returns no suggestions when Forge is unavailable, returns invalid JSON, has no ready records, or the autocomplete request is cancelled.

By default it shells out to `forge`; set `FORGE_BIN` to point at a different Forge executable.

## Boundary

`#<id>` is plain text. It is a Forge record reference for humans and workflow tools; it does not inject record content, attach hidden context, or automatically expand the Forge record into the model context.
