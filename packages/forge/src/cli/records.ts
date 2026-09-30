import * as PlatformCommand from "@effect/platform/Command";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { FileSystem } from "@effect/platform/FileSystem";
import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { Effect } from "effect";
import {
	fallbackEditor,
	readNodeStreamTextEffect,
	uniqueNodeProcessSuffix,
} from "../cli-node.ts";
import {
	parseAbsolutePath,
	parseProjectId,
	type AbsolutePath,
} from "../domain.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
	readTextFileEffect,
} from "../filesystem-store.ts";
import { inferProjectByPathEffect } from "../project-registry.ts";
import {
	parseRecordId,
	type RecordComment,
	type RecordFrontmatter,
	type RecordId,
	type RecordKind,
	type RecordUpdate,
	type TaskSubkind,
	type WorkflowRecord,
} from "../record-domain.ts";
import {
	completeWorkflowRecordEffect,
	createWorkflowRecordEffect,
	listRecordCommentsEffect,
	listRecordUpdatesEffect,
	locateWorkflowRecordEffect,
	readRecordDependencyViewEffect,
	readRecordRelationshipsEffect,
	readRecordTreeEffect,
	readWorkflowRecordEffect,
	replaceWorkflowRecordFromEditedMarkdownEffect,
	startWorkflowRecordEffect,
} from "../record-store.ts";
import { recordFilePath } from "../store-paths.ts";
import {
	formatRecordComments,
	formatRecordUpdates,
	latestRecordComment,
} from "./comments.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
import type {
	CliCommandRegistration,
	CommandOutput,
	FlagValue,
	Parsed,
} from "./types.ts";

type CommandHandler = typeof buildCommandHandler;

type HelpResolver = (command: string) => string;

const presentationOptions = {
	json: Options.boolean("json").pipe(
		Options.withDescription("Render command output as JSON."),
	),
};
const recordArg = Args.text({ name: "record" });
const bodyOptions = {
	body: Options.text("body").pipe(Options.optional),
	bodyFile: Options.text("body-file").pipe(Options.optional),
};
const descriptionOptions = {
	description: Options.text("description").pipe(Options.optional),
	descriptionFile: Options.text("description-file").pipe(Options.optional),
};
const newScopeOptions = {
	project: Options.text("project").pipe(Options.optional),
	projects: Options.text("projects").pipe(Options.optional),
	initiative: Options.text("initiative").pipe(Options.optional),
	scope: Options.text("scope").pipe(Options.optional),
};
const titleOption = Options.text("title");
const dependsOnOption = Options.text("depends-on").pipe(
	Options.repeated,
	Options.withDescription("Record dependency id; may be repeated."),
);
const recentCommentLimit = 3;
const recentUpdateLimit = 5;

type SummaryChild = {
	readonly record: RecordFrontmatter;
	readonly dependsOn: ReadonlyArray<RecordFrontmatter>;
	readonly missingDependencies: ReadonlyArray<RecordId>;
	readonly latestComment: RecordComment | null;
};

type RecordSummaryView = {
	readonly record: RecordFrontmatter;
	readonly dependsOn: ReadonlyArray<RecordFrontmatter>;
	readonly missingDependencies: ReadonlyArray<RecordId>;
	readonly latestComment: RecordComment | null;
	readonly children: ReadonlyArray<SummaryChild>;
};

type SummaryRecordFact = {
	readonly id: RecordId;
	readonly title: string;
	readonly kind: RecordKind;
	readonly subkind: TaskSubkind | null;
	readonly state: RecordFrontmatter["state"];
	readonly resolution: string | null;
	readonly scope: RecordFrontmatter["scope"];
	readonly parent: RecordId | null;
	readonly initiative: RecordId | null;
	readonly generatedBy: RecordId | null;
	readonly tags: ReadonlyArray<string>;
	readonly createdAt: string;
	readonly updatedAt: string;
};

