# AWF

AWF is the Harness package that provides a workflow runtime and CLI for agent workflow issues.

## Language

**Workflow runtime**:
A generic engine that evaluates workflow entity state, legal transitions, commands, relationships, logs, and tracker mutations from a workflow definition. It is not specific to one issue kind such as Spec or Ticket.
_Avoid_: agent workflow CLI core, issue workflow script

**Workflow definition**:
A project- or package-provided declarative definition of entity kinds, labels, states, actions, transitions, required command inputs and outputs, relationships, concurrency rules, and tracker mappings that the Workflow runtime executes deterministically. In v1 it is authored as a TypeScript module exporting a strict declarative object through a typed `defineManifest` helper, loaded with `jiti`, and validated at runtime; TypeScript is for authoring ergonomics, not executable workflow hooks.
_Avoid_: hard-coded workflow, loose configuration, workflow code

**Workflow manifest**:
The normalized in-memory declarative object that represents a Workflow definition after defaults and validation shape are applied. It contains workflow vocabulary, kinds, transitions, commands, policies, and relationships, but not runtime integration bindings such as trackers or handlers.
_Avoid_: workflow module, manifest file, executable manifest

**Workflow module**:
A TypeScript module loaded by the AWF CLI that may export both the declarative Workflow definition as `manifest` and runtime integration bindings such as `tracker` or `commandHandlers`. Runtime integration bindings are adjacent to, but not part of, the Workflow definition.
_Avoid_: executable manifest, manifest hooks

**Command handler**:
A Workflow module runtime binding keyed by a declarative Workflow command id that implements command-specific create/apply behavior when AWF's generic behavior is not enough. A normal Command handler receives AWF-parsed and manifest-validated input plus a constrained facade of AWF primitives; compatibility Command handlers may opt into owning raw CLI/input parsing for legacy command envelopes. It is not part of the Workflow definition.
_Avoid_: manifest command hook, executable command declaration

**Lifecycle transition handler**:
A Workflow module runtime binding for semantic work around a lifecycle transition, such as validating transition input beyond schema shape, extracting artifact references, or requesting generic follow-up workflow operations. The AWF core owns lifecycle command execution and transition mutation; the handler supplies workflow-specific semantics without direct tracker mutation.
_Avoid_: custom lifecycle command, bundled terminal special case, raw tracker hook

**Readiness policy**:
A declarative Workflow definition rule that decides which Workflow issues are executable now, including workflow-field filters, named relationship filters, dependency gates, active-run gates, concurrency gates, and relationship-driven gates such as waiting for children to finish. It is evaluated by the Workflow runtime and should remain explainable without executing workflow-module code.
_Avoid_: ready callback, schedulability plugin, hidden queue logic

**AWF config file**:
The project-local TypeScript file, conventionally `awf.config.ts`, that the AWF CLI loads as a Workflow module for the current working directory.
_Avoid_: global config, manifest file, workflow definition file

**Bundled workflow**:
A Workflow definition shipped with the CLI package. The first bundled workflow is the agent-development workflow using Spec and Ticket workflow issue kinds, with Handoff represented as an artifact rather than a workflow issue kind.
_Avoid_: built-in special case, example-only workflow

**Handoff artifact**:
A structured artifact reference that carries context, findings, or next-step guidance from one agent/human activity to another. It is attached to a source Workflow issue through command output or logs; by itself it does not imply that the source needs human intervention.
_Avoid_: handoff issue, handoff entity

**Tracker API**:
The Workflow runtime's lowest-common-denominator interface for issue tracker primitives such as issues, labels or fields, comments, children, dependencies, changes, and logs. Workflow-specific mapping details live inside tracker adapters, not in parent-agent commands.
_Avoid_: GitHub API wrapper, workflow API

**Tracker Intent Module**:
The Workflow runtime module that executes high-level Tracker API intents, such as starting a Workflow run, completing a Workflow run, recording artifacts, changing relationships, or applying a plan, by coordinating tracker adapter primitives and verifying Workflow issue invariants.
_Avoid_: adapter helper, tracker service, command wrapper

**File-backed Tracker Adapter**:
A Tracker API implementation that stores Workflow issues and their workflow data durably on the local filesystem for local or development use, rather than keeping them only in process memory or delegating to an external tracker.
_Avoid_: filesystem memory tracker, local GitHub replacement

**Workflow issue**:
The core domain object managed by the Workflow runtime. A Workflow issue is a tracker issue with one manifest-defined kind attached to it, plus explicit current workflow fields and append-only logs.
_Avoid_: generic entity, built-in Spec/Ticket/Handoff object

**Task**:
A workflow-domain unit of work: anything an agent has to do. A Task carries a description, status, and project-specific routing profile; tracker issues are one representation of Tasks rather than the domain concept itself.
_Avoid_: ticket, implementation action

**Generated-by relationship**:
A directional Task-to-Task provenance relationship from a generated Task back to the source Task that caused it to exist. It explains task origin separately from Spec containment and dependency blocking.
_Avoid_: implicit follow-up, child task provenance

**Task profile**:
A project-specific freeform routing label on a Task that indicates what kind of agent or worker should pick it up. The Workflow runtime treats the profile as data for selection and routing rather than as workflow semantics.
_Avoid_: hard-coded action, agent implementation config

**Workflow artifact reference**:
A typed reference declared in a Workflow definition's command input or output schema that tells the Workflow runtime what kind of artifact a value points to, such as inline Markdown, a file, an issue, a pull request, a URL, or a Git ref. It validates shape and storage/reference type, not artifact quality.
_Avoid_: plain string output, attachment blob

**Current workflow fields**:
The explicit tracker-backed fields on a Workflow issue that describe its durable workflow position, such as current kind, state, action, and active run id. They are authoritative for normal workflow commands; logs are used to validate and diagnose drift, not to silently replace these fields during execution. Live gates such as dependency and concurrency blocking are computed readiness results, not durable current workflow fields.
_Avoid_: derived state, cached labels, durable dependency-blocked state

**Workflow log**:
An append-only, machine-marked event record for a Workflow issue. Workflow logs are authoritative for history, audit, attempt derivation, and drift diagnosis; malformed machine-marked entries are corruption rather than comments to skip.
_Avoid_: regular comment, mutable history

**Workflow run**:
One execution attempt for a Workflow issue's current action. A running Workflow issue carries exactly one active run id in its current workflow fields, and that run has exactly one immutable terminal outcome.
_Avoid_: loose attempt, task session

**Workflow reconciliation**:
A Workflow runtime operation that compares current workflow fields, workflow logs, and tracker projections to detect drift or corruption. It is read-only by default; applying reconciliation performs only deterministic safe repairs and otherwise leaves or marks the issue as needing human intervention.
_Avoid_: automatic state rebuild, silent repair
