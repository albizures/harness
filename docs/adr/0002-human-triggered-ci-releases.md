# Use human-triggered CI releases

Harness publishes independently versioned Pi packages through a human-triggered GitHub Actions workflow, after an automated Changesets release PR has been reviewed and merged to `main`. We chose this over local publishing, fully automatic publish-on-merge, and lockstep repo versions because it keeps release intent explicit, keeps npm credentials in CI, gives maintainers a review point for generated version and changelog changes, and scales to multiple packages without forcing unrelated packages to share versions.

## Consequences

Publishing requires two human gates: merging the release PR and manually triggering the publish workflow. Partial publish failures are fixed forward and retried from `main`; successful package versions are not rolled back or unpublished.
