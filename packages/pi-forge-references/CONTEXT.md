# Pi Forge References

Pi Forge References is the Harness package that adds Forge ready record autocomplete to Pi's prompt editor.

## Language

**Forge record reference**:
A stable plain-text reference to a Forge record inserted into the Pi prompt editor, written as `#<record-id>` with no hidden metadata or automatic Forge record expansion.
_Avoid_: task mention, record attachment, Forge task reference

**Ready record autocomplete**:
A Pi prompt-editor autocomplete behavior that suggests ready Forge records from `forge ready --json` when the user types `#` at a token boundary.
_Avoid_: task search, workflow picker, ready task autocomplete
