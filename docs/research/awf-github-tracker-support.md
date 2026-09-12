# AWF GitHub tracker support research

Ticket: [Verify AWF GitHub tracker public support](https://github.com/albizures/harness/issues/262)

## Question

Is AWF GitHub tracker support stable and documented enough for migrated planning skills to instruct agents to create `agent-workflow` Workflow issues through AWF against GitHub, or should the migration plan target the filesystem tracker until GitHub support is made public/documented?

## Findings

### Supported configuration shape

AWF's CLI loads `awf.config.ts` automatically from the current working directory, or an explicit path via `awf --config ./awf.config.ts ...`. The config binding accepts an exported `manifest`, `tracker`, `commandHandlers`, and optional `lifecycleHandlers`; if no tracker is exported, AWF defaults to a filesystem tracker at `.awf/tracker` under the current working directory. Source: `packages/awf/src/cli/config.ts`; `packages/awf/README.md`.

The public root module exports GitHub tracker factories and types: `createGhCliGitHubTracker`, `createGitHubTracker`, `validateGitHubTrackerCapabilities`, `GitHubTrackerApi`, `GitHubTrackerCapabilities`, and `GitHubTrackerIssue`. Source: `packages/awf/src/index.ts`; `packages/awf/dist/index.d.ts`.

The package export map exposes only the root, filesystem tracker, and bundled `agent-workflow` subpath. Because the GitHub tracker is exported from the public root, a config should import it from `@albizures/awf`, not from an unexported deep path. Source: `packages/awf/package.json`; `packages/awf/src/index.ts`.

A GitHub-backed config shape is therefore:

```ts
import {
  agentWorkflowManifest,
  createGhCliGitHubTracker,
} from "@albizures/awf";

export { agentWorkflowManifest as manifest } from "@albizures/awf";

export const tracker = createGhCliGitHubTracker({
  owner: "albizures",
  repo: "harness",
  manifest: agentWorkflowManifest,
});
```

The lower-level `createGitHubTracker({ api, manifest })` exists for tests/custom adapters, but normal migrated skills should prefer the `gh`-CLI-backed factory. Source: `packages/awf/src/adapters/trackers/github/index.ts`.

### Command examples

With that config in place, migrated skills can use the bundled `agent-workflow` public commands:

```sh
awf --config ./awf.config.ts create wayfinder --input ./wayfinder.json
awf --config ./awf.config.ts create spec --input ./spec.json
awf --config ./awf.config.ts create task --input ./task.json
awf --config ./awf.config.ts create grilling --input ./grilling.json
awf --config ./awf.config.ts ready
awf --config ./awf.config.ts task start <issue>
awf --config ./awf.config.ts task fail <issue>
awf --config ./awf.config.ts task recover <issue>
awf --config ./awf.config.ts task escalate <issue>
awf --config ./awf.config.ts get <issue>
awf --config ./awf.config.ts logs <issue>
```

The documented create inputs support Wayfinder/Spec as `{ title, body|content, parent? }`, Task as `{ spec? | parent?, title, description, profile, subkind?, dependsOn?, generatedBy? }`, and Grilling as `{ title, description, parent? }`. Source: `packages/awf/src/workflows/agent-workflow/manifest.ts`; `packages/awf/README.md`; `packages/awf/test/unit/workflows/agent-workflow/workflow.test.ts`.

### GitHub projection behavior

The GitHub tracker stores workflow state in reserved labels shaped like `awf:agent-workflow:kind:task`, `awf:agent-workflow:state:ready`, and `awf:agent-workflow:action:work`. Durable workflow metadata such as Task `subkind` is stored in a singleton AWF machine comment, not as a GitHub kind label. Logs are additional strict machine comments. Source: `packages/awf/src/adapters/trackers/github/helpers.ts`; `packages/awf/test/unit/trackers/github/tracker.test.ts`.

The GitHub tracker uses native GitHub sub-issues for parent/child relationships and native GitHub issue dependencies for dependency ordering. The `gh` implementation posts to `/issues/<parent>/sub_issues` with the child's database id and to `/issues/<issue>/dependencies/blocked_by` with the blocker's database id. Source: `packages/awf/src/adapters/trackers/github/gh-cli.ts`; `docs/agents/issue-tracker.md`.

The tracker validates that both native sub-issues and native dependencies are available before creating workflow issues or adding relationships, and throws a reconciliation/projection error if those capabilities are reported missing. Source: `packages/awf/src/adapters/trackers/github/helpers.ts`; `packages/awf/src/adapters/trackers/github/tracker.ts`; `packages/awf/test/unit/trackers/github/tracker.test.ts`.

In this repository, the current Wayfinder map already uses GitHub sub-issues and native dependency summaries successfully: `gh api repos/albizures/harness/issues/261/sub_issues` returned open child issues with `issue_dependencies_summary.blocked_by` values. Source: local `gh api` command run during this ticket.

### Public API / documentation status

The accepted AWF compatibility boundary includes tracker adapters as part of the supported `agent-workflow` issue model and CLI product. Source: `packages/awf/docs/adr/0003-agent-workflow-compatibility-boundary.md`; `packages/awf/README.md`.

However, the README currently documents filesystem configuration explicitly and does not include a GitHub tracker configuration example. It also says projects can configure a tracker, but the only concrete tracker import example is `createFileSystemTracker`. Source: `packages/awf/README.md`.

The GitHub tracker has focused unit coverage and a skipped opt-in real-GitHub smoke test. It is not included in the shared tracker-conformance integration family, which currently covers only in-memory and filesystem trackers. Source: `packages/awf/test/unit/trackers/github/tracker.test.ts`; `packages/awf/test/integration/tracker-conformance.test.ts`.

The targeted GitHub/public API checks pass locally: `pnpm --filter @albizures/awf test:vitest test/unit/trackers/github/tracker.test.ts test/unit/public-api.test.ts` passed with 18 tests and 1 skipped smoke test. A broader run that also included `test/integration/cli.test.ts` failed on an unrelated command-description expectation mismatch around `spec complete` usage, not on GitHub tracker behavior. Source: local test commands run during this ticket.

## Answer

AWF GitHub tracker support is stable enough for the migration plan to target GitHub-backed Workflow issue creation through AWF, provided the migrated skills import the GitHub tracker factory from the public root module and include a documented project config. The plan does **not** need to target the filesystem tracker as the default migration destination.

The main gap is documentation/configuration, not capability: add or plan a docs/config task to show the GitHub `awf.config.ts` shape and state the repository prerequisites (`gh` authenticated; GitHub native sub-issues and dependencies available). A smaller verification gap remains because real-GitHub smoke coverage is opt-in and skipped by default, and GitHub is not part of the conformance integration family.

## Recommended planning consequence

Proceed with [Decide AWF config and tracker migration path](https://github.com/albizures/harness/issues/263) assuming GitHub is the target tracker, while deciding where to land the explicit `awf.config.ts` and README/agent instructions. Treat filesystem as a fallback only for repositories without GitHub native sub-issues/dependencies or without authenticated `gh` access.
