# Personal global workflow CLI definition

## Name

- Product name: **Forge**.
- CLI binary: `forge`.
- Repository package name: `@albizures/forge`, with source expected under `packages/forge/` if implemented in this repository.

`forge` is short enough for a daily personal workflow entrypoint while emphasizing agent-assisted work shaping and execution.

## First-deliverable goals

Forge is a globally installed, single-workflow record tool for the maintainer's own work across many repositories.

The first deliverable should:

1. Provide one global store shared by all projects.
2. Track project-owned and cross-project workflow records from any current working directory.
3. Preserve the useful AWF concepts of explicit state, parent/child relationships, dependency readiness, and readable Markdown storage.
4. Separate manual comments from internal/system updates.
5. Offer a small, stable CLI for daily use by humans and agents.
6. Support multi-project initiatives without making specs multi-project.
7. Define enough storage and command behavior to hand implementation to a normal Spec/Tasks flow.

## Non-goals and constraints

- Forge is not AWF v2 and should not expose a generic workflow manifest/runtime platform.
- Do not implement pluggable tracker backends in the first deliverable; use one filesystem-backed global store.
- Do not use project-local storage such as `.awf/tracker` for normal operation.
- Do not use hidden command ids or require users/agents to call internal dispatch commands.
- Do not treat comments as lifecycle logs. Comments are manual notes only.
- Do not make specs multi-project; every spec belongs to exactly one project.
- Do not make tasks or grilling records standalone in the first deliverable; they must be children of a spec or wayfinder.
- Do not make routing profiles part of lifecycle semantics. Tags/profiles may exist as metadata only.
- Do not implement physical record deletion in the first deliverable; close records with a resolution instead.

## Domain model

Forge tracks **workflow records**. A workflow record is any first-class tracked object with identity, state, comments, updates, history, and lifecycle. `issue` is not the universal domain noun.

Workflow record kinds are:

- `initiative`: cross-project delivery envelope;
- `wayfinder`: route-finding map for unclear work;
- `spec`: project-local delivery contract;
- `task`: executable child work;
- `grilling`: human-in-the-loop decision/support child work.

### Record identity

Every workflow record has:

- a stable numeric id allocated globally within the store;
- a title;
- a kind: `initiative`, `wayfinder`, `spec`, `task`, or `grilling`;
- a `subkind` field, set to `null` except for task subkinds;
- a structured scope;
- explicit state;
- authored relationship fields: `parent`, `initiative`, `dependsOn`, and `generatedBy`;
- optional non-semantic metadata: `tags` and `profile`;
- an editable Markdown body;
- manual comments;
- tool-owned updates.

Record ids are globally unique. Explicit id commands such as `forge show 60`, `forge start 60`, and `forge comment 60 ...` work from any directory without project context.

Record `kind` and `parent` are immutable after creation. Scope identity is normally immutable after creation: if a record was created in the wrong project or with the wrong scope type, close it with an appropriate resolution and create a replacement. Initiative membership is editable through explicit initiative commands because discovery can reveal or correct grouping.

### Scope

Every workflow record has an explicit `scope`:

```ts
type Scope =
  | { type: "project"; project: string }
  | { type: "project-set"; projects: string[] }
  | { type: "initiative"; initiative: number }
  | { type: "global" };
```

Scope rules:

- `initiative` records use project-set-like scope information through their declared project list.
- `wayfinder` records may use `project`, `project-set`, `initiative`, or rarely `global` scope.
- `spec` records must use `project` scope and therefore belong to exactly one project.
- `task` and `grilling` records have explicit scope, but Forge validates that their scope is compatible with their parent.
- Project grouping is a query/index concern, not a physical storage invariant.

Parent/child scope compatibility:

- A child of a project-scoped spec or wayfinder must use the same project scope.
- A child of a project-set wayfinder may use the same project-set scope or one project contained in the set.
- A child of an initiative-scoped wayfinder may use initiative scope or one project declared by the initiative.

### Projects

Projects are first-class records in store configuration, not implied by store location.

A project has:

- a stable lowercase kebab-case slug id, e.g. `harness`;
- a display name;
- one or more absolute roots;
- optional repository metadata such as remote URL;
- optional aliases.

Project ids match:

