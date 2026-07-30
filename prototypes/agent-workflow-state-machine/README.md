# PROTOTYPE — manifest-driven workflow state machine

Question for [Prototype minimal manifest-driven state-machine semantics](https://github.com/albizures/harness/issues/26): can a tiny declarative workflow definition express the current Spec/Ticket/Handoff workflow enough to validate legal transitions, required inputs/outputs, append-only logs, and GitHub-label current-state projection?

Run it from the repo root:

```bash
pnpm prototype:awf-state-machine
```

What to try:

1. Press `p` on the initial Spec to apply a fixture plan. It creates two Tickets and makes the UI Ticket depend on the API Ticket.
2. Select the API Ticket and drive `start → succeed(change) → start(review) → succeed → start(integration-test) → succeed`.
3. Watch the UI Ticket auto-unblock when the API Ticket reaches `done`.
4. Press `x` while implementing to probe the required-output rule: implementation success without a `change` is rejected.
5. Press `h` while integration test is running to create a Handoff and move the Ticket to `need-human`.

Assumption: this is a logic prototype, not a product UI. The TUI is disposable; `workflow-machine.ts` contains the small portable model being tested.