type SummaryDependencyFacts = {
	readonly dependsOn: ReadonlyArray<SummaryRecordFact>;
	readonly missing: ReadonlyArray<RecordId>;
	readonly blockers: {
		readonly records: ReadonlyArray<SummaryRecordFact>;
		readonly missing: ReadonlyArray<RecordId>;
	};
};

type JsonSummaryChild = {
	readonly record: SummaryRecordFact;
	readonly dependencies: SummaryDependencyFacts;
	readonly latestComment: RecordComment | null;
};

type JsonRecordSummaryView = {
	readonly record: SummaryRecordFact;
	readonly dependencies: SummaryDependencyFacts;
	readonly latestComment: RecordComment | null;
	readonly children: ReadonlyArray<JsonSummaryChild>;
};

export function createRecordsCommands(
	commandHandler: CommandHandler = buildCommandHandler,
	help: HelpResolver = (command) => `Usage: forge ${command}`,
) {
	const commandHelp: Record<string, string> = new Proxy(Object.create(null), {
		get: (_target, property) => help(String(property)),
	});
	const runNewEffect = createRunNewEffect(commandHelp);
	const runShowEffect = createRunShowEffect(commandHelp);
	const runSummaryEffect = createRunSummaryEffect(commandHelp);
	const runStartEffect = createRunStartEffect(commandHelp);
	const runDoneEffect = createRunDoneEffect(commandHelp);
	const runOpenEffect = createRunOpenEffect(commandHelp);
	const runEditEffect = createRunEditEffect(commandHelp);

	const newRecordCommand = (
		kind: "initiative" | "wayfinder" | "spec" | "task" | "grilling",
	) => {
		if (kind === "task" || kind === "grilling") {
			return CliCommand.make(kind, {
				title: titleOption,
				...descriptionOptions,
				parent: Options.text("parent"),
				kind: Options.choice("kind", [
					"research",
					"prototype",
					"review",
				] as const).pipe(Options.optional),
				dependsOn: dependsOnOption,
			}).pipe(
				CliCommand.withHandler(commandHandler(["new", kind], runNewEffect)),
			);
		}
		return CliCommand.make(kind, {
			title: titleOption,
			...bodyOptions,
			...newScopeOptions,
			generatedBy: Options.text("generated-by").pipe(Options.optional),
		}).pipe(
			CliCommand.withHandler(commandHandler(["new", kind], runNewEffect)),
		);
	};
	const newInitiativeCommand = newRecordCommand("initiative");
	const newWayfinderCommand = newRecordCommand("wayfinder");
	const newSpecCommand = newRecordCommand("spec");
	const newTaskCommand = newRecordCommand("task");
	const newGrillingCommand = newRecordCommand("grilling");
	const newCommand = CliCommand.make("new").pipe(
		CliCommand.withDescription("Create Forge records."),
		CliCommand.withSubcommands([
			newInitiativeCommand,
			newWayfinderCommand,
			newSpecCommand,
			newTaskCommand,
			newGrillingCommand,
		]),
	);
	const showCommand = CliCommand.make("show", {
		record: recordArg,
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(commandHandler(["show"], runShowEffect, ["record"])),
		CliCommand.withDescription("Show a Forge record."),
	);
	const summaryCommand = CliCommand.make("summary", {
		record: recordArg,
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["summary"], runSummaryEffect, ["record"]),
		),
		CliCommand.withDescription(
			"Summarize a Forge record and its direct children.",
		),
	);
	const startCommand = CliCommand.make("start", {
		record: recordArg,
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["start"], runStartEffect, ["record"]),
		),
		CliCommand.withDescription("Start a Forge record."),
	);
	const doneCommand = CliCommand.make("done", {
		record: recordArg,
		resolution: Options.text("resolution"),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(commandHandler(["done"], runDoneEffect, ["record"])),
		CliCommand.withDescription("Complete a Forge record."),
	);
	const openCommand = CliCommand.make("open", { record: recordArg }).pipe(
		CliCommand.withHandler(commandHandler(["open"], runOpenEffect, ["record"])),
		CliCommand.withDescription("Open a record file."),
	);
	const editCommand = CliCommand.make("edit", { record: recordArg }).pipe(
		CliCommand.withHandler(commandHandler(["edit"], runEditEffect, ["record"])),
		CliCommand.withDescription("Edit a record file."),
	);

	return {
		newCommand,
		newInitiativeCommand,
		newWayfinderCommand,
		newSpecCommand,
		newTaskCommand,
		newGrillingCommand,
		showCommand,
		summaryCommand,
		startCommand,
		doneCommand,
		openCommand,
		editCommand,
		registrations: [
			{ path: ["new"], descriptor: newCommand },
			{ path: ["new", "initiative"], descriptor: newInitiativeCommand },
			{ path: ["new", "wayfinder"], descriptor: newWayfinderCommand },
			{ path: ["new", "spec"], descriptor: newSpecCommand },
			{ path: ["new", "task"], descriptor: newTaskCommand },
			{ path: ["new", "grilling"], descriptor: newGrillingCommand },
			{ path: ["show"], descriptor: showCommand },
			{ path: ["summary"], descriptor: summaryCommand },
			{ path: ["start"], descriptor: startCommand },
			{ path: ["done"], descriptor: doneCommand },
			{ path: ["open"], descriptor: openCommand },
			{ path: ["edit"], descriptor: editCommand },
		] satisfies ReadonlyArray<CliCommandRegistration>,
	};
}

