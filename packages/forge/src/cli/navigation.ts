import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import type { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";
import type { AbsolutePath, ProjectId } from "../domain.ts";
import { parseAbsolutePath, parseProjectId } from "../domain.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
} from "../filesystem-store.ts";
import { inferProjectByPathEffect } from "../project-registry.ts";
import type {
	NextRecordOptions,
	ReadinessDiagnosis,
	RecordDependencyView,
	RecordFrontmatter,
	RecordId,
	RecordTreeNode,
	WorkflowRecord,
} from "../record-domain.ts";
import {
	addWorkflowRecordDependencyEffect,
	listWorkflowRecordsEffect,
	listWorkflowRecordReadinessEffect,
	readRecordDependencyViewEffect,
	readRecordTreeEffect,
	removeWorkflowRecordDependencyEffect,
	selectNextWorkflowRecordEffect,
} from "../record-store.ts";
import type { CliCommandRegistration, CommandOutput, Parsed } from "./types.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";

type CommandHandler = typeof buildCommandHandler;

const navigationScopeOptions = {
	project: Options.text("project").pipe(Options.optional),
	initiative: Options.text("initiative").pipe(Options.optional),
	allRecords: Options.boolean("all-records"),
};
const navigationWorkOptions = {
	includeHitl: Options.boolean("include-hitl"),
	planning: Options.boolean("planning"),
};
const presentationOptions = {
	json: Options.boolean("json").pipe(
		Options.withDescription("Render command output as JSON."),
	),
};
const recordArg = Args.text({ name: "record" });

export function createNavigationCommands(
	commandHandler: CommandHandler = buildCommandHandler,
) {
	const listCommand = CliCommand.make("list", {
		state: Options.text("state").pipe(Options.optional),
		kind: Options.text("kind").pipe(Options.optional),
		...navigationScopeOptions,
	}).pipe(
		CliCommand.withHandler(commandHandler(["list"], runListEffect)),
		CliCommand.withDescription("List workflow records."),
	);
	const readyCommand = CliCommand.make("ready", {
		blocked: Options.boolean("blocked").pipe(
			Options.withDescription(
				"List blocked records. JSON output is not supported with --blocked.",
			),
		),
		...navigationWorkOptions,
		...navigationScopeOptions,
	}).pipe(
		CliCommand.withHandler(commandHandler(["ready"], runReadyEffect)),
		CliCommand.withDescription("List ready or blocked workflow records."),
	);
	const nextCommand = CliCommand.make("next", {
		...navigationWorkOptions,
		...navigationScopeOptions,
	}).pipe(
		CliCommand.withHandler(commandHandler(["next"], runNextEffect)),
		CliCommand.withDescription("Select the next workflow record."),
	);
	const treeCommand = CliCommand.make("tree", { record: recordArg }).pipe(
		CliCommand.withHandler(commandHandler(["tree"], runTreeEffect, ["record"])),
		CliCommand.withDescription("Show a record tree."),
	);
	const depsAddCommand = CliCommand.make("add", {
		record: recordArg,
		dependsOn: Options.text("depends-on"),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["deps", "add"], runDepsEffect, ["record"]),
		),
	);
	const depsRemoveCommand = CliCommand.make("remove", {
		record: recordArg,
		dependsOn: Options.text("depends-on"),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["deps", "remove"], runDepsEffect, ["record"]),
		),
	);
	const depsCommand = CliCommand.make("deps", {
		record: Args.optional(recordArg),
	}).pipe(
		CliCommand.withHandler(commandHandler(["deps"], runDepsEffect, ["record"])),
		CliCommand.withDescription("Show or mutate dependencies."),
		CliCommand.withSubcommands([depsAddCommand, depsRemoveCommand]),
	);
	return {
		listCommand,
		readyCommand,
		nextCommand,
		treeCommand,
		depsCommand,
		depsAddCommand,
		depsRemoveCommand,
		registrations: [
			{ path: ["list"], descriptor: listCommand },
			{ path: ["ready"], descriptor: readyCommand },
			{ path: ["next"], descriptor: nextCommand },
			{ path: ["tree"], descriptor: treeCommand },
			{ path: ["deps"], descriptor: depsCommand },
			{ path: ["deps", "add"], descriptor: depsAddCommand },
			{ path: ["deps", "remove"], descriptor: depsRemoveCommand },
		] satisfies ReadonlyArray<CliCommandRegistration>,
	};
}

function runListEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const records = yield* listWorkflowRecordsEffect(storePath);
		const state = stringFlag(parsed.flags.state),
			kind = stringFlag(parsed.flags.kind),
			explicitProject = stringFlag(parsed.flags.project),
			initiative = stringFlag(parsed.flags.initiative);
		const initiativeId =
			initiative === undefined
				? undefined
				: yield* recordIdFromTextEffect(initiative);
		const project =
			explicitProject ??
			(initiativeId === undefined && parsed.flags["all-records"] !== true
				? yield* inferProjectIdForCwdEffect(parsed, storePath)
				: undefined);
		const projectId =
			project === undefined
				? undefined
				: yield* parseProjectIdEffect(project, "project");
		return present(
			records.filter(
				(record) =>
					(state === undefined || record.state === state) &&
					(kind === undefined || record.kind === kind) &&
					(projectId === undefined ||
						recordHasProject(record, records, projectId)) &&
					(initiativeId === undefined ||
						recordBelongsToInitiative(record, initiativeId, records)),
			),
		);
	});
}
function runReadyEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		if (parsed.presentation === "json" && parsed.flags.blocked === true) {
			return yield* Effect.fail(
				usage("forge ready --json cannot be combined with --blocked."),
			);
		}
		const storePath = yield* readyStoreEffect(parsed),
			records = yield* listWorkflowRecordsEffect(storePath),
			options = yield* navigationQueryOptionsEffect(parsed, storePath);
		const diagnoses = yield* listWorkflowRecordReadinessEffect(storePath, {
			...options,
			blocked: parsed.flags.blocked === true,
			includeHitl: parsed.flags["include-hitl"] === true,
			planning: parsed.flags.planning === true,
		});
		return parsed.presentation === "json"
			? present(readyJsonContract(diagnoses, records))
			: present(
					diagnoses,
					0,
					formatReadinessDiagnoses(
						diagnoses,
						records,
						parsed.flags.blocked === true,
					),
				);
	});
}
function runNextEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const record = yield* selectNextWorkflowRecordEffect(storePath, {
			...(yield* navigationQueryOptionsEffect(parsed, storePath)),
			includeHitl: parsed.flags["include-hitl"] === true,
			planning: parsed.flags.planning === true,
		});
		return present(record ?? null);
	});
}
function runTreeEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const id = yield* singleRecordIdEffect(
			parsed.positionals[1],
			parsed.positionals.slice(2),
			"Usage: forge tree <record>",
		);
		const tree = yield* readRecordTreeEffect(
			yield* readyStoreEffect(parsed),
			id,
		);
		return parsed.presentation === "json"
			? present(tree)
			: present(tree, 0, formatRecordTree(tree));
	});
}
function runDepsEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed),
			subcommand = parsed.positionals[1];
		if (subcommand === "add" || subcommand === "remove") {
			const [record, ...tail] = parsed.positionals.slice(2);
			if (record === undefined || tail.length > 0) {
				return yield* Effect.fail(usage("Usage: forge deps <record>"));
			}
			const dependsOn = yield* requiredStringFlagEffect(
				parsed,
				"depends-on",
				"Usage: forge deps <record>",
			);
			const input = {
				storePath,
				recordId: yield* recordIdFromTextEffect(record),
				dependsOn: yield* recordIdFromTextEffect(dependsOn),
			};
			return present(
				subcommand === "add"
					? yield* addWorkflowRecordDependencyEffect(input)
					: yield* removeWorkflowRecordDependencyEffect(input),
			);
		}
		const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				"Usage: forge deps <record>",
			),
			view = yield* readRecordDependencyViewEffect(storePath, id);
		return parsed.presentation === "json"
			? present(view)
			: present(view, 0, formatDependencyView(view));
	});
}