```text
[a-z0-9][a-z0-9-]*[a-z0-9]
```

Commands infer the current project by longest matching registered root. `--project <id>` overrides inference where a command accepts a project scope or project filter. If no project can be inferred, commands that need project scope fail with a clear registration hint unless an explicit project, broader scope, or all-records flag is supplied.

Moved or renamed repositories are handled by editing the project record roots. Existing workflow data keeps the project id stable.

Project removal may exist only for projects with no records. If a project has records, removal should fail and suggest editing roots instead.

### Initiatives

An `initiative` is a cross-project delivery envelope. Use an initiative when a destination requires coordinated specs across more than one project, or when a wayfinder discovers that multi-project grouping is needed.

An initiative has:

- a declared project list;
- optional member specs and wayfinders;
- normal lifecycle state, comments, updates, and history.

Initiative membership is authored on member records with `initiative: <id>` and indexed by Forge. The initiative file may show member summaries, but membership source of truth lives on the member records.

An initiative may start with no specs only when it has at least one member wayfinder explaining unresolved fog. This prevents empty labels with no route.

Initiative declared projects are editable through explicit audited commands because discovery can expand or shrink scope:

```sh
forge initiative project add 12 docs-site
forge initiative project remove 12 docs-site
```

Attaching a record to an initiative validates that its project is declared by the initiative. If another project is needed, users must add the project explicitly before attaching that record.

Initiatives are not parents of tasks or grilling records. They group specs and wayfinders through membership.

### Lifecycle states

All workflow record kinds share the same simple state machine:

```text
ready -> in-progress -> done
ready -> done
```

`blocked` is not a persisted lifecycle state. Blocking is a readiness diagnosis computed from dependencies, parent/child validation, initiative membership, and other gates. There are no lifecycle commands for `block` or `recover` in the first deliverable.

A done record records a required resolution slug. Resolution slugs are open/user-defined and validated only as lowercase kebab-case:

```text
[a-z0-9][a-z0-9-]*[a-z0-9]
```

Examples include `completed`, `decision`, `out-of-scope`, `superseded`, and `failed`, but Forge does not enforce a fixed enum in the MVP.

`forge done` requires an explicit resolution every time:

```sh
forge done 60 --resolution completed
```

There is no outcome text in the MVP. If users want context, they add a separate comment.

`forge start` is idempotent: starting an already `in-progress` record succeeds without creating a duplicate update. `forge done` is idempotent only when the record is already done with the same resolution; attempting to change the resolution fails.

All records share this base lifecycle, but completion gates are kind-specific:

- an initiative can be done only when required member specs are done and member wayfinders are done, superseded, or out of scope;
- a spec can be done only when child tasks/grilling records are terminal;
- a wayfinder can be done when the route is clear enough for specs/initiatives or the destination is ruled out, and child records are terminal;
- a task can be done when the executable work is complete;
- a grilling record can be done when the human decision/support outcome is recorded.

## Record kinds and subkinds

### `initiative`

An `initiative` groups coordinated multi-project delivery.

Use an initiative when:

- a destination requires specs in multiple projects;
- a wayfinder discovers the work is larger than one project;
- cross-project dependency or progress needs a single envelope.

An initiative may have member specs and member wayfinders. It does not have child tasks or grilling records.

### `wayfinder`

A `wayfinder` maps unclear work until the route to a destination is clear.

Use a wayfinder when:

- the destination can be named, but the route is foggy;
- decisions, research, or prototypes are needed before specs can be written;
- implementation should not start yet.

Wayfinders are scope-flexible. A wayfinder may be project-scoped, project-set-scoped, initiative-scoped, or rarely global. A project-set wayfinder may exist before an initiative because its purpose may be to decide whether an initiative is needed.

A wayfinder can generate:

- one project-local spec;
- multiple project-local specs;
- an initiative;
- additional wayfinders.

If a wayfinder creates an initiative, provenance is recorded with `generatedBy`. The wayfinder only becomes an initiative member if explicitly attached.

A wayfinder may have child tasks and grilling records. Forge should prevent closing a wayfinder while child records remain open.

### `spec`

A `spec` defines a project-local implementation outcome that is clear enough to break into delivery work.

Use a spec when:

