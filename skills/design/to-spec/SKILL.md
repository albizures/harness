---
name: to-spec
description: "Turn the current conversation into exactly one AWF agent-workflow Spec: no interview, no child Tasks, just synthesis and publication."
disable-model-invocation: true
---

# To Spec

This skill takes the current conversation context and codebase understanding and publishes **exactly one** AWF `agent-workflow` Spec. Do not interview the user; synthesize what you already know.

Before publishing, use the /agent-workflow skill and use only public AWF CLI/config behavior.

## Process

1. Explore the repo to understand the current state of the codebase, if you have not already. Use the project's domain glossary vocabulary, and respect ADRs in the area you are touching.

2. Synthesize the current conversation into the spec template semantics from `./spec-template.md`. Include acceptance criteria, relevant constraints, and testing seams when they are already clear from context. Do not pause only to confirm seams; this skill is synthesis, not an interview.

3. Create a single AWF Spec input file or stdin payload:

```json
{
  "title": "<spec title>",
  "body": "<rendered spec body>"
}
```

4. Publish it with public AWF CLI behavior:

```sh
awf --config ./awf.config.ts create spec --input ./spec.json
```

If the repository has no AWF config, either use the implicit filesystem tracker fallback or ask which AWF config to use. Do not create a GitHub issue directly.

## Boundaries

- Create exactly one Spec.
- Do not create child Tasks.
- Do not use private AWF runtime APIs, hidden command ids, direct GitHub relationship APIs, or legacy tracker conventions.
