# Manifest-owned AWF lifecycle

AWF lifecycle command entry points, human-intervention states, transition events, run effects, and workflow-specific log text are owned by Workflow definitions rather than by the generic runtime. The runtime keeps generic manifest execution mechanics, tracker effects, creation support, active/terminal state validation, and hidden command-id invocation, while bundled workflows declare their own commands such as start, fail, recovery, and manual escalation.

## Consequences

Workflow definitions require a semantic version at `workflow.version`, and Workflow issues store that version in current workflow fields so incompatible manifest changes can be detected before normal commands run. Logs are plain text with minimal runtime metadata, so terminal outcome history is not runtime-enforced from machine log types. Both bundled workflows move to the manifest-owned lifecycle model together to avoid competing lifecycle boundaries inside AWF.
