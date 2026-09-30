# Work the next Spec Task

`spec work <spec>` works exactly one child Task of the named Forge Spec. It is not a global task picker.

1. **Preflight summary support.** Verify that `forge summary <spec>` is available. If unavailable or unsupported, stop and report the prerequisite; do not fall back to `forge show`, `forge next`, or ad-hoc parsing.
2. **Load the parent summary.** Run `forge summary <spec> --json`. Use its structured parent, direct-child, dependency, state, resolution, and latest-explicit-comment facts. Confirm the named record is a Spec. Select only among its direct child Tasks.
3. **Choose one executable child.** Require child Tasks, respect dependencies and lifecycle state, and consider Grilling children only when explicitly requested or when no executable Task can proceed. If no child Tasks exist, explain that it is a tiny Spec and, only after explicit confirmation, suggest or create one ordinary child Task.
4. **Start in order.** Start the parent with `forge start <spec>` if needed, then start the selected child with `forge start <task>`. Resolve at most one child in the session.
5. **Delegate by kind.** Route research Tasks to `/research`, prototype Tasks to `/prototype`, review Tasks to `/review-implementation`, and ordinary Tasks to implementation work, using `/tdd` where appropriate. Do not implement directly from the parent Spec.
6. **Verify implementation work.** Run relevant local tests/checks before completing an implementation Task. Leave full integration and release verification to their dedicated Tasks. Record the outcome with a Forge comment, then complete only the child when its deliverables are met.

The mode may comment on or edit the parent only within the Task's agreed boundaries. It never auto-completes the parent Spec.
