---
"@albizures/forge": minor
---

Finalize the Effect CLI command surface migration and remove legacy compatibility affordances. Forge now relies on generated Effect CLI help/validation, and unsupported no-op flags such as `--plain`, `--quiet`, and `--verbose` are rejected instead of parsed for compatibility. The `config`, `store`, `project`, `projects`, and `here` command syntax remains the documented operational surface.
