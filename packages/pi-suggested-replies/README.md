# @albizures/pi-suggested-replies

Pi package that lets an agent offer ephemeral suggested replies for quick insertion into the normal prompt editor.

## What it does

The package registers a Pi extension with:

- `suggest_replies` tool: displays suggested replies and returns immediately.
- `/suggested-replies-demo`: shows a small demo set of suggestions.
- `/suggested-reply <number>`: inserts a displayed suggestion by number.
- `F7` / `F8`: cycles suggestions and replaces the editor text with the selected suggestion.

Suggested replies are not required answers. The user can ignore them and type normally.

## Agent tool

The agent-facing tool is `suggest_replies`.

Input:

```ts
{
  suggestions: Array<{
    label: string;
  }>;
}
```

Rules:

- Provide 1–9 suggestions.
- `label` is displayed in the widget and inserted into the prompt editor.
- A new tool call replaces any existing suggestions.
- The tool returns immediately with: `Suggested replies displayed. The user may insert one into the prompt editor or type normally.`

## User interaction

Suggestions render in a widget above the editor:

```text
Suggested replies
  1. Yes, agree
  2. Show alternatives

F7/F8 cycle • /suggested-reply <n> insert • Enter submit
```

Selecting a suggestion replaces the whole editor text. The user can edit that text before pressing Enter. Suggestions stay visible until the user submits a normal prompt, a new suggestion set replaces them, or the session/reload lifecycle clears them.

## State model

Suggested replies are ephemeral UI state:

- They are not restored on resume/reload/new/fork.
- They clear when the user submits normal input.
- They clear on session shutdown.
- They are replaced by the latest `suggest_replies` tool call.

## Local development

This repository includes a project-local dev shim at `.pi/extensions/pi-suggested-replies.ts`.

After changing the extension, run:

```bash
pi /reload
```

Or run tests from the repository root:

```bash
npm test -- packages/pi-suggested-replies/extensions/index.test.ts
```
