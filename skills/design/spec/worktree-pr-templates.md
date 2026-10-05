# Worktree PR Templates

Use this reference only for Specs that have explicitly opted into worktree-backed implementation mode.

Task PR bodies are rendered from Forge record data plus the retained branch plan. Forge remains authoritative for workflow records; PR creation still uses `git` or `gh` from inside the managed worktree.

## Required data sources

Before opening an immutable task PR, collect the PR body inputs from public Forge and local workflow state:

- parent Spec id and title
- Task id, title, and full body/description
- Task dependencies and blocker state
- retained branch-plan metadata: round number, branch kind, task branch name, base ref, PR target ref, prerequisite branch tips, and immutable-after-open state
- verification performed for this Task, including commands run and outcomes
- relevant Forge comments/outcomes from the parent Spec, the Task, dependencies, and prior review/follow-up records when they affect this PR

Do not invent missing workflow facts. If required Forge record data or branch-plan metadata is unavailable, stop before PR creation and ask for the planning/round gate to provide it.

## Body shape

Render a concise Markdown body with these sections:

1. **Forge context**: parent Spec `#<id> <title>` and Task `#<id> <title>`.
2. **Task scope**: the Task body/description summarized or quoted enough for reviewers to understand the promised deliverable.
3. **Dependencies and branch plan**: dependency ids, round, branch name, base ref, PR target, prerequisite tips, and immutable-after-open note.
4. **Implementation summary**: what changed in this task branch.
5. **Verification**: commands/checks run and their result, or an explicit reason if a check was not applicable.
6. **Forge notes**: relevant comments, review outcomes, or follow-up context that affect review.

## Creation boundary

Use the rendered body when opening the PR with `gh pr create --body-file <file>` or an equivalent `gh`/`git`-based flow. Do not add PR rendering, pushing, comment retrieval, or branch orchestration responsibilities to Forge worktree commands.
