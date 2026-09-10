# AWF

AWF is the Harness package that provides a workflow runtime and CLI for agent workflow issues.

## Language

**Workflow runtime**:
A generic engine that evaluates workflow entity state, legal transitions, commands, relationships, logs, and tracker mutations from a workflow definition. It owns manifest execution mechanics, but not built-in lifecycle commands such as start, succeed, fail, pause, resume, or escalation.
_Avoid_: agent workflow CLI core, issue workflow script, built-in workflow policy

**Workflow definition**:
A project- or package-provided declarative definition of entity kinds, labels, states, actions, events, transitions, active-state semantics, required command inputs, relationships, concurrency rules, tracker mappings, and workflow semantic version that the Workflow runtime executes deterministically. In v1 it is authored as a TypeScript module exporting a strict declarative object through a typed `defineManifest` helper, loaded with `jiti`, and validated at runtime; TypeScript is for authoring ergonomics, not executable workflow hooks. The workflow semantic version is required and lives at `workflow.version`, separate from the manifest schema version.
_Avoid_: hard-coded workflow, loose configuration, workflow code

**Workflow manifest**:
The normalized in-memory declarative object that represents a Workflow definition after defaults and validation shape are applied. It contains workflow vocabulary, kinds, transitions, commands, lifecycle state semantics such as `activeStates` and `terminalStates`, policies, and relationships, but not runtime integration bindings such as trackers or handlers.
_Avoid_: workflow module, manifest file, executable manifest

**Workflow module**:
A TypeScript module loaded by the AWF CLI that may export both the declarative Workflow definition as `manifest` and runtime integration bindings such as `tracker` or `commandHandlers`. Runtime integration bindings are adjacent to, but not part of, the Workflow definition.
_Avoid_: executable manifest, manifest hooks

**Manifest command**:
A Workflow definition declaration for an invokable workflow operation, including its CLI shape, target workflow filter, optional transition event, optional attempt effect, and input schema. Manifest command CLI verbs are workflow vocabulary rather than a fixed runtime list such as only create or apply; target filters may match kind, state, action, or reason, command input is accepted only when declared, hidden generic command invocation by stable command id is available as an automation escape hatch.
_Avoid_: built-in lifecycle command, hidden command route, generic resume command

**Transition command**:
A Manifest command that applies a manifest-declared transition, optionally through generic handlerless execution with a plain default log message. Its availability is determined by the command target filter and matching transition existence; completing transitions require the issue to currently be in a manifest active state.
_Avoid_: built-in start command, built-in fail command, hidden event inference, run-token command

**Command handler**:
A Workflow module runtime binding keyed by a declarative Workflow command id that implements command-specific behavior when AWF's generic behavior is not enough. A normal Command handler receives AWF-parsed and manifest-validated input plus a constrained facade of AWF primitives; compatibility Command handlers may opt into owning raw CLI/input parsing for legacy command envelopes. It is not part of the Workflow definition.
_Avoid_: manifest command hook, executable command declaration

**Lifecycle transition handler**:
A Workflow module runtime binding for semantic work around a manifest-declared lifecycle transition, such as validating transition input beyond schema shape or requesting generic follow-up workflow operations. Lifecycle command entry points are workflow-module concerns; the handler supplies workflow-specific semantics without direct tracker mutation.
_Avoid_: runtime lifecycle command, bundled terminal special case, raw tracker hook

**Transition application helper**:
A runtime utility that applies a manifest-declared transition by producing ordinary workflow update and log effects. It receives workflow-specific plain log text from the caller and explicit attempt-effect intent from the manifest command, validates start transitions into active states and complete transitions from active states into idle states, and does not infer lifecycle policy from hard-coded state names.
_Avoid_: built-in lifecycle command, hidden transition policy, run-id validator

**Readiness policy**:
A declarative Workflow definition rule that decides which Workflow issues are executable now, including workflow-field filters, named relationship filters, dependency gates, active-run gates, concurrency gates, and relationship-driven gates such as waiting for children to finish. It is evaluated by the Workflow runtime and should remain explainable without executing workflow-module code.
_Avoid_: ready callback, schedulability plugin, hidden queue logic

**AWF config file**:
The project-local TypeScript file, conventionally `awf.config.ts`, that the AWF CLI loads as a Workflow module for the current working directory.
_Avoid_: global config, manifest file, workflow definition file

**Bundled workflow**:
A Workflow definition shipped with the CLI package. The first bundled workflow is `agent-workflow`, the agent-development workflow using Spec, Task, Grilling, and Wayfinder workflow issue kinds.
_Avoid_: built-in special case, example-only workflow

**Tracker API**:
The Workflow runtime's lowest-common-denominator interface for issue tracker primitives such as issues, labels or fields, comments, children, dependencies, and logs. Workflow-specific mapping details live inside tracker adapters, not in parent-agent commands.
_Avoid_: GitHub API wrapper, workflow API

