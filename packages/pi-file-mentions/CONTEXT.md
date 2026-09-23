# Pi File Mentions

Pi File Mentions is the Harness package that improves Pi's `@` file mention autocomplete with editor-like folder and file suggestions.

## Language

**File Mentions**:
A Pi package feature that augments `@` autocomplete by suggesting matching folders and useful files under those matched folders for insertion into the prompt editor.
_Avoid_: path search, file search, smart autocomplete

**File Mention Index**:
A session-scoped cache of normalized project file and directory paths used to make File Mentions responsive while the user types.
_Avoid_: search cache, file database

**Refresh File Mentions**:
The command action that rebuilds the current working directory's File Mention Index during a Pi session.
_Avoid_: rescan, reindex command