function createRunNewEffect(commandHelp: Record<string, string>) {
	return function runNewEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const title = yield* requiredStringFlagEffect(
				parsed,
				"title",
				commandHelp.new,
			);
			const kind = yield* parseNewKindEffect(
				parsed.positionals[1],
				commandHelp,
			);
			const parentId = yield* optionalRecordIdFlagEffect(parsed, "parent");
			const parent =
				parentId === undefined
					? undefined
					: yield* readWorkflowRecordEffect(storePath, parentId);
			const body = yield* readProseEffect(
				parsed,
				kind === "task" || kind === "grilling" ? "description" : "body",
			);
			const explicitProject = getOptionalStringFlag(parsed, "project");
			const project =
				explicitProject ??
				(kind === "spec"
					? yield* inferProjectIdForCwdEffect(parsed, storePath)
					: undefined);
			const projects = getOptionalStringFlag(parsed, "projects");
			const initiative = getOptionalStringFlag(parsed, "initiative");
			const generatedBy = getOptionalStringFlag(parsed, "generated-by");
			const scope = getOptionalStringFlag(parsed, "scope");
			const recordInput = yield* Effect.try({
				try: () => ({
					title,
					kind,
					subkind:
						kind === "task"
							? parseTaskSubkind(getOptionalStringFlag(parsed, "kind"))
							: null,
					scope: scopeForNewRecord({
						kind,
						project,
						projects,
						initiative,
						scope,
						parent,
						commandHelp,
					}),
					parent: parentId ?? null,
					initiative:
						initiative === undefined ? null : parseRecordId(Number(initiative)),
					dependsOn: recordIdsFromFlag(parsed, "depends-on"),
					generatedBy:
						generatedBy === undefined
							? null
							: parseRecordId(Number(generatedBy)),
					tags: [],
					profile: null,
					body,
				}),
				catch: (error) => error,
			});
			const record = yield* createWorkflowRecordEffect({
				storePath,
				input: recordInput,
			});
			return present(record);
		});
	};
}

function createRunShowEffect(commandHelp: Record<string, string>) {
	return function runShowEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				commandHelp.show,
			);
			const storePath = yield* readyStoreEffect(parsed);
			const record = yield* readWorkflowRecordEffect(storePath, id);
			const relationships = yield* readRecordRelationshipsEffect(storePath);
			const recentComments = yield* listRecordCommentsEffect(
				storePath,
				record.id,
			);
			const recentUpdates = yield* listRecordUpdatesEffect(
				storePath,
				record.id,
			);
			const shown = {
				...record,
				relationships: relationships[String(record.id)] ?? null,
				recentComments: recentComments.slice(-recentCommentLimit),
				recentUpdates: recentUpdates.slice(-recentUpdateLimit),
			};
			if (parsed.presentation === "json") {
				return present(shown);
			}
			return present(shown, 0, formatShownRecord(shown));
		});
	};
}

