# @albizures/pi-context-inspector

Inspect estimated Pi context usage by source.

This package is currently a scaffold for the planned **Context Inspector** Pi extension.
Implementation is intentionally deferred.

## Planned behavior

The extension will add a command-opened, read-only modal/panel:

```txt
/context-inspector
```

The panel will inspect the current active Pi context and show an estimated attribution by source, including buckets such as:

- system prompt inputs
- tool definitions/snippets
- skills
- context files
- user messages
- assistant messages
- tool results
- compactions or summaries

## Accuracy stance

The panel will use Pi's current context usage as the total and estimate source-level attribution. It is diagnostic, not provider-exact token accounting.

## V1 scope

Planned v1 includes:

- a single scrollable report
- bucket-level context estimates
- largest contributors within large buckets
- read-only recommendations
- names and estimates only, with no raw content snippets

Planned v1 excludes:

- exact tokenization
- provider payload inspection
- actions such as compaction or tool toggling
- persistent widgets or footer UI
- content snippets
