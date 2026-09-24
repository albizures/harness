# Pi Forge References

Pi Forge References is the Harness package that adds Forge ready task autocomplete to Pi's prompt editor.

## Language

**Forge task reference**:
A stable plain-text reference to a Forge task inserted into the Pi prompt editor, written as `#<record-id>` with no hidden metadata or automatic Forge record expansion.
_Avoid_: task mention, record attachment

**Ready task autocomplete**:
A Pi prompt-editor autocomplete behavior that suggests ready Forge tasks from `forge ready --json` when the user types `#` at a token boundary.
_Avoid_: task search, workflow picker
