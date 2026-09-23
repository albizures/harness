---
name: wayfinder
description: Chart or work a Forge Wayfinder map with Grilling and Task children, resolving at most one non-research child per session.
disable-model-invocation: true
---

A loose idea has arrived, too big for one agent session, and wrapped in fog: the way from here to the **destination** is not visible yet. Wayfinding finds the way rather than charging at the destination. This skill charts the route by creating a Forge **Wayfinder** map and Forge child records for the specifiable frontier.

Before creating or operating the map, use the /forge skill as the workflow reference for current command, scope, relationship, readiness, lifecycle, and comment rules.

## Plan, don't do

Wayfinder is **planning** by default. Children resolve decisions, gather facts, or do small prerequisite tasks that unblock decisions. The map is done when the way to the destination is clear. If the work is now specifiable implementation work, hand it off to a Spec/Tasks flow rather than doing the build inside the map.

## Refer by name

Every map and child has a title. In human-facing narration and map notes, refer to children by linked title rather than bare ids. Ids/URLs can ride inside the link.

## The map

Create one Forge Wayfinder record as the canonical map. Prefer `forge new wayfinder --title <title> --body -` or `--body-file <markdown-file>` for the Markdown body.

Recommended map body:

```markdown
## Destination

<what reaching the end of this map looks like>

## Notes

<domain; skills every session should consult; standing preferences>

## Decisions so far

- [<closed child title>](link): <one-line gist>

## Not yet specified

<in-scope fog that cannot be ticketed yet>

## Out of scope

<work ruled outside this destination>
```

The map is an index, not duplicated storage. Detailed answers live in child comments/history; the map keeps a gist and link.

## Child records

Create Forge children under the Wayfinder using `--parent` and dependency fields from the Forge reference:

- **Grilling child**: collaborative HITL decision, created with `forge new grilling`.
- **Research Task child**: AFK reading/investigation, created with `forge new task --kind research`.
- **Prototype Task child**: cheap artifact to react to, created with `forge new task --kind prototype`.
- **Task child**: prerequisite work that unblocks a decision, created with `forge new task`.

Use `--description -` or `--description-file` for long child descriptions. Preserve blocking edges with repeatable `--depends-on` or `forge deps add`.

## Fog of war

Chart only what you can state sharply now. Beyond live children is fog: likely future questions that cannot yet be phrased precisely.

- Create a child when the question/work is already sharp, even if blocked.
- Keep it in **Not yet specified** when it is in scope but still too foggy to ticket.
- Put ruled-out work in **Out of scope**, not fog.

When a child resolution makes fog specifiable, create the new child records, wire approved dependencies, and record the map change as a Forge comment. Use `forge edit` only when the canonical body must be updated.

## Invocation

Two modes. Either way, never resolve more than one non-research child per session. Research children may be dispatched in parallel when they are independent.

### Chart the map

User invokes with a loose destination.

1. **Name the destination.** Call the `grilling` and `domain-modeling` skills to pin down what this map is finding its way to. The destination fixes scope.
2. **Map the frontier.** Grill breadth-first across the space to surface open decisions, prerequisite research/prototypes/tasks, and fog. If there is no fog and the route fits one session, do not create a map; ask how the user wants to proceed.
3. **Confirm Forge scope.** Run `forge here` when the map is project-scoped. If scope is ambiguous, ask the human before creating records.
4. **Create the Wayfinder map** with `forge new wayfinder`, including Destination, Notes, empty Decisions-so-far, Not yet specified, and Out of scope sections.
5. **Create the specifiable children** with Forge child commands and `--parent <wayfinder-id>`.
6. **Wire dependencies** with `--depends-on` or `forge deps add`. Create blockers before dependents when ids are needed.
7. **Start research in parallel** where appropriate. For each research Task, have a subagent call the `research` skill, then record the outcome with `forge comment` and `forge done <task> --resolution completed`.
8. Stop. Charting creates the map and frontier; it does not resolve a HITL child in the same session.

### Work through the map

User invokes with an existing Forge Wayfinder id/URL. A child is optional; without one, choose an executable Task child from Forge readiness. Grilling children are HITL support flows selected by explicit user direction or map context.

1. Load the map with `forge show <wayfinder>` and `forge history <wayfinder>`. Orient on Destination, Notes, Decisions-so-far, Not yet specified, and Out of scope.
2. Choose the child. If the user named one, inspect it. Otherwise use `forge ready` as the executable frontier; use `--include-hitl` only when intentionally selecting Grilling.
3. Claim/start with `forge start <child>`.
4. Resolve the child. For Grilling, call `grilling` and `domain-modeling` and wait for the human. For research, call `research`. For prototype, call `prototype`. For Tasks, do only the prerequisite work described.
5. Record the outcome with `forge comment <child> --message-file <file>` or `--message -`, then `forge done <child> --resolution <slug>`.
6. When the child outcome changes the map, add a Forge comment to the Wayfinder with the linked gist, graduated fog, newly specifiable children, or out-of-scope boundary. Use `forge edit` only when the map body must become the canonical updated index.
7. Stop after this one non-research child. Other sessions may be working the same map concurrently, so reload Forge state before future writes.

## Boundaries

- Forge is authoritative for relationships, readiness, lifecycle state, comments, and history.
- Preserve destination, notes, decisions-so-far, fog, out-of-scope, frontier, and one-ticket-per-session semantics.
