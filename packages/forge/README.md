# @albizures/forge

Forge is a personal global workflow CLI. The npm package is CLI-only: it publishes the `forge` binary and does not provide a supported library import surface. The design source of truth is `docs/design/personal-global-workflow-cli-definition.md`; this README summarizes the implemented package operations without redefining the full workflow model.

## Command surface

```bash
forge --help
forge config get [storePath]
forge config set storePath <absolute-path>
forge store path
forge store doctor
forge project add <id> --root <path> [--name <name>] [--remote <url>]
forge project root add <id> <path>
forge project root remove <id> <path>
forge project remove <id>
forge projects
forge here
forge new initiative --title <title> (--body <md>|--body-file <file>|--body -) --projects <ids>
forge new wayfinder --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>|--projects <ids>|--initiative <id>|--scope global]
forge new spec --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>] [--initiative <id>] [--generated-by <id>]
forge new task --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--kind research|prototype|review] [--depends-on <id>]...
forge new grilling --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--depends-on <id>]...
forge show <record>
forge list [--state <state>] [--kind <kind>] [--project <id>|--initiative <id>|--all-records]
forge ready [--blocked] [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]
forge next [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]
forge start <record>
forge done <record> --resolution <slug>
forge comment <record> --message <md>
forge comment <record> --message-file <file>
forge comment <record> --message -
forge comments <record>
forge comment edit <record> <comment-id>
forge updates <record>
forge history <record>
forge initiatives [--project <id>|--all-records]
forge initiative attach <initiative> <record>
forge initiative detach <initiative> <record>
forge initiative project add <initiative> <project>
forge initiative project remove <initiative> <project>
forge tree <record>
forge deps <record>
forge deps add <record> --depends-on <id>
forge deps remove <record> --depends-on <id>
forge open <record>
forge edit <record>
```

Use `--json` for JSON output, `--store <absolute-path>` to override the configured store for tests or one-off runs, and `--cwd <absolute-path>`/`-C <absolute-path>` to test project inference for project-scoped commands. Forge uses generated Effect CLI help and validation; legacy parsed-but-unused flags such as `--plain`, `--quiet`, and `--verbose` are not supported. If generated help displays shared parser options or repeats parent names on nested subcommands, the command synopsis above remains the supported command contract and handler validation is authoritative for unsupported combinations.

## Store setup

Forge does not choose a default store path. Configure one explicitly:

```bash
forge config set storePath /absolute/path/to/forge-store
forge store doctor
```

The config file lives at `$HOME/.config/forge/config.json`. Commands that need the store fail with a setup hint until `storePath` is configured, unless `--store` is supplied.

For disposable local or integration-test runs, prefer a temp store override so your real config is not touched:

```bash
STORE="$(mktemp -d)/store"
forge --store "$STORE" store doctor
forge --store "$STORE" project add harness --root "$PWD" --name "Harness"
forge --store "$STORE" projects
forge --store "$STORE" --cwd "$PWD" here
```

Alternatively, set `FORGE_HOME` to a temporary directory before using `forge config set storePath ...`; this keeps the config file itself isolated from your real `$HOME`.

## Record operation notes

Record files are canonical Markdown files with tool-owned frontmatter and user-owned body content. `forge new` allocates globally unique numeric record ids in the configured store, writes the canonical file, and maintains lookup indexes.

Use inline Markdown, `--body-file`/`--description-file`, or `-` to read prose from stdin. Initiatives declare a comma-separated project list. Specs are project scoped and may join an initiative with `--initiative`; wayfinders may use project/project-set/initiative/global scope; tasks or grilling records must name a spec or wayfinder parent. `forge show` and `forge list` inspect records, `forge open` prints the backing file path, and `forge edit` opens a validated temporary copy in `$EDITOR` while accepting only editable metadata (`title`, `tags`, `profile`) plus body changes.

Lifecycle state is shared by every record kind: `ready`, `in-progress`, and `done`. Use `forge start <record>` to move executable ready records to `in-progress`; start validates computed readiness, refuses blocked records, and is idempotent for records that are already in progress. Use `forge done <record> --resolution <slug>` to complete ready or in-progress records. Resolutions must be lowercase kebab-case, completion is idempotent only for the same resolution, and a done record's resolution cannot be changed. Spec, wayfinder, task, and grilling completion gates reject records with open child work; initiative completion rejects open member work.