- the desired end state is already known;
- implementation tasks can be listed and ordered;
- verification can be defined.

A spec must have `project` scope and therefore belongs to exactly one registered project. Multi-project work is modeled as an initiative with one or more project-local specs:

```text
initiative
  spec for project A
  spec for project B
  optional initiative wayfinder
```

A spec may have child tasks and grilling records. A spec is complete only when its required child work is terminal and its own resolution is recorded. Forge should prevent closing a spec while child records remain open.

### `task`

A `task` is executable work that can be completed without redefining the parent goal.

A task may have one of these subkinds:

- no subkind: ordinary prerequisite or implementation work;
- `research`: reading/investigation with a summarized result;
- `prototype`: throwaway artifact used to answer a design question;
- `review`: review against a stated spec, standard, or implementation request.

Task subkind is semantic only when it changes expectations for output or readiness. Routing labels such as `docs`, `implement`, or `research` are metadata, not subkinds.

Tasks must have a parent spec or wayfinder in the MVP. Tasks cannot have children in the MVP. If task work uncovers a human decision, create a sibling `grilling` under the same spec/wayfinder and make the task or a follow-up task depend on it.

### `grilling`

A `grilling` record is human-in-the-loop decision support.

Use grilling when:

- the next step depends on the maintainer's preference or judgment;
- a plan needs pressure-testing;
- an agent must not decide on behalf of the human.

Grilling records must have a parent spec or wayfinder in the MVP. Grilling can be ready or blocked by computed readiness gates like any other record, but agent automation should not auto-resolve it. Default `forge next` excludes grilling unless `--include-hitl` is supplied.

## Relationships

Relationships are explicit fields, not prose conventions.

- `parent`: optional id of the containing spec or wayfinder. Only tasks and grilling records may have a parent.
- `initiative`: optional id of the initiative this spec or wayfinder belongs to.
- `dependsOn`: records that must be done before this record is ready.
- `generatedBy`: optional provenance relationship; it does not gate readiness.

`children`, `initiativeMembers`, and `dependents` are inverse relationships derived into indexes; they are not authored in record frontmatter.

Relationship rules for the MVP:

- Only `task` and `grilling` records may have a parent.
- Only `spec` and `wayfinder` records may be parents.
- Parent is immutable after creation.
- Only `spec` and `wayfinder` records may be initiative members.
- Initiative membership is edited through explicit initiative commands.
- Dependencies may exist between same-project records as long as they do not create a cycle.
- Cross-project dependencies require both records to be members of the same initiative. The first implementation may restrict cross-project dependencies to spec-level edges.
- Direct dependency edges between a parent and its child are disallowed.
- Sibling dependencies are the normal ordering mechanism for child work.
- Dependencies on already-done records are allowed.
- Adding a dependency to an `in-progress` record is allowed; it may make the record blocked while still `in-progress`.
- Any `done` dependency unblocks dependents regardless of resolution slug.
- `generatedBy` may cross scopes because it records provenance, not readiness.

Readiness uses state plus dependency relationships. Parent/child relationships organize work but do not by themselves imply ordering. A child is blocked if its parent is already `done`; a child does not require its parent to be `in-progress`.

Creation with `--parent <id>` uses a compatible scope derived from the parent unless an explicit compatible scope is supplied. Creation of a spec under an initiative still requires exactly one project through explicit project, inferred project, or an unambiguous single-project initiative. Dependencies do not infer scope during creation; scope comes from parent, explicit scope flags, initiative, or cwd.

Relationship edit commands exist for dependencies:

```sh
forge deps add <record> --depends-on <id>
forge deps remove <record> --depends-on <id>
```

Initiative membership commands exist for grouping:

```sh
forge initiative attach <initiative> <record>
forge initiative detach <initiative> <record>
```

## Comments, updates, and history

### Comments

Comments are manual notes.

- Comments are separate from lifecycle/system updates.
- Comments are Markdown with YAML frontmatter.
- Comments are editable.
- Comment ids are per record.
- Editing a comment writes an internal update noting the edit.
- Comments do not have author/actor metadata in the MVP.
- `forge comments <record>` shows only manual comments.

Comments should be used for discussion, observations, handoff notes, or user-authored context.

`forge comment` supports string, file, and stdin input:

