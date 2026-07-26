# @albizures/pi-context-inspector

Inspect estimated Pi context usage by source.

## Command

```txt
/context-inspector
```

The command opens a framed, read-only, point-in-time active context snapshot in TUI mode. It collects immediately from the current Pi session, even when Pi is still streaming or running tools.

## Report contents

The snapshot shows:

- active model identity and context window
- Pi's authoritative total context usage and percentage when known
- an explicit unknown-total state when Pi cannot currently report total tokens
- estimated source attribution by bucket, such as System prompt, Tool definitions, Context files, Skills, user messages, assistant messages, tool results, and compactions/summaries
- capped top contributor lists for materially large buckets
- a framed scrollable TUI overlay with read-only recommendation text for large tool results, context files, and skills

## Accuracy stance

Pi's active context total is the authoritative number shown by the report. Source-level attribution is estimated from prompt inputs and active session entries; it is diagnostic, not provider-exact token accounting.

The report shows contributor names and estimates only, without raw content snippets, and only expands contributor lists for materially large buckets. Tool definitions are estimated from prompt-visible names and snippets, not provider-serialized schemas.

## Privacy boundary

The extension reads Pi's already-active prompt inputs and session context entries to compute estimates. It does not inspect provider request payloads, render raw context snippets in the report, or persist report data.

## Out of scope

This tiny package intentionally does not provide configuration, persistent widgets, Pi footer UI, exact tokenizer integration, provider payload inspection, or user-triggered cleanup/actions from the report.
