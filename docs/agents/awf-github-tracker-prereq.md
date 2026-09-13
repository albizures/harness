# GitHub-backed AWF planning prerequisite

This note records the current target shape for running bundled `agent-workflow` against GitHub Issues while migrating the planning skills. It is a planning prerequisite, not a skill migration.

## Intended AWF config shape

Use the bundled `agent-workflow` manifest and the GitHub tracker exported from `@albizures/awf`:

```ts
import {
  agentWorkflowManifest,
  createGhCliGitHubTracker,
} from "@albizures/awf";

export const manifest = agentWorkflowManifest;
export const tracker = createGhCliGitHubTracker({
  owner: "albizures",
  repo: "harness",
  manifest: agentWorkflowManifest,
});
```

Run AWF with either repo-local `awf.config.ts` discovery or an explicit config. Use `skills/workflow/agent-workflow/SKILL.md` as the Agent Workflow reference for public command shapes and issue input shapes.

## Authentication and permissions

The GitHub tracker uses the `gh` CLI, so the process running AWF must have:

- `gh` installed and on `PATH`.
- `gh auth status` authenticated for `github.com`.
- Repository access to `albizures/harness` with permission to create issues, edit issue labels/bodies/comments, close issues, create sub-issues, and create issue dependency edges.
- GitHub sub-issues and issue dependencies enabled for the repository/account; AWF's GitHub adapter currently assumes these capabilities are available.

The smoke run below used the current authenticated `gh` session for `albizures/harness` and confirmed admin/maintain/push/triage/pull permissions were visible from the API response.

## Native GitHub capability confirmation

Confirmed in this repo via `gh api`:

- Sub-issues endpoint accepts `POST repos/albizures/harness/issues/<parent>/sub_issues -F sub_issue_id=<child database id>`.
- Sub-issues can be read back from `GET repos/albizures/harness/issues/<parent>/sub_issues`.
- Dependencies endpoint accepts `POST repos/albizures/harness/issues/<dependent>/dependencies/blocked_by -F issue_id=<blocker database id>`.
- Dependencies can be read back from `GET repos/albizures/harness/issues/<dependent>/dependencies/blocked_by` and `GET repos/albizures/harness/issues/<blocker>/dependencies/blocking`.

## Smoke run

A temporary GitHub-backed AWF config was created outside the repo and pointed at `albizures/harness`.

Earlier smoke runs reproduced an adapter gap: GitHub accepted native sub-issue writes, but `GET /issues/<child>` did not expose a parent field, so AWF could not verify the child side of the relationship and returned `NEED_RECONCILIATION`. AWF has since been changed to infer missing child-parent projections from parent `sub_issues` lists.

Current verification results:

1. `awf create spec` succeeded, creating a temporary parent issue.
2. `awf create task` with `spec: <parent>` succeeded, and GitHub showed the task as a sub-issue of the parent.
3. A second `awf create task` with `spec: <parent>` and `dependsOn: [<blocker>]` succeeded. The returned AWF issue included `relationships.parent` and `relationships.dependencies`.
4. GitHub native reads confirmed the parent `sub_issues` list included both children, and the dependent issue's `dependencies/blocked_by` endpoint included the blocker.
5. `awf ready` did not list the dependent task while its blocker was open and reported a dependency block for it.
6. After the blocker was completed through AWF, `awf ready` listed the dependent task.
7. The temporary smoke issues were closed and their AWF labels removed after verification.

## Planning consequence

GitHub itself has the required native sub-issue and dependency capabilities in this repo, and the intended config shape is straightforward. The verified AWF GitHub tracker now reads native sub-issues and dependencies back into AWF readiness well enough for the planning-skill migration to proceed against GitHub-backed AWF.