```sh
forge comment 60 --message "..."
forge comment 60 --message-file note.md
forge comment 60 --message -
```

`forge comment edit <record> <comment-id>` opens the comment body for editing. Comment frontmatter changes are rejected.

### Updates

Updates are structured, tool-owned records of internal history.

An update records at least:

- per-record sequence number;
- record id;
- timestamp;
- update type;
- concise summary;
- optional structured data.

Updates do not have actor/author metadata in the MVP.

Updates represent events such as create, start, done, relationship changes, initiative membership changes, title/body edits, comment creation, comment edits, and store repairs. Every accepted mutation creates an update record.

Updates are append-only in normal operation. They are the audit trail, not the current-state source of truth; current state lives on the record snapshot.

### History

History is a combined view of comments and updates.

- `forge updates <record>` shows internal/system updates.
- `forge comments <record>` shows manual comments.
- `forge history <record>` shows both, clearly tagged.
- Default `forge show` stays quiet: current snapshot, relationships, recent comments, and a terse recent-update summary.

Agents should rely on the record snapshot plus updates for authoritative workflow state, and on comments for human-authored context.

## CLI surface

### Global flags

```text
-C, --cwd <path>            Run as if from another directory
--project <id>              Override inferred project context or filter by project where supported
--projects <ids>            Use a comma-separated project set where supported
--initiative <id>           Use or filter by initiative where supported
--scope <scope>             Structured scope, e.g. project:harness or project-set:a,b
--all-records               Include all records where supported
--store <path>              Override configured store path for tests/migration
--json                      Emit machine-readable output
-h, --help                  Show generated help
```

Scope flags are command-specific. Creation/mutation commands reject incompatible scope flags unless the command explicitly defines how they combine. Inspection/listing commands may combine flags as filters, for example `forge list --initiative 12 --project harness`.

### Creation

```text
forge new initiative --title <title> (--body <md>|--body-file <file>|--body -) --projects <ids>
forge new wayfinder --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>|--projects <ids>|--initiative <id>|--scope <scope>]
forge new spec --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>] [--initiative <id>] [--generated-by <id>]
forge new task --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--kind research|prototype|review] [--depends-on <id>]...
forge new grilling --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--depends-on <id>]...
```

Creation commands attach scope from parent, explicit scope flags, initiative, inferred cwd, or a command-specific default. Long prose supports stdin and file flags. Structured JSON input is not part of ordinary creation UX for the first deliverable.

Spec creation under an initiative must resolve exactly one project. If the initiative declares exactly one project, Forge may use it as a convenience; otherwise Forge requires explicit or inferred project context.

Task and grilling creation require `--parent <id>`.

### Inspection and navigation

```text
forge show <record>
forge open <record>
forge edit <record>
forge list [--state <state>] [--kind <kind>] [--project <id>|--initiative <id>|--all-records]
forge ready [--blocked] [--project <id>|--initiative <id>|--all-records]
forge next [--include-hitl] [--planning] [--project <id>|--initiative <id>]
forge tree <record>
forge deps <record>
forge here
forge projects
forge initiatives [--project <id>|--all-records]
```

`forge ready` lists executable ready records, including `grilling` when requested by flags. `forge ready --blocked` lists blocked candidates only and explains all known blocking reasons.

`forge next` is the daily entrypoint. It does not mutate state; users/agents must run `forge start <id>` separately. By default it returns executable non-HITL work, scoped to the current project plus relevant initiative context when run in a registered project. `forge next --include-hitl` may return grilling records. `forge next --planning` includes ready specs and wayfinders that need planning action. Selection is deterministic: scoped candidates, then oldest created record id.

`forge list` defaults to the current inferred project plus initiatives involving that project and member records relevant to that project. If no project can be inferred, it fails with a registration hint unless `--all-records`, `--initiative`, or an explicit project/scope is supplied.

### Lifecycle

```text
forge start <record>
forge done <record> --resolution <slug>
```

Lifecycle commands are unified across record kinds. Kind-specific validation happens underneath. Dependency management and readiness diagnostics explain blocked work without persisting a separate blocked lifecycle state.

`forge start` validates computed readiness and fails if the record is blocked.

### Relationship and initiative edits