function createRunSummaryEffect(commandHelp: Record<string, string>) {
	return function runSummaryEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				commandHelp.summary,
			);
			const storePath = yield* readyStoreEffect(parsed);
			const tree = yield* readRecordTreeEffect(storePath, id);
			const parentDependencyView = yield* readRecordDependencyViewEffect(
				storePath,
				tree.record.id,
			);
			const parentComments = yield* listRecordCommentsEffect(
				storePath,
				tree.record.id,
			);
			const children = yield* Effect.all(
				tree.children.map((child) =>
					Effect.gen(function* () {
						const dependencyView = yield* readRecordDependencyViewEffect(
							storePath,
							child.record.id,
						);
						const comments = yield* listRecordCommentsEffect(
							storePath,
							child.record.id,
						);
						return {
							record: child.record,
							dependsOn: dependencyView.dependsOn,
							missingDependencies: dependencyView.missingDependencies,
							latestComment: latestRecordComment(comments),
						};
					}),
				),
			);
			const summary: RecordSummaryView = {
				record: tree.record,
				dependsOn: parentDependencyView.dependsOn,
				missingDependencies: parentDependencyView.missingDependencies,
				latestComment: latestRecordComment(parentComments),
				children,
			};
			if (parsed.presentation === "json") {
				return present(toJsonRecordSummaryView(summary));
			}
			return present(summary, 0, formatRecordSummaryView(summary));
		});
	};
}

function createRunStartEffect(commandHelp: Record<string, string>) {
	return function runStartEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				commandHelp.start,
			);
			const storePath = yield* readyStoreEffect(parsed);
			const record = yield* startWorkflowRecordEffect({
				storePath,
				recordId: id,
			});
			return present(record);
		});
	};
}

function createRunDoneEffect(commandHelp: Record<string, string>) {
	return function runDoneEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				commandHelp.done,
			);
			const resolution = yield* requiredStringFlagEffect(
				parsed,
				"resolution",
				commandHelp.done,
			);
			const storePath = yield* readyStoreEffect(parsed);
			const record = yield* completeWorkflowRecordEffect({
				storePath,
				recordId: id,
				resolution,
			});
			return present(record);
		});
	};
}

function createRunOpenEffect(commandHelp: Record<string, string>) {
	return function runOpenEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				commandHelp.open,
			);
			const storePath = yield* readyStoreEffect(parsed);
			const locator = yield* locateWorkflowRecordEffect(storePath, id);
			return present(recordFilePath(storePath, locator.kind, id));
		});
	};
}

function createRunEditEffect(commandHelp: Record<string, string>) {
	return function runEditEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, CommandExecutor | FileSystem> {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				commandHelp.edit,
			);
			const storePath = yield* readyStoreEffect(parsed);
			const locator = yield* locateWorkflowRecordEffect(storePath, id);
			const filePath = recordFilePath(storePath, locator.kind, id);
			const temporaryPath = yield* recordEditTemporaryPathEffect(filePath);
			const markdown = yield* editTemporaryFileEffect(
				temporaryPath,
				yield* readTextFileEffect(filePath),
				parsed,
			);
			const edited = yield* replaceWorkflowRecordFromEditedMarkdownEffect({
				storePath,
				recordId: id,
				markdown,
			});
			return present({ updated: true, record: edited });
		});
	};
}

function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
	});
}

function inferProjectIdForCwdEffect(
	parsed: Parsed,
	storePath: AbsolutePath,
): Effect.Effect<string | undefined, unknown, FileSystem> {
	return Effect.gen(function* () {
		const cwd = yield* parseAbsolutePathEffect(parsed.cwd, "cwd");
		return (yield* inferProjectByPathEffect({ storePath, cwd }))?.id;
	});
}

