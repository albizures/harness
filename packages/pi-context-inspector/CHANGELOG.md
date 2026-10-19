# @albizures/pi-context-inspector

## 0.2.1

### Patch Changes

- f2a9e17: Declare Pi's terminal UI package as a host-provided peer dependency so Pi loads the extension with its shared runtime module.

## 0.2.0

### Minor Changes

- 885e84c: Add the initial Context Inspector package scaffold.
- 885e84c: Implement the `/context-inspector` command with a framed, read-only active context snapshot, TUI-highlighted estimate values, and estimated source attribution report.

### Patch Changes

- 885e84c: Normalize Context Inspector estimates against Pi's authoritative context total when available, with bucket shares and sorted nonzero source attribution.