```text
forge deps add <record> --depends-on <id>
forge deps remove <record> --depends-on <id>
forge initiative attach <initiative> <record>
forge initiative detach <initiative> <record>
forge initiative project add <initiative> <project>
forge initiative project remove <initiative> <project>
```

Dependency edits validate scope rules, acyclicity, and the no-parent-child-dependency rule. Cross-project dependency edits require shared initiative membership.

Initiative attach validates that the member is a spec or wayfinder and that project membership is declared. Detaching a done record may be rejected in the MVP to preserve historical grouping unless a future repair command exists.

### Comments and history

```text
forge comment <record> --message <md>
forge comment <record> --message-file <file>
forge comment <record> --message -
forge comments <record>
forge comment edit <record> <comment-id>
forge updates <record>
forge history <record>
```

### Store and config

```text
forge config get [<key>]
forge config set <key> <value>
forge store path
forge store doctor
forge project add <id> --root <path> [--name <name>] [--remote <url>]
forge project root add <id> <path>
forge project root remove <id> <path>
forge project remove <id>
```

Configuration lives outside project repositories. The required config value is `storePath`, an absolute path.

## Editing behavior

`forge edit <record>` opens the record Markdown file. After the editor exits, Forge validates the file before accepting the edit and writing an update record.

Editable through `forge edit`:

- `title`;
- `tags`;
- `profile`;
- Markdown body.

Not editable through `forge edit`:

- immutable identity/placement fields: `id`, `kind`, `subkind`, `scope`, `parent`, `initiative`, `createdAt`;
- lifecycle fields: `state`, `resolution`;
- relationship fields: `dependsOn`, `generatedBy`.

State/resolution changes use lifecycle commands. Dependency changes use relationship commands. Initiative membership and declared initiative project changes use initiative commands.

## Global store layout

Config path:

```text
~/.config/forge/config.json
```

Example config:

```json
{
  "storePath": "/absolute/path/chosen/by/user"
}
```

There is no default or recommended store path. If the config file is missing, `storePath` is absent, or `storePath` is not absolute, commands that need the store fail with a clear setup hint. A setup/init command may write the config, but it must choose an explicit absolute `storePath` rather than silently falling back to a default.

Store layout, assuming `storePath` is `/absolute/path/chosen/by/user`:

```text
/absolute/path/chosen/by/user/
  manifest.json
  lock
  projects/
    harness.json
  records/
    initiative/
      000/
        000012.md
    wayfinder/
      000/
        000060.md
    spec/
      000/
        000100.md
    task/
      000/
        000061.md
    grilling/
      000/
        000063.md
  comments/
    000/
      000060/
        0001.md
  updates/
    000/
      000060/
        0001-created.json
        0002-started.json
        0003-done.json
  indexes/
    by-id.json
    by-project.json
    by-initiative.json
    relationships.json
```

### Store root files

`manifest.json` contains MVP store metadata:

```json
{
  "schemaVersion": 1,
  "nextRecordId": 67,
  "createdAt": "2026-09-19T00:00:00.000Z",
  "updatedAt": "2026-09-19T00:00:00.000Z"
}
```

`nextRecordId` is the source of truth for record id allocation. If it conflicts with existing files, Forge fails loudly and points to `forge store doctor` rather than silently repairing or skipping ids.

The `lock` file exists to serialize writes to the global store. Detailed lock mechanics are implementation-specific for the first deliverable.

### Project file shape

Project files live at `projects/<project-id>.json`.

```json
{
  "id": "harness",
  "name": "Harness",
  "roots": ["/home/a/projects/harness"],
  "remote": "git@github.com:albizures/harness.git",
  "aliases": ["h"],
  "createdAt": "2026-09-19T00:00:00.000Z",
  "updatedAt": "2026-09-19T00:00:00.000Z"
}
```

`remote` and `aliases` are optional.

### Record file paths

Record files are grouped by kind and thousand-id shard:

```text
records/<kind>/<id-thousands-shard>/<zero-padded-id>.md
```

Examples:

```text
records/wayfinder/000/000060.md
records/spec/001/001234.md
```

Record filenames use six-digit zero-padded ids. The shard is the thousands group:

```text
id 60     -> 000/000060.md
id 1234   -> 001/001234.md
id 999999 -> 999/999999.md
```