function parseNewKind(
	value: string | undefined,
	commandHelp: Record<string, string>,
): RecordKind {
	if (
		value === "initiative" ||
		value === "wayfinder" ||
		value === "spec" ||
		value === "task" ||
		value === "grilling"
	) {
		return value;
	}
	throw usage(commandHelp.new);
}

function parseNewKindEffect(
	value: string | undefined,
	commandHelp: Record<string, string>,
) {
	return Effect.try({
		try: () => parseNewKind(value, commandHelp),
		catch: (error) => error,
	});
}

function parseTaskSubkind(value: string | undefined): TaskSubkind | null {
	if (value === undefined) {
		return null;
	}
	if (value === "research" || value === "prototype" || value === "review") {
		return value;
	}
	throw usage("Task kind must be research, prototype, or review.");
}

function requiredStringFlagEffect(
	parsed: Parsed,
	name: string,
	message: string,
) {
	return Effect.try({
		try: () => getRequiredFlag(parsed, name, message),
		catch: (error) => error,
	});
}

function optionalRecordIdFlagEffect(parsed: Parsed, name: string) {
	return Effect.try({
		try: () => {
			const value = getOptionalStringFlag(parsed, name);
			return value === undefined ? undefined : parseRecordId(Number(value));
		},
		catch: (error) => error,
	});
}

type ProseField = "body" | "description" | "message";

type ProseInput =
	| { readonly source: "file"; readonly path: string }
	| { readonly source: "stdin" }
	| { readonly source: "inline"; readonly text: string };

function readProseEffect(
	parsed: Parsed,
	field: ProseField,
): Effect.Effect<string, unknown, FileSystem> {
	return Effect.gen(function* () {
		const input = resolveProseInput(parsed, field);
		if (input.source === "file") {
			return yield* readTextFileEffect(input.path);
		}
		if (input.source === "stdin") {
			return yield* readNodeStreamTextEffect(parsed.stdin);
		}
		return input.text;
	});
}

function resolveProseInput(parsed: Parsed, field: ProseField): ProseInput {
	const inline = getOptionalStringFlag(parsed, field);
	const file = getOptionalStringFlag(parsed, `${field}-file`);
	if ((inline === undefined) === (file === undefined)) {
		throw proseInputUsage(field);
	}
	if (file !== undefined) {
		return { source: "file", path: file };
	}
	if (inline === undefined) {
		throw proseInputUsage(field);
	}
	return inline === "-"
		? { source: "stdin" }
		: { source: "inline", text: inline };
}

function proseInputUsage(field: ProseField): ForgeError {
	return usage(
		`Provide exactly one of --${field} <md>, --${field}-file <file>, or --${field} -.`,
	);
}

function scopeForNewRecord(options: {
	readonly kind: RecordKind;
	readonly project?: string;
	readonly projects?: string;
	readonly initiative?: string;
	readonly scope?: string;
	readonly parent?: WorkflowRecord;
	readonly commandHelp: Record<string, string>;
}) {
	if (options.kind === "task" || options.kind === "grilling") {
		if (options.parent === undefined) {
			throw usage(options.commandHelp.new);
		}
		return options.parent.scope;
	}
	if (options.kind === "initiative") {
		if (options.projects === undefined) {
			throw usage("forge new initiative requires --projects <ids>.");
		}
		return {
			type: "project-set" as const,
			projects: options.projects
				.split(",")
				.map((project) => parseProjectId(project.trim()))
				.sort(),
		};
	}
	if (options.project !== undefined) {
		return {
			type: "project" as const,
			project: parseProjectId(options.project),
		};
	}
	if (options.projects !== undefined) {
		return {
			type: "project-set" as const,
			projects: options.projects
				.split(",")
				.map((project) => parseProjectId(project.trim())),
		};
	}
	if (options.initiative !== undefined && options.kind === "wayfinder") {
		return {
			type: "initiative" as const,
			initiative: parseRecordId(Number(options.initiative)),
		};
	}
	if (options.scope !== undefined && options.scope !== "global") {
		throw usage("Only --scope global is supported in Phase 2.");
	}
	if (options.kind === "wayfinder") {
		return { type: "global" as const };
	}
	throw usage("forge new spec requires --project <id>.");
}

