# Pi Context Inspector

Pi Context Inspector is the Harness package that displays an estimated breakdown of Pi context usage.

## Language

**Context attribution estimate**:
An approximate breakdown of the active Pi session's context usage by source, such as system prompt inputs, skills, context files, conversation messages, and tool results. It is diagnostic rather than provider-exact accounting.
_Avoid_: exact token accounting, billing attribution

**Context Inspector**:
A Pi extension that displays a command-opened, read-only context attribution estimate for the current active Pi context.
_Avoid_: context analyzer, context accounting

**Active context snapshot**:
A point-in-time view of the current active Pi context, even if Pi is still streaming or running tools. It may change after the current turn settles.
_Avoid_: settled context report, final context report

**Context bucket**:
A user-facing source category in a context attribution estimate, such as Tool definitions, Context files, or Tool results.
_Avoid_: token class, accounting category

**Context contributor**:
A named item within a context bucket that materially contributes to the bucket's estimated size. It is shown by name and estimate only, not by raw content excerpt.
_Avoid_: snippet, sample, payload

**Overlay frame**:
A command-scoped visual border around a modal TUI overlay. It clarifies overlay boundaries without creating persistent UI or adding actions.
_Avoid_: widget, panel, footer, action bar
