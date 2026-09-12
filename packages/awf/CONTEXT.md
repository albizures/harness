# AWF

AWF is the Harness package that provides the runtime and CLI for bundled `agent-workflow` issues.

## Language

**Workflow runtime**:
The engine that evaluates `agent-workflow` entity state, legal transitions, commands, relationships, logs, and tracker mutations from the bundled workflow definition. It owns execution mechanics for the supported workflow rather than a public generic workflow-authoring platform.
_Avoid_: generic workflow platform, issue workflow script, arbitrary workflow engine

**Workflow definition**:
The bundled `agent-workflow` declarative definition of entity kinds, labels, states, actions, events, transitions, active-state semantics, required command inputs, relationships, concurrency rules, tracker mappings, and workflow semantic version that AWF executes deterministically. Public consumers should use the supported bundled workflow rather than authoring arbitrary workflow definitions.
_Avoid_: public generic manifest, loose configuration, executable workflow hooks

**Workflow manifest**:
The normalized in-memory declarative object that represents a Workflow definition after defaults and validation shape are applied. It contains workflow vocabulary, kinds, transitions, commands, lifecycle state semantics such as `activeStates` and `terminalStates`, policies, and relationships, but not runtime integration bindings such as trackers or handlers.
_Avoid_: workflow module, manifest file, executable manifest

**Workflow module**:
A TypeScript module loaded by the AWF CLI, usually `awf.config.ts`, that may export a tracker and optionally the supported bundled `agent-workflow` manifest. Handler bindings are internal compatibility details, not public extension points.
_Avoid_: executable manifest, manifest hooks, command-handler plugin API

**Error envelope**:
A failed AWF command result with a stable machine-readable code, human-readable message, and optional JSON details. Error envelopes are part of AWF's CLI/API contract rather than incidental exception text.
_Avoid_: thrown error, failure object, envelop error

**Failure definition**:
A reusable template or factory for producing an Error envelope with a stable code, message, and contextual details. Runtime-owned Failure definitions belong to the Workflow runtime; bundled workflow-specific definitions belong to the bundled workflow that emits them.
_Avoid_: error helper, message constant, exception class

**Failure catalog**:
A module-owned collection of Failure definitions that names AWF's stable failure vocabulary for that module boundary.
_Avoid_: global error bag, random constants, status enum

**Manifest command**:
A bundled `agent-workflow` declaration for an invokable workflow operation, including its supported CLI shape, target workflow filter, optional transition event, optional attempt effect, and input schema. Hidden command-id invocation is retained only as an internal/automation escape hatch and is omitted from normal help.
_Avoid_: arbitrary CLI verb, public command registration, generic run-command UX

**Transition command**:
A Manifest command that applies a manifest-declared transition, optionally through generic handlerless execution with a plain default log message. Its availability is determined by the command target filter and matching transition existence; completing transitions require the issue to currently be in a manifest active state.
_Avoid_: built-in start command, built-in fail command, hidden event inference, run-token command

**Command handler**:
An internal runtime binding keyed by an `agent-workflow` command id that implements bundled workflow behavior. It is not part of the public authoring or extension surface.
_Avoid_: public command handler registration, raw-input handler convention, executable command declaration

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
A Workflow definition shipped with the CLI package. The supported bundled workflow is `agent-workflow`, which uses Spec, Task, Grilling, and Wayfinder workflow issue kinds.
_Avoid_: built-in special case, example-only workflow, legacy agent-development workflow

**Tracker API**:
The Workflow runtime's lowest-common-denominator interface for issue tracker primitives such as issues, labels or fields, comments, children, dependencies, and logs. Workflow-specific mapping details live inside tracker adapters, not in parent-agent commands.
_Avoid_: GitHub API wrapper, workflow API

**Tracker Intent Module**:
The internal runtime module that executes high-level Tracker API intents, such as creating Workflow issues, recording text logs, changing relationships, or applying ordered workflow effects, by coordinating tracker adapter primitives and verifying Workflow issue invariants. It is not a reusable public tracker-intent API.
_Avoid_: public tracker intent API, adapter helper, command wrapper, lifecycle command wrapper

**File-backed Tracker Adapter**:
A Tracker API implementation that stores Workflow issues and their workflow data durably on the local filesystem for local or development use, rather than keeping them only in process memory or delegating to an external tracker.
_Avoid_: filesystem memory tracker, local GitHub replacement

**Workflow issue**:
The core domain object managed by the Workflow runtime. A Workflow issue is a tracker issue with one manifest-defined kind attached to it, plus explicit current workflow fields and append-only logs.
_Avoid_: generic entity, built-in Spec/Ticket/Handoff object

**Spec**:
A workflow issue that describes an implementation outcome and contains the child Tasks and Grilling needed to deliver it. Its executable lifecycle is limited to planning and explicit validated completion; integration testing and merging are modeled as Tasks instead of Spec actions.
_Avoid_: execution phase container, integration-test action, merge action

**Task**:
A workflow-domain unit of work: anything an agent has to do. A Task carries a description, status, durable subkind (`work`, `research`, or `prototype`; default `work`), and project-specific routing profile; tracker issues are one representation of Tasks rather than the domain concept itself. Collaborative decision conversations belong to Grilling rather than Task.
_Avoid_: ticket, implementation action

**Integration-test Task**:
A ready-gated Task that verifies completed implementation and review work against its parent Spec before merge work can proceed. It is ordinary work routed by profile rather than a separate Task subkind or Spec lifecycle phase, and each Integration-test Task represents one verification pass.
_Avoid_: Spec integration-test action, test phase

**Merge Task**:
A ready-gated Task that performs the final integration of completed, verified work for a Spec. It is ordinary work routed by profile rather than a separate Task subkind or Spec lifecycle phase; AWF may enforce coarse readiness such as no open implementation, review, or integration-test Tasks, while integration-test freshness is an agent obligation.
_Avoid_: Spec merge action, terminal Spec phase

**Ready-gated Task**:
A Task whose readiness depends on declarative bundled-workflow conditions beyond its own lifecycle state, such as no open implementation or review Tasks under the same Spec. Ready-gated Tasks remain ordinary Tasks; the gate controls when they appear ready, not what kind of work they are, and does not necessarily prove every agent-planning invariant.
_Avoid_: Spec phase gate, hard-coded runtime special case

**Implementation gate**:
A declarative profile group that identifies Tasks whose non-terminal state blocks Integration-test readiness. Merge readiness also requires no open Integration-test Tasks and at least one completed Integration-test Task.
_Avoid_: hard-coded implementation task list, dependency rewiring

**Integration-test freshness**:
An agent-planning obligation that follow-up implementation or review work after an Integration-test Task schedules another Integration-test Task before merge work proceeds. Freshness is not proved by AWF readiness gates unless a workflow explicitly models it.
_Avoid_: runtime freshness proof, implicit merge validation

**Grilling**:
A collaborative conversation Workflow issue for reaching shared understanding or pressure-testing a decision with a human. A Grilling issue is a top-level kind in `agent-workflow`, may stand alone or support a Wayfinder or Spec, and is not agent-executable merely because it is ready; when it is waiting on the human's turn, it may use waiting-human state.
_Avoid_: task subkind, autonomous agent work

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
