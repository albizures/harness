---
name: to-spec
description: "Turn the current conversation into exactly one Forge Spec: no interview, no child Tasks, just synthesis and publication."
disable-model-invocation: true
---

# To Spec

This skill takes the current conversation context and codebase understanding and publishes **exactly one** Forge Spec. Do not interview the user; synthesize what you already know.

Before publishing, use the /forge skill as the workflow reference for current command, scope, relationship, readiness, lifecycle, and comment rules.

## Process

1. Explore the repo to understand the current state of the codebase, if you have not already. Use the project's domain glossary vocabulary, and respect ADRs in the area you are touching.

2. Synthesize the current conversation into the spec template semantics from `./spec-template.md`. Include acceptance criteria, relevant constraints, and testing seams when they are already clear from context. Do not pause only to confirm seams; this skill is synthesis, not an interview.

3. Render the Spec title and body from the template. Keep the body as Markdown.

4. Confirm Forge project scope with `forge here`. If Forge cannot infer the project and the Spec is project-scoped, ask the human to register or select the project before publishing.

5. Publish it with `forge new spec --title <title> --body -` or `--body-file <markdown-file>`. Include `--project <id>`, `--initiative <id>`, or `--generated-by <id>` when the current context warrants it.

Do not create a GitHub issue directly.

## Boundaries

- Create exactly one Spec.
- Do not create child Tasks.
- Use only Forge public commands from the Forge reference.
