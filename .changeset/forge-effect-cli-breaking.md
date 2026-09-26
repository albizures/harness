---
"@albizures/forge": minor
---

Finalize the Effect CLI command surface migration for Forge operational commands. The `config`, `store`, `project`, `projects`, and `here` command families now run through the Effect CLI command tree while preserving their documented syntax and output contracts.

Forge now relies on generated Effect CLI help/validation, so unsupported no-op compatibility flags such as `--plain`, `--quiet`, and `--verbose` are rejected instead of parsed and ignored. Maintainers should call out this compatibility cleanup when preparing the release notes.