Manual comments and tool updates are separate narrative streams. Use `forge comment <record> --message <md>`, `--message-file <file>`, or `--message -` to add a manual comment, and `forge comment edit <record> <comment-id>` to edit only the comment body. `forge comments <record>` lists manual comments, `forge updates <record>` lists tool-owned system updates such as creation and lifecycle transitions, and `forge history <record>` combines both streams with clear comment/update tags. `forge show` includes quiet recent-comment and recent-update summaries alongside the current record snapshot and relationships.

## Navigation and readiness

Use `forge initiative attach <initiative> <record>` and `forge initiative detach <initiative> <record>` to edit member specs or wayfinders. Use `forge initiative project add/remove` to audit declared project changes; removal is rejected while open members still use that project. Use `forge initiatives` to list initiative envelopes, optionally by project.

Use `forge deps add <record> --depends-on <id>` and `forge deps remove <record> --depends-on <id>` to maintain dependency edges. Forge rejects dependency edges that cross incompatible scopes unless both records share an initiative, point between parent and child records, or introduce a cycle. `forge deps <record>` shows both dependencies and dependents for one record.

Use `forge ready` to list currently executable records and `forge ready --blocked` to show records blocked by unfinished dependencies or unavailable parents/children. By default, readiness is scoped to the inferred current project when possible; use `--project <id>`, `--initiative <id>`, or `--all-records` for explicit scope. Add `--include-hitl` to include ready grilling records, and `--planning` to include ready specs or wayfinders that need planning action.

Use `--json` when automation needs structured output from commands that support JSON presentation, such as `store doctor`, `projects`, `here`, `new`, `show`, `deps`, `ready`, `next`, lifecycle commands, comments/history listings, initiative edits, and config commands. `forge ready --json` returns `{ "records": [...] }`, where each record includes `id`, `kind`, `title`, `state`, and optional scope fields. Unsupported JSON combinations are rejected by handler validation; for example, `forge ready --json` cannot be combined with `--blocked` because blocked diagnostics are explanation-oriented text.

Use `forge next` as the deterministic daily-entry command. It reports the selected record without mutating state. Candidate selection applies the same scoping and inclusion flags as `forge ready`, then picks the oldest ready record id. Use `forge tree <record>` to inspect parent/child structure around a record.

## First-deliverable multi-project workflow

The completed first-deliverable surface supports one global store with many registered projects, project-scoped specs, scope-flexible wayfinders, cross-project initiatives, task/grilling child work, dependencies, comments, updates, and deterministic readiness/navigation. A typical multi-project handoff looks like this:

```bash
forge project add harness --root /work/harness
forge project add docs-site --root /work/docs-site
forge new initiative --title "Cross-project launch" --body-file launch.md --projects harness,docs-site
forge new spec --title "Harness changes" --body-file harness.md --project harness --initiative 1
forge new spec --title "Docs changes" --body-file docs.md --project docs-site --initiative 1
forge deps add 3 --depends-on 2
forge ready --initiative 1 --planning
forge next --initiative 1
```

Operational rules to remember:

- Initiatives are delivery envelopes, not parents. Their membership source of truth is the member spec/wayfinder `initiative` field, edited only with `forge initiative attach` and `forge initiative detach`.
- Initiative project declarations are explicit and audited with `forge initiative project add/remove`; removing a project is rejected while an open member still uses that project.
- Specs remain single-project records. To coordinate multiple projects, create one initiative plus one or more project-local specs.
- Wayfinders may be project, project-set, initiative, or global scoped. Use an initiative-scoped wayfinder when the route itself belongs to the cross-project envelope.
- Cross-project dependency edits are accepted when both records share the same initiative; same-scope, no-parent-child-dependency, and acyclicity checks still apply. Readiness remains blocked until dependencies are done.
- `forge list`, `forge ready`, and `forge next` accept `--project`, `--initiative`, and `--all-records` to make navigation scope explicit. Add `--planning` for specs/wayfinders and `--include-hitl` for grilling records.
- `forge done` refuses to complete specs or wayfinders while child work remains open, and refuses to complete an initiative while any member work remains open.
- `forge updates <record>` and `forge history <record>` are the audit trail for lifecycle transitions, relationship edits, initiative membership changes, declared project changes, and comments.

For authoritative rules about scopes, parent validation, immutable fields, lifecycle, relationships, comments, updates, and future commands, use `docs/design/personal-global-workflow-cli-definition.md`.

## Development checks

```bash
pnpm --filter @albizures/forge typecheck
pnpm --filter @albizures/forge test
```