function singleRecordId(
	value: string | undefined,
	rest: ReadonlyArray<string>,
	message: string,
): RecordId {
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

function recordIdFromText(value: string): RecordId {
	return parseRecordId(Number(value));
}

function recordIdsFromFlag(
	parsed: Parsed,
	name: string,
): ReadonlyArray<RecordId> {
	return getStringArrayFlag(parsed, name).map(recordIdFromText);
}

function formatShownRecord(
	record: WorkflowRecord & {
		readonly relationships: {
			readonly parent: number | null;
			readonly children: ReadonlyArray<number>;
			readonly initiativeMembers: ReadonlyArray<number>;
			readonly dependsOn: ReadonlyArray<number>;
			readonly dependents: ReadonlyArray<number>;
		} | null;
		readonly recentComments?: ReadonlyArray<RecordComment>;
		readonly recentUpdates?: ReadonlyArray<RecordUpdate>;
	},
): string {
	const relationships = record.relationships;
	return [
		`${record.id}\t${record.kind}\t${record.state}\t${record.title}`,
		`scope\t${formatScope(record)}`,
		record.parent === null ? undefined : `parent\t${record.parent}`,
		record.initiative === null ? undefined : `initiative\t${record.initiative}`,
		relationships === null || relationships.children.length === 0
			? undefined
			: `children\t${relationships.children.join(", ")}`,
		relationships === null || relationships.initiativeMembers.length === 0
			? undefined
			: `initiativeMembers\t${relationships.initiativeMembers.join(", ")}`,
		record.dependsOn.length === 0
			? undefined
			: `dependsOn\t${record.dependsOn.join(", ")}`,
		"",
		record.body.trimEnd(),
		record.recentComments === undefined || record.recentComments.length === 0
			? undefined
			: `\nRecent comments\n${formatRecordComments(record.recentComments)}`,
		record.recentUpdates === undefined || record.recentUpdates.length === 0
			? undefined
			: `\nRecent updates\n${formatRecordUpdates(record.recentUpdates)}`,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

function formatRecordSummaryView(summary: RecordSummaryView): string {
	return [
		formatRecordSummaryWithResolution(summary.record),
		summary.children.length === 0 ? undefined : "children",
		...summary.children.flatMap(formatSummaryChild),
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

function formatSummaryChild(child: SummaryChild): ReadonlyArray<string> {
	return [
		formatRecordSummaryWithResolution(child.record),
		...child.dependsOn.map(
			(record) => `  dependsOn\t${formatRecordSummaryWithResolution(record)}`,
		),
		...child.missingDependencies.map((id) => `  dependsOn\t${id}\tmissing`),
		...(child.latestComment === null
			? []
			: [
					`  latestComment\t${child.latestComment.id}\t${formatInlineCommentBody(child.latestComment.body)}`,
				]),
	];
}

function toJsonRecordSummaryView(
	summary: RecordSummaryView,
): JsonRecordSummaryView {
	return {
		record: toSummaryRecordFact(summary.record),
		dependencies: toSummaryDependencyFacts(
			summary.dependsOn,
			summary.missingDependencies,
		),
		latestComment: summary.latestComment,
		children: summary.children.map((child) => ({
			record: toSummaryRecordFact(child.record),
			dependencies: toSummaryDependencyFacts(
				child.dependsOn,
				child.missingDependencies,
			),
			latestComment: child.latestComment,
		})),
	};
}

function toSummaryDependencyFacts(
	dependsOn: ReadonlyArray<RecordFrontmatter>,
	missing: ReadonlyArray<RecordId>,
): SummaryDependencyFacts {
	const dependencyFacts = dependsOn.map(toSummaryRecordFact);
	return {
		dependsOn: dependencyFacts,
		missing,
		blockers: {
			records: dependencyFacts.filter((record) => record.state !== "done"),
			missing,
		},
	};
}

function toSummaryRecordFact(record: RecordFrontmatter): SummaryRecordFact {
	return {
		id: record.id,
		title: record.title,
		kind: record.kind,
		subkind: record.subkind,
		state: record.state,
		resolution: record.resolution,
		scope: record.scope,
		parent: record.parent,
		initiative: record.initiative,
		generatedBy: record.generatedBy,
		tags: record.tags,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function formatInlineCommentBody(body: string): string {
	return body.trimEnd().replace(/\n/g, "\\n");
}

function formatRecordSummaryWithResolution(record: RecordFrontmatter): string {
	return [
		String(record.id),
		record.kind,
		record.state,
		...(record.resolution === null ? [] : [record.resolution]),
		record.title,
	].join("\t");
}

function formatScope(record: WorkflowRecord): string {
	if (record.scope.type === "project") {
		return `project:${record.scope.project}`;
	}
	if (record.scope.type === "project-set") {
		return `projects:${record.scope.projects.join(",")}`;
	}
	if (record.scope.type === "initiative") {
		return `initiative:${record.scope.initiative}`;
	}
	return "global";
}

function recordEditTemporaryPathEffect(filePath: AbsolutePath) {
	return Effect.try({
		try: () =>
			parseAbsolutePath(
				`${filePath}.edit-${uniqueNodeProcessSuffix()}`,
				"temporaryPath",
			),
		catch: (error) => error,
	});
}

function editTemporaryFileEffect(
	filePath: AbsolutePath,
	initialContent: string,
	parsed: Parsed,
) {
	return Effect.gen(function* () {
		yield* writeFileStringEffect(filePath, initialContent);
		yield* runEditorEffect(filePath, parsed);
		return yield* readTextFileEffect(filePath);
	}).pipe(
		Effect.ensuring(removeFileIfExistsEffect(filePath).pipe(Effect.ignore)),
	);
}

function writeFileStringEffect(filePath: AbsolutePath, content: string) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		yield* fileSystem.writeFileString(filePath, content);
	});
}

function removeFileIfExistsEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		yield* fileSystem.remove(filePath, { recursive: false }).pipe(
			Effect.catchIf(
				(error) => isMissingFileSystemError(error),
				() => Effect.void,
			),
		);
	});
}

function isMissingFileSystemError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"_tag" in error &&
		error._tag === "SystemError" &&
		"reason" in error &&
		error.reason === "NotFound"
	);
}

