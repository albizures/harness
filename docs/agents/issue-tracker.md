# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for direct GitHub issue operations that are **not** managed by AWF planning workflows.

AWF-backed planning skills (`to-spec`, `to-tickets`, `wayfinder`, and related Grilling/Task flows) must use the public AWF `agent-workflow` CLI instead of direct tracker creation, labels, sub-issue APIs, or dependency APIs. See `skills/workflow/agent-workflow/SKILL.md` and `docs/agents/awf-github-tracker-prereq.md`.

## Direct GitHub conventions for non-AWF work

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a non-AWF skill says "publish to the issue tracker"

Create a GitHub issue with `gh issue create` unless that skill explicitly opts into AWF.

## When a non-AWF skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` unless the ticket is an AWF Workflow issue, in which case use AWF (`awf get <id>`, `awf logs <id>`) for workflow state/history.

## AWF-backed planning workflows

For AWF Specs, Tasks, Wayfinders, and Grilling issues:

- Create issues with `awf create spec`, `awf create task`, `awf create wayfinder`, or `awf create grilling`.
- Attach parent/child relationships with AWF create input (`spec` or `parent`).
- Preserve blocking edges with AWF Task `dependsOn` input.
- Query executable frontier work with `awf ready`.
- Inspect state/history with `awf get <id>` and `awf logs <id>`.
- Run lifecycle steps only through public commands shown by `awf --help` or by a `Usage:` line in `awf workflow describe`.
