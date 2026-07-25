# Use a pnpm workspace with Changesets

This repo is a monorepo for independently versioned, publishable npm packages named under `@albizures/*` and located in `packages/*`. We use pnpm workspaces for package linking and Changesets for release planning, version bumps, changelogs, and public npm publishing because this keeps package releases independent without adding heavier monorepo orchestration. The pnpm version is intentionally not pinned yet; the setup starts lightweight and can add stricter package-manager enforcement later if needed.
