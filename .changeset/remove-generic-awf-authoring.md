---
"@albizures/awf": major
---

Remove unsupported generic workflow-authoring/runtime APIs from the public AWF boundary. AWF is now `agent-workflow`-first: generic manifest authoring, project-defined command surfaces, workflow-module authoring exports, workflow-position reasons, generic source/apply command dimensions, user-facing `awf apply` dispatch, and normal-help `run-command` exposure are no longer public capabilities.