function runEditorEffect(filePath: AbsolutePath, parsed: Parsed) {
	const editor = fallbackEditor(parsed.env);
	if (editor === undefined || editor.trim() === "") {
		return Effect.fail(usage("EDITOR must be set to edit records."));
	}
	return PlatformCommand.make(`${editor} ${shellQuote(filePath)}`).pipe(
		PlatformCommand.runInShell(true),
		PlatformCommand.stdin("inherit"),
		PlatformCommand.stdout("inherit"),
		PlatformCommand.stderr("inherit"),
		PlatformCommand.env(parsed.env),
		PlatformCommand.exitCode,
		Effect.flatMap((exitCode) => {
			const code = Number(exitCode);
			return code === 0
				? Effect.void
				: Effect.fail(
						new ForgeError({
							kind: "config-invalid",
							message: `Editor exited with code ${code}.`,
						}),
					);
		}),
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
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
		const config = yield* loadForgeConfigEffect({ homeDirectory });
		return config.storePath;
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

function getRequiredFlag(
	parsed: Parsed,
	name: string,
	message: string,
): string {
	const value = getOptionalStringFlag(parsed, name);
	if (value === undefined) {
		throw usage(message);
	}
	return value;
}

function getOptionalStringFlag(
	parsed: Parsed,
	name: string,
): string | undefined {
	return stringFlag(parsed.flags[name]);
}

function getStringArrayFlag(
	parsed: Parsed,
	name: string,
): ReadonlyArray<string> {
	const value = parsed.flags[name];
	if (Array.isArray(value)) {
		return value;
	}
	return typeof value === "string" ? [value] : [];
}

function stringFlag(value: FlagValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function usage(message: string): ForgeError {
	return new ForgeError({ kind: "config-invalid", message });
}