**Tracker Intent Module**:
The Workflow runtime module that executes high-level Tracker API intents, such as creating Workflow issues, recording text logs, changing relationships, or applying ordered workflow effects, by coordinating tracker adapter primitives and verifying Workflow issue invariants. Lifecycle-specific intents such as starting, completing, escalating, or resuming runs are workflow command concerns rather than Tracker API concepts.
_Avoid_: adapter helper, tracker service, command wrapper, lifecycle command wrapper

**File-backed Tracker Adapter**:
A Tracker API implementation that stores Workflow issues and their workflow data durably on the local filesystem for local or development use, rather than keeping them only in process memory or delegating to an external tracker.
_Avoid_: filesystem memory tracker, local GitHub replacement

**Workflow issue**:
The core domain object managed by the Workflow runtime. A Workflow issue is a tracker issue with one manifest-defined kind attached to it, plus explicit current workflow fields and append-only logs.
_Avoid_: generic entity, built-in Spec/Ticket/Handoff object

**Task**:
A workflow-domain unit of work: anything an agent has to do. A Task carries a description, status, durable subkind (`work`, `research`, or `prototype`; default `work`), and project-specific routing profile; tracker issues are one representation of Tasks rather than the domain concept itself. Collaborative decision conversations belong to Grilling rather than Task.
_Avoid_: ticket, implementation action

**Grilling**:
A collaborative conversation Workflow issue for reaching shared understanding or pressure-testing a decision with a human. A Grilling issue is a top-level kind in `agent-workflow`, may stand alone or support a Wayfinder or Spec, and is not agent-executable merely because it is ready.
_Avoid_: task subkind, autonomous agent work, ordinary waiting-human pause

**Generated-by relationship**:
A directional Task-to-Task provenance relationship from a generated Task back to the source Task that caused it to exist. It explains task origin separately from Spec containment and dependency blocking.
_Avoid_: implicit follow-up, child task provenance

**Task subkind**:
Manifest-declared durable workflow data on a Task that classifies the work as `work`, `research`, or `prototype` without changing the kind/state/action/reason lifecycle tuple or readiness matching.
_Avoid_: profile routing policy, lifecycle action, readiness gate

**Task profile**:
A project-specific freeform routing label on a Task that indicates what kind of agent or worker should pick it up. The Workflow runtime treats the profile as data for selection and routing rather than as workflow semantics.
_Avoid_: hard-coded action, agent implementation config

**Current workflow fields**:
The explicit tracker-backed fields on a Workflow issue that describe its durable workflow position, such as current kind, state, action, and workflow semantic version. They are authoritative for workflow commands; logs are used to validate and diagnose drift, not to silently replace these fields during execution. Manifest-declared active-state semantics validate whether the current state can have active work, and issues whose workflow semantic version does not match the loaded manifest require migration or reconciliation before normal commands proceed.
_Avoid_: derived state, cached labels, durable dependency-blocked state, active run token

**Workflow log**:
An append-only text record for a Workflow issue with minimal runtime metadata such as sequence and issue id. Workflow logs are authoritative for history, audit, attempt derivation, and drift diagnosis, but workflow-specific lifecycle meaning belongs in current workflow fields and manifest transitions rather than special log types.
_Avoid_: regular comment, mutable history, structured command output, run-token record

**Workflow attempt**:
One execution attempt for a Workflow issue's current action, inferred from ordered start and end logs rather than identified by a runtime token. Workflows that use attempt effects must declare active-state semantics, and terminal outcome history is plain log text rather than a runtime-enforced immutable record.
_Avoid_: workflow run, run id, task session, event-sourced run ledger

**Terminal state**:
A Workflow manifest-declared state where the workflow regards an issue as complete or no longer progressing through ordinary readiness. Terminal semantics are workflow-owned metadata rather than inferred from state names or absence of outgoing transitions; terminal states are excluded from readiness, but may still have explicit manifest-declared outgoing transitions.
_Avoid_: hard-coded done state, implicit terminal state

**Workflow reconciliation**:
A Workflow runtime operation that compares current workflow fields, workflow logs, and tracker projections to detect drift or corruption. It is read-only by default; applying reconciliation performs only deterministic safe repairs and otherwise reports unresolved drift as manual repair without choosing a workflow-specific human-intervention state.
_Avoid_: automatic state rebuild, silent repair, built-in escalation, need-human repair

**Manual repair**:
A reconciliation outcome where AWF can identify invalid workflow metadata or history but cannot safely choose a deterministic correction. Manual repair is runtime diagnostic language, not a workflow state or transition target.
_Avoid_: need-human repair, automatic escalation, corrupt workflow state
