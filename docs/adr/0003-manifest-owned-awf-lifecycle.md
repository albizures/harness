# Manifest-owned AWF lifecycle

AWF lifecycle command entry points, human-intervention states such as `need-human` and `waiting-human`, transition events, attempt effects, and workflow-specific log text are owned by Workflow definitions rather than by the generic runtime. The runtime keeps generic manifest execution mechanics, tracker effects, creation support, active/terminal state validation, and hidden command-id invocation, while bundled workflows declare their own commands such as start, fail, recovery, pause/respond, and manual escalation. Runtime diagnostics use state-neutral manual-repair language instead of selecting or naming a workflow-specific human-intervention state.

## Consequences

Workflow definitions require a semantic version at `workflow.version`, and Workflow issues store that version in current workflow fields so incompatible manifest changes can be detected before normal commands run. Logs are plain text with minimal runtime metadata, so terminal outcome history is not runtime-enforced from machine log types. Both bundled workflows move to the manifest-owned lifecycle model together to avoid competing lifecycle boundaries inside AWF.