function readyStoreEffect(
	parsed: Parsed,
): Effect.Effect<AbsolutePath, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* resolveStorePathEffect(parsed);
		yield* ensureStoreRootEffect({ storePath });
		return storePath;
	});
}
function resolveStorePathEffect(
	parsed: Parsed,
): Effect.Effect<AbsolutePath, unknown, FileSystem> {
	return Effect.gen(function* () {
		if (parsed.storeOverride !== undefined) {
			return yield* parseAbsolutePathEffect(parsed.storeOverride, "storePath");
		}
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		return (yield* loadForgeConfigEffect({ homeDirectory })).storePath;
	});
}
function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
	});
}
function inferProjectIdForCwdEffect(parsed: Parsed, storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const cwd = yield* parseAbsolutePathEffect(parsed.cwd, "cwd");
		return (yield* inferProjectByPathEffect({ storePath, cwd }))?.id;
	});
}
function navigationQueryOptionsEffect(
	parsed: Parsed,
	storePath: AbsolutePath,
): Effect.Effect<NextRecordOptions, unknown, FileSystem> {
	return Effect.gen(function* () {
		const projectFlag = stringFlag(parsed.flags.project),
			initiativeFlag = stringFlag(parsed.flags.initiative);
		const project =
			projectFlag ??
			(initiativeFlag === undefined && parsed.flags["all-records"] !== true
				? yield* inferProjectIdForCwdEffect(parsed, storePath)
				: undefined);
		return {
			project:
				project === undefined
					? undefined
					: yield* parseProjectIdEffect(project, "project"),
			initiative:
				initiativeFlag === undefined
					? undefined
					: yield* recordIdFromTextEffect(initiativeFlag),
		};
	});
}
function parseProjectIdEffect(value: string, _field: string) {
	return Effect.try({
		try: () => parseProjectId(value),
		catch: (error) => error,
	});
}
function recordIdFromText(value: string): RecordId {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) {
		throw usage(`Invalid record id '${value}'.`);
	}
	return id as RecordId;
}
function recordIdFromTextEffect(value: string) {
	return Effect.try({
		try: () => recordIdFromText(value),
		catch: (error) => error,
	});
}
function singleRecordId(
	value: string | undefined,
	rest: ReadonlyArray<string>,
	message: string,
) {
	if (value === undefined || rest.length > 0) {
		throw usage(message);
	}
	return recordIdFromText(value);
}
function singleRecordIdEffect(
	value: string | undefined,
	rest: ReadonlyArray<string>,
	message: string,
) {
	return Effect.try({
		try: () => singleRecordId(value, rest, message),
		catch: (error) => error,
	});
}
function requiredStringFlagEffect(
	parsed: Parsed,
	name: string,
	message: string,
) {
	return Effect.try({
		try: () => {
			const value = stringFlag(parsed.flags[name]);
			if (value === undefined) {
				throw usage(message);
			}
			return value;
		},
		catch: (error) => error,
	});
}
function stringFlag(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function usage(message: string): ForgeError {
	return new ForgeError({ kind: "config-invalid", message });
}

function readyJsonContract(
	diagnoses: ReadonlyArray<ReadinessDiagnosis>,
	records: ReadonlyArray<WorkflowRecord>,
) {
	const byId = new Map(records.map((record) => [record.id, record]));
	return {
		records: diagnoses.map((diagnosis) => {
			const record = byId.get(diagnosis.recordId);
			if (record === undefined) {
				throw new ForgeError({
					kind: "record-not-found",
					message: `Record '${diagnosis.recordId}' was not found.`,
				});
			}
			return {
				id: record.id,
				kind: record.kind,
				state: record.state,
				title: record.title,
			};
		}),
	};
}
function formatReadinessDiagnoses(
	diagnoses: ReadonlyArray<ReadinessDiagnosis>,
	records: ReadonlyArray<WorkflowRecord>,
	blocked: boolean,
): string {
	if (diagnoses.length === 0) {
		return blocked ? "No blocked records." : "No ready records.";
	}
	const byId = new Map(records.map((record) => [record.id, record]));
	return diagnoses
		.map((diagnosis) => {
			const record = byId.get(diagnosis.recordId);
			const summary = `${diagnosis.recordId}\t${record?.kind ?? "record"}\t${diagnosis.ready ? "ready" : "blocked"}\t${record?.title ?? "(missing record)"}`;
			return diagnosis.reasons.length === 0
				? summary
				: [
						summary,
						...diagnosis.reasons.map((reason) => `  - ${reason.message}`),
					].join("\n");
		})
		.join("\n");
}
function formatRecordTree(node: RecordTreeNode, depth = 0): string {
	return [
		`${"  ".repeat(depth)}${formatRecordSummary(node.record)}`,
		...node.children.map((child) => formatRecordTree(child, depth + 1)),
	].join("\n");
}
function formatDependencyView(view: RecordDependencyView): string {
	const lines = [formatRecordSummary(view.record)];
	if (view.dependsOn.length > 0) {
		lines.push(
			...view.dependsOn.map(
				(record) => `dependsOn\t${formatRecordSummary(record)}`,
			),
		);
	}
	if (view.missingDependencies.length > 0) {
		lines.push(
			...view.missingDependencies.map((id) => `dependsOn\t${id}\tmissing`),
		);
	}
	if (view.dependents.length > 0) {
		lines.push(
			...view.dependents.map(
				(record) => `dependent\t${formatRecordSummary(record)}`,
			),
		);
	}
	return lines.join("\n");
}
function formatRecordSummary(record: RecordFrontmatter): string {
	return `${record.id}\t${record.kind}\t${record.state}\t${record.title}`;
}
function recordHasProject(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
	projectId: ProjectId,
): boolean {
	if (record.scope.type === "project") {
		return record.scope.project === projectId;
	}
	if (record.scope.type === "project-set") {
		return record.scope.projects.includes(projectId);
	}
	if (record.parent === null) {
		return false;
	}
	const parent = records.find((candidate) => candidate.id === record.parent);
	return parent === undefined
		? false
		: recordHasProject(parent, records, projectId);
}
function recordBelongsToInitiative(
	record: WorkflowRecord,
	initiativeId: RecordId,
	records: ReadonlyArray<WorkflowRecord>,
): boolean {
	if (record.kind === "initiative") {
		return record.id === initiativeId;
	}
	if (record.initiative !== null) {
		return record.initiative === initiativeId;
	}
	if (record.scope.type === "initiative") {
		return record.scope.initiative === initiativeId;
	}
	if (record.parent === null) {
		return false;
	}
	const parent = records.find((candidate) => candidate.id === record.parent);
	return parent === undefined
		? false
		: recordBelongsToInitiative(parent, initiativeId, records);
}
