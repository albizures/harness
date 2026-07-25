# @albizures/pi-footer-status

A tiny Pi package that replaces Pi's footer with a default-like custom footer and adds a dedicated Context fill bar.

After installation, the package is always on. It is no longer a no-op scaffold, and it does not add slash commands or configuration.

## Behavior

The custom footer keeps the default-like Pi footer information:

- current working directory, git branch, and session name
- cumulative input/output token usage
- cache read/write stats and cache hit percentage when available
- cumulative cost or subscription-backed usage marker when available
- textual current context percentage on the stats line
- active model, provider when useful, and thinking level for reasoning models

It mirrors these default-like footer lines, then preserves extension status messages after the Context fill bar.

It inserts one additional Context fill bar line before extension statuses:

```text
context ████████░░░░░░░░░░░░ 40.0%/128k
```

The Context fill bar:

- is labeled `context`
- represents Pi's current context usage, not cumulative token totals
- uses Pi's public current context usage API
- is fixed at 20 cells
- uses `█` for filled cells and `░` for empty cells
- rounds the fill amount to the nearest cell
- shows at least one filled cell for any known non-zero usage
- uses the theme accent color normally, warning above 70%, and error above 90%
- keeps empty cells dim
- appends the numeric `percent/contextWindow` suffix on the same line
- does not include `(auto)` on the bar line

When current context usage is unknown, the footer renders a static placeholder instead of guessing:

```text
context ░░░░░░░░░░░░░░░░░░░░ ?/128k
```
