---
name: to-spec
description: "Turn the current conversation into exactly one AWF agent-workflow Spec: no interview, no child Tasks, just synthesis and publication."
disable-model-invocation: true
---

# To Spec

This skill takes the current conversation context and codebase understanding and publishes **exactly one** AWF `agent-workflow` Spec. Do not interview the user; synthesize what you already know.

Before publishing, use the /agent-workflow skill as the Agent Workflow reference for current command/input shapes and use only public AWF CLI/config behavior.

## Process

1. Explore the repo to understand the current state of the codebase, if you have not already. Use the project's domain glossary vocabulary, and respect ADRs in the area you are touching.

2. Synthesize the current conversation into the spec template semantics from `./spec-template.md`. Include acceptance criteria, relevant constraints, and testing seams when they are already clear from context. Do not pause only to confirm seams; this skill is synthesis, not an interview.

3. Render the Spec title and body from the template. Keep the body as Markdown; do not wrap it in an intermediate `.scratch` JSON payload for ordinary publication.

4. Publish it with the public AWF Spec creation command from the Agent Workflow reference, preferring ergonomic create flags such as `awf create spec --title <title> --body -` or `--body-file <markdown-file>`. Use `--input <file|->` only if a structured JSON create payload is already warranted.

If the repository has no AWF config and the user asked to publish externally, ask which AWF config to use; otherwise use the implicit filesystem tracker fallback. Do not create a GitHub issue directly.

## Boundaries

- Create exactly one Spec.
- Do not create child Tasks.
- Use only AWF public commands from the Agent Workflow reference.
