# GitHub-backed AWF setup

Use this setup only when configuring or validating AWF against GitHub Issues. For normal Spec, Task, Wayfinder, and Grilling operation, return to `SKILL.md`.

## Setup checklist

1. **Create or verify `awf.config.ts`**

   Export the bundled `agent-workflow` manifest and a GitHub tracker from `@albizures/awf`:

   ```ts
   import {
     agentWorkflowManifest,
     createGhCliGitHubTracker,
   } from "@albizures/awf";

   export const manifest = agentWorkflowManifest;
   export const tracker = createGhCliGitHubTracker({
     owner: "<owner>",
     repo: "<repo>",
     manifest: agentWorkflowManifest,
   });
   ```

   For Harness, use `owner: "albizures"` and `repo: "harness"`.

   **Done when:** the repo has an `awf.config.ts` exporting `manifest` and `tracker`.

2. **Verify GitHub CLI authentication**

   ```sh
   gh auth status
   ```

   **Done when:** `gh` is installed, on `PATH`, authenticated for `github.com`, and the authenticated account can operate issues in the target repo.

3. **Verify AWF loads the workflow config**

   ```sh
   awf --config ./awf.config.ts workflow describe
   ```

   If `awf` is not on `PATH` in this workspace, use the package script form from the package working directory:

   ```sh
   pnpm --filter @albizures/awf awf --config ../../awf.config.ts workflow describe
   ```

   **Done when:** AWF prints the loaded workflow and public command surface.

4. **Verify GitHub-backed reads**

   ```sh
   awf --config ./awf.config.ts ready --limit 1
   ```

   Or, with the package script form:

   ```sh
   pnpm --filter @albizures/awf awf --config ../../awf.config.ts ready --limit 1
   ```

   **Done when:** the command returns successfully, even if there are no ready issues.

## Optional write smoke test

Create temporary GitHub issues only with explicit user permission. If permitted, create temporary AWF issues through public AWF commands, verify parent/dependency readiness through AWF, then close or clean up the temporary issues through AWF-supported lifecycle commands. Do not use raw GitHub relationship or dependency endpoints for setup validation.

## Completion criterion

GitHub-backed AWF setup is complete when `awf.config.ts` exists, `gh auth status` succeeds, `awf --config ./awf.config.ts workflow describe` succeeds, and `awf --config ./awf.config.ts ready --limit 1` succeeds.
