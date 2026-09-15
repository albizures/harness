---
name: wayfinder
description: Chart or work an AWF agent-workflow Wayfinder map with AWF Grilling and Task children, resolving at most one non-research child per session.
disable-model-invocation: true
---


A loose idea has arrived, too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the route by creating an AWF `agent-workflow` **Wayfinder** map and AWF child issues for the specifiable frontier.

The destination varies per effort, and naming it is the first act of charting: it shapes every issue. The map is domain-agnostic: engineering work, course content, whatever fits the shape.

Before creating or operating the map, use the /agent-workflow skill as the Agent Workflow reference for current command/input shapes and use only public AWF CLI/config behavior.

## Plan, don't do

Wayfinder is **planning** by default. Children resolve decisions, gather facts, or do small prerequisite tasks that unblock decisions. The map is done when the way to the destination is clear. If the work is now specifiable implementation work, hand it off to a Spec/Tasks flow rather than doing the build inside the map.

## Refer by name

Every map and child has a title. In human-facing narration and map notes, refer to children by linked title rather than bare ids. Ids/URLs can ride inside the link.

## The AWF map

Create one AWF Wayfinder issue as the canonical map, using the public Wayfinder creation command and current input shape from the Agent Workflow reference.

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

The map is an index, not duplicated storage. Detailed answers live in child outcomes/logs; the map keeps a gist and link.

## Child issues

Create AWF children under the Wayfinder using the parent and dependency input fields defined by the Agent Workflow reference:

- **Grilling child**: collaborative HITL decision.
- **Research Task child**: AFK reading/investigation, routed to the research profile with a research subkind.
- **Prototype Task child**: cheap artifact to react to, routed to the prototype profile with a prototype subkind.
- **Task child**: prerequisite work that unblocks a decision, routed with a clear profile and work subkind.

Use AWF parent/child and dependency inputs only; do not call tracker sub-issue/dependency APIs directly.

## Fog of war

Chart only what you can state sharply now. Beyond live children is fog: likely future questions that cannot yet be phrased precisely.

- Create a child when the question/work is already sharp, even if blocked.
- Keep it in **Not yet specified** when it is in scope but still too foggy to ticket.
- Put ruled-out work in **Out of scope**, not fog.

When a child resolution makes fog specifiable, create the new child issues, wire approved dependencies, and remove the graduated fog from the map body.

## Invocation

Two modes. Either way, never resolve more than one non-research child per session. Research children may be dispatched in parallel when they are independent.

### Chart the map

User invokes with a loose destination.

1. **Name the destination.** Call the Skill tool for `grilling` and `domain-modeling` to pin down what this map is finding its way to. The destination fixes scope.
2. **Map the frontier.** Grill breadth-first across the space to surface open decisions, prerequisite research/prototypes/tasks, and fog. If there is no fog and the route fits one session, do not create a map; ask how the user wants to proceed.
3. **Create the Wayfinder map** with the public AWF Wayfinder creation command from the Agent Workflow reference, including Destination, Notes, empty Decisions-so-far, Not yet specified, and Out of scope sections.
4. **Create the specifiable children** with the public AWF child creation commands and parent input from the Agent Workflow reference.
5. **Wire dependencies** with the AWF dependency inputs from the Agent Workflow reference. If ids were not known yet, create blockers first or create the remaining dependent children after blockers exist.
6. **Start research in parallel** where appropriate. For each research Task, have a subagent call the `research` skill and record the outcome through AWF lifecycle/log behavior.
7. Stop. Charting creates the map and frontier; it does not resolve a HITL child in the same session.

### Work through the map

User invokes with an existing AWF Wayfinder id/URL. A child is optional; without one, choose from AWF readiness.

1. Load the map with the public AWF inspection command from the Agent Workflow reference and orient on Destination, Notes, Decisions-so-far, Not yet specified, and Out of scope.
2. Choose the child. If the user named one, inspect it through AWF. Otherwise use AWF readiness behavior as the source of truth for the frontier; pick one ready, unclaimed child of the map.
3. Claim/start only through public AWF lifecycle commands from the Agent Workflow reference. If the needed Wayfinder or Grilling lifecycle command is not public, stop and ask for the AWF command surface to be upgraded rather than using hidden command ids.
4. Resolve the child. For Grilling, call `grilling` and `domain-modeling` and wait for the human. For research, call `research`. For prototype, call `prototype`. For Tasks, do only the prerequisite work described.
5. Record the outcome through public AWF lifecycle/log commands. Outcomes should be one of:
   - decision: the resolution and one-line gist
   - completed prerequisite: what was done and facts later work needs
   - out-of-scope: the scope boundary and why it is outside the destination
6. Revise the map through AWF-supported map revision/lifecycle behavior: append a linked gist to Decisions-so-far, graduate or clear fog, add newly specifiable children, and record out-of-scope boundaries.
7. Stop after this one non-research child. Other sessions may be working the same map concurrently, so reload AWF state before future writes.

## Boundaries

- AWF is authoritative for relationships, readiness, lifecycle state, and logs.
- Use only AWF public commands from the Agent Workflow reference and keep detailed child outcomes in child logs rather than duplicating decision storage.
- Preserve destination, notes, decisions-so-far, fog, out-of-scope, frontier, and one-ticket-per-session semantics.
