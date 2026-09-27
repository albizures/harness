---
"@albizures/forge": minor
---

Finalize the Effect CLI command surface migration for Forge. The `config`, `store`, `project`, `projects`, `here`, `new`, lifecycle, comment/history, initiative, list/readiness/navigation, relationship, open, and edit command families now run through the Effect CLI command tree while preserving their documented syntax and output contracts.

Forge now relies on generated Effect CLI help/validation, so unsupported no-op compatibility flags such as `--plain`, `--quiet`, and `--verbose` are rejected instead of parsed and ignored. Maintainers should call out this compatibility cleanup when preparing the release notes. Generated help may show shared parser options or repeated parent names on some nested subcommands, but the documented command forms remain the supported contract and handler validation is authoritative for unsupported combinations.