Kind is a path component and is immutable after creation. Project and initiative views are derived from record frontmatter and indexes, not physical paths.

### Record file shape

Record files are Markdown with YAML frontmatter and editable body. Kind-specific templates may provide useful headings, but Markdown headings are not storage validity rules.

Project-scoped spec example:

```markdown
---
id: 100
title: Implement scoped workflow records
kind: spec
subkind: null
state: ready
resolution: null
scope:
  type: project
  project: harness
parent: null
initiative: 12
dependsOn: []
generatedBy: 60
tags: []
profile: null
createdAt: "2026-09-19T00:00:00.000Z"
updatedAt: "2026-09-19T00:00:00.000Z"
---

## Outcome

...
```

Project-set wayfinder example:

```markdown
---
id: 60
title: Find route for multi-project workflow records
kind: wayfinder
subkind: null
state: in-progress
resolution: null
scope:
  type: project-set
  projects: [harness, forge]
parent: null
initiative: null
dependsOn: []
generatedBy: null
tags: []
profile: null
createdAt: "2026-09-19T00:00:00.000Z"
updatedAt: "2026-09-19T00:00:00.000Z"
---

## Destination

...
```

Initiative example:

```markdown
---
id: 12
title: Deliver multi-project workflow records
kind: initiative
subkind: null
state: ready
resolution: null
scope:
  type: project-set
  projects: [harness, forge]
parent: null
initiative: null
dependsOn: []
generatedBy: 60
tags: []
profile: null
createdAt: "2026-09-19T00:00:00.000Z"
updatedAt: "2026-09-19T00:00:00.000Z"
---

## Summary

...
```

Tool-owned frontmatter is the current snapshot. The Markdown body is user-editable record content.

### Comment file shape

Comment files are grouped by record id shard and padded record id:

```text
comments/<id-thousands-shard>/<zero-padded-id>/<comment-sequence>.md
```

Example:

```text
comments/000/000060/0001.md
```

```markdown
---
id: 1
record: 60
createdAt: "2026-09-19T00:00:00.000Z"
updatedAt: "2026-09-19T00:00:00.000Z"
---

Manual note here.
```

### Update file shape

Update files are grouped by record id shard and padded record id:

```text
updates/<id-thousands-shard>/<zero-padded-id>/<update-sequence>-<event-type>.json
```

Example:

```text
updates/000/000060/0003-done.json
```

```json
{
  "sequence": 3,
  "record": 60,
  "createdAt": "2026-09-19T00:00:00.000Z",
  "type": "done",
  "summary": "Completed record with resolution decision.",
  "data": {
    "resolution": "decision"
  }
}
```

Updates are structured and tool-owned. They may be rendered as human-readable history, but users do not edit them as comments.

### Indexes

Record files/frontmatter are the source of truth. Indexes are rebuildable caches updated synchronously during writes that change indexed data. `forge store doctor` can validate and rebuild them.

`by-id.json` maps each global record id to a structured locator:

```json
{
  "60": {
    "kind": "wayfinder",
    "path": "records/wayfinder/000/000060.md"
  }
}
```

`by-id.json` includes all existing records, including `done` records.

`by-project.json` maps each project id to records that are directly scoped to the project, included in a project set, or members of initiatives that declare that project. It is a rebuildable query cache.

`by-initiative.json` maps initiative ids to declared projects and member specs/wayfinders derived from member record frontmatter.

`relationships.json` stores the full relationship graph as a rebuildable cache derived from record frontmatter. It includes authored edges and derived inverse edges such as children, initiative members, and dependents.

## Implementation handoff notes

The first implementation spec should build the vertical slice in this order:

1. Config loading with required absolute `storePath`.
2. Project registration and cwd inference.
3. Record create/show/list with Markdown files and frontmatter.
4. Scope validation and indexes by id, project, and initiative.
5. Relationship fields and readiness diagnostics.
6. Lifecycle commands and kind-specific completion gates.
7. Initiative membership and declared project commands.
8. Manual comments and history views.
9. Store doctor checks for index consistency, relationship inverse consistency, missing files, and invalid frontmatter.

This definition intentionally stops before implementation details such as TypeScript module boundaries, parser libraries, exact JSON schemas, or a future SQLite query/cache layer.
