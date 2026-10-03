---
"@albizures/forge": patch
---

Serialize Forge store mutations with a process-safe write lock to prevent concurrent CLI writers from allocating duplicate record ids or interleaving multi-file store updates. The fix covers record, comment, lifecycle, dependency, initiative, and edit mutations; adds regression coverage for concurrent task/grilling creation; and teaches `forge store doctor` to report duplicate persisted record ids. Operators who suspect an older store hit this race should run `forge store doctor` and inspect the reported conflicting record files.
