#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { text as readStreamText } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as PlatformCommand from "@effect/platform/Command";
import { FileSystem } from "@effect/platform/FileSystem";
import * as Args from "@effect/cli/Args";
import * as CliApp from "@effect/cli/CliApp";
import * as CliCommand from "@effect/cli/Command";
import * as CliConfig from "@effect/cli/CliConfig";
import * as HelpDoc from "@effect/cli/HelpDoc";
import * as Options from "@effect/cli/Options";
import * as ValidationError from "@effect/cli/ValidationError";
import { Effect } from "effect";

import {
	decodeConfigSetInput,
	decodeProjectAddInput,
	decodeProjectRootInput,
} from "./command-inputs.ts";
import {
	parseAbsolutePath,
	parseProjectId,
	type AbsolutePath,
} from "./domain.ts";
import { ForgeError, isForgeError } from "./errors.ts";
import {
	ensureStoreRoot,
	ensureStoreRootEffect,
	loadForgeConfig,
	loadForgeConfigEffect,
	readTextFile,
	readTextFileEffect,
	storeDoctor,
	storeDoctorEffect,
	writeForgeConfig,
	writeForgeConfigEffect,
} from "./filesystem-store.ts";
import {
	addProject,
	addProjectEffect,
	addProjectRoot,
	addProjectRootEffect,
	inferProjectByPath,
	inferProjectByPathEffect,
	listProjectsEffect,
	removeProject,
	removeProjectEffect,
	removeProjectRoot,
	removeProjectRootEffect,
} from "./project-registry.ts";
import {
	parseRecordId,
	type CommentId,
	type NextRecordOptions,
	type ReadinessDiagnosis,
	type RecordComment,
	type RecordDependencyView,
	type RecordFrontmatter,
	type RecordHistoryEntry,
	type RecordKind,
	type RecordId,
	type RecordTreeNode,
	type RecordUpdate,
	type TaskSubkind,
	type WorkflowRecord,
} from "./record-domain.ts";
import {
	addRecordComment,
	completeWorkflowRecord,
	createWorkflowRecord,
	formatRecordCommentMarkdown,
	listRecordComments,
	listRecordHistory,
	listRecordUpdates,
	listWorkflowRecords,
	locateWorkflowRecord,
	addInitiativeDeclaredProject,
	addWorkflowRecordDependency,
	attachWorkflowRecordToInitiative,
	detachWorkflowRecordFromInitiative,
	listWorkflowRecordReadiness,
	readRecordDependencyView,
	readRecordRelationships,
	readRecordTree,
	readWorkflowRecord,
	removeInitiativeDeclaredProject,
	removeWorkflowRecordDependency,
	replaceRecordCommentFromEditedMarkdown,
	replaceWorkflowRecordFromEditedMarkdown,
	selectNextWorkflowRecord,
	startWorkflowRecord,
} from "./record-store.ts";
import { runForgeMain, runForgePromise } from "./runtime.ts";
import { recordFilePath } from "./store-paths.ts";

export type CliOptions = {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdin?: NodeJS.ReadableStream;
	readonly stdout?: Pick<NodeJS.WriteStream, "write">;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
};

type Presentation = "human" | "json";

type FlagValue = string | boolean | ReadonlyArray<string>;

type CliInvocationContext = {
	readonly presentation: Presentation;
	readonly cwd: string;
	readonly homeDirectory: string;
	readonly storeOverride?: string;
	readonly stdin: NodeJS.ReadableStream;
	readonly stdout: Pick<NodeJS.WriteStream, "write">;
	readonly stderr: Pick<NodeJS.WriteStream, "write">;
	readonly env: NodeJS.ProcessEnv;
};

type CommandOutput = {
	readonly value: unknown;
	readonly code: number;
	readonly human?: string;
};

type Parsed = CliInvocationContext & {
	readonly positionals: ReadonlyArray<string>;
	readonly flags: Readonly<Record<string, FlagValue>>;
};

const forgeRootOptions = {
	json: Options.boolean("json").pipe(
		Options.withDescription("Render command output as JSON."),
	),
	store: Options.text("store").pipe(
		Options.optional,
		Options.withDescription("Override the Forge store path."),
	),
	cwd: Options.text("cwd").pipe(
		Options.withAlias("C"),
		Options.optional,
		Options.withDescription("Override the invocation working directory."),
	),
};

const presentationOptions = {
	json: Options.boolean("json").pipe(
		Options.withDescription("Render command output as JSON."),
	),
};

const configGetCommand = CliCommand.make("get", {
	key: Args.optional(Args.text({ name: "storePath" })),
	...presentationOptions,
}).pipe(
	CliCommand.withDescription("Print the Forge config or a config value."),
);
const configSetCommand = CliCommand.make("set", {
	key: Args.text({ name: "storePath" }),
	value: Args.text({ name: "absolute-path" }),
	...presentationOptions,
}).pipe(CliCommand.withDescription("Set a Forge config value."));
const configCommand = CliCommand.make("config").pipe(
	CliCommand.withDescription("Read or update Forge CLI configuration."),
	CliCommand.withSubcommands([configGetCommand, configSetCommand]),
);

const storePathCommand = CliCommand.make("path").pipe(
	CliCommand.withDescription("Print the active Forge store path."),
);
const storeDoctorCommand = CliCommand.make("doctor").pipe(
	CliCommand.withDescription("Validate the active Forge store."),
);
const storeCommand = CliCommand.make("store").pipe(
	CliCommand.withDescription("Inspect the configured Forge store."),
	CliCommand.withSubcommands([storePathCommand, storeDoctorCommand]),
);

const projectAddCommand = CliCommand.make("add", {
	id: Args.text({ name: "id" }),
	root: Options.text("root").pipe(
		Options.withDescription("Project root path."),
	),
	name: Options.text("name").pipe(
		Options.optional,
		Options.withDescription("Human-readable project name."),
	),
	remote: Options.text("remote").pipe(
		Options.optional,
		Options.withDescription("Project remote URL."),
	),
}).pipe(CliCommand.withDescription("Register a Forge project."));
const projectRootAddCommand = CliCommand.make("add", {
	id: Args.text({ name: "id" }),
	root: Args.text({ name: "path" }),
}).pipe(CliCommand.withDescription("Add a root to a project."));
const projectRootRemoveCommand = CliCommand.make("remove", {
	id: Args.text({ name: "id" }),
	root: Args.text({ name: "path" }),
}).pipe(CliCommand.withDescription("Remove a root from a project."));
const projectRootCommand = CliCommand.make("root").pipe(
	CliCommand.withDescription("Add or remove project roots."),
	CliCommand.withSubcommands([projectRootAddCommand, projectRootRemoveCommand]),
);
const projectRemoveCommand = CliCommand.make("remove", {
	id: Args.text({ name: "id" }),
}).pipe(CliCommand.withDescription("Remove a Forge project."));
const projectCommand = CliCommand.make("project").pipe(
	CliCommand.withDescription("Register and maintain Forge projects."),
	CliCommand.withSubcommands([
		projectAddCommand,
		projectRootCommand,
		projectRemoveCommand,
	]),
);

const projectsCommand = CliCommand.make("projects").pipe(
	CliCommand.withDescription("List registered Forge projects."),
);

const hereCommand = CliCommand.make("here").pipe(
	CliCommand.withDescription(
		"Infer the Forge project for the current directory.",
	),
);

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
		});
	}
	return CliCommand.make(kind, {
		title: titleOption,
		...bodyOptions,
		...newScopeOptions,
		generatedBy: Options.text("generated-by").pipe(Options.optional),
	});
};
const newCommand = CliCommand.make("new").pipe(
	CliCommand.withDescription("Create Forge records."),
	CliCommand.withSubcommands([
		newRecordCommand("initiative"),
		newRecordCommand("wayfinder"),
		newRecordCommand("spec"),
		newRecordCommand("task"),
		newRecordCommand("grilling"),
	]),
);
const showCommand = CliCommand.make("show", {
	record: recordArg,
	...presentationOptions,
}).pipe(CliCommand.withDescription("Show a Forge record."));
const startCommand = CliCommand.make("start", {
	record: recordArg,
	...presentationOptions,
}).pipe(CliCommand.withDescription("Start a Forge record."));
const doneCommand = CliCommand.make("done", {
	record: recordArg,
	resolution: Options.text("resolution"),
	...presentationOptions,
}).pipe(CliCommand.withDescription("Complete a Forge record."));
const commentCommand = CliCommand.make("comment", {
	record: Args.optional(recordArg),
	message: Options.text("message").pipe(Options.optional),
	messageFile: Options.text("message-file").pipe(Options.optional),
}).pipe(
	CliCommand.withDescription("Add or edit record comments."),
	CliCommand.withSubcommands([
		CliCommand.make("edit", {
			record: recordArg,
			comment: Args.text({ name: "comment" }),
		}).pipe(CliCommand.withDescription("Edit a record comment.")),
	]),
);
const commentsCommand = CliCommand.make("comments", { record: recordArg }).pipe(
	CliCommand.withDescription("List record comments."),
);
const updatesCommand = CliCommand.make("updates", { record: recordArg }).pipe(
	CliCommand.withDescription("List record updates."),
);
const historyCommand = CliCommand.make("history", { record: recordArg }).pipe(
	CliCommand.withDescription("List record history."),
);
const openCommand = CliCommand.make("open", { record: recordArg }).pipe(
	CliCommand.withDescription("Open a record file."),
);
const editCommand = CliCommand.make("edit", { record: recordArg }).pipe(
	CliCommand.withDescription("Edit a record file."),
);

const navigationScopeOptions = {
	project: Options.text("project").pipe(Options.optional),
	initiative: Options.text("initiative").pipe(Options.optional),
	allRecords: Options.boolean("all-records"),
};
const navigationWorkOptions = {
	includeHitl: Options.boolean("include-hitl"),
	planning: Options.boolean("planning"),
};
const initiativesCommand = CliCommand.make("initiatives", {
	project: Options.text("project").pipe(Options.optional),
	allRecords: Options.boolean("all-records"),
}).pipe(CliCommand.withDescription("List initiative records."));
const initiativeCommand = CliCommand.make("initiative").pipe(
	CliCommand.withDescription("Maintain initiative membership."),
	CliCommand.withSubcommands([
		CliCommand.make("attach", {
			initiative: Args.text({ name: "initiative" }),
			record: recordArg,
		}),
		CliCommand.make("detach", {
			initiative: Args.text({ name: "initiative" }),
			record: recordArg,
		}),
		CliCommand.make("project").pipe(
			CliCommand.withSubcommands([
				CliCommand.make("add", {
					initiative: Args.text({ name: "initiative" }),
					project: Args.text({ name: "project" }),
				}),
				CliCommand.make("remove", {
					initiative: Args.text({ name: "initiative" }),
					project: Args.text({ name: "project" }),
				}),
			]),
		),
	]),
);
const listCommand = CliCommand.make("list", {
	state: Options.text("state").pipe(Options.optional),
	kind: Options.text("kind").pipe(Options.optional),
	...navigationScopeOptions,
}).pipe(CliCommand.withDescription("List workflow records."));
const readyCommand = CliCommand.make("ready", {
	blocked: Options.boolean("blocked").pipe(
		Options.withDescription(
			"List blocked records. JSON output is not supported with --blocked.",
		),
	),
	...navigationWorkOptions,
	...navigationScopeOptions,
}).pipe(CliCommand.withDescription("List ready or blocked workflow records."));
const nextCommand = CliCommand.make("next", {
	...navigationWorkOptions,
	...navigationScopeOptions,
}).pipe(CliCommand.withDescription("Select the next workflow record."));
const treeCommand = CliCommand.make("tree", { record: recordArg }).pipe(
	CliCommand.withDescription("Show a record tree."),
);
const depsCommand = CliCommand.make("deps", {
	record: Args.optional(recordArg),
}).pipe(
	CliCommand.withDescription("Show or mutate dependencies."),
	CliCommand.withSubcommands([
		CliCommand.make("add", {
			record: recordArg,
			dependsOn: Options.text("depends-on"),
			...presentationOptions,
		}),
		CliCommand.make("remove", {
			record: recordArg,
			dependsOn: Options.text("depends-on"),
			...presentationOptions,
		}),
	]),
);

const forgeRootCommand = CliCommand.make("forge", forgeRootOptions).pipe(
	CliCommand.withDescription("Forge personal workflow CLI"),
	CliCommand.withSubcommands([
		configCommand,
		storeCommand,
		projectCommand,
		newCommand,
		showCommand,
		startCommand,
		doneCommand,
		commentCommand,
		commentsCommand,
		updatesCommand,
		historyCommand,
		initiativesCommand,
		initiativeCommand,
		listCommand,
		readyCommand,
		nextCommand,
		treeCommand,
		depsCommand,
		openCommand,
		editCommand,
		projectsCommand,
		hereCommand,
	]),
);

const helpText = `${HelpDoc.toAnsiText(
	CliCommand.getHelp(forgeRootCommand, CliConfig.defaultConfig),
)}\n`;

const forgeCliApp = CliApp.make({
	name: "forge",
	version: "0.0.0",
	command: forgeRootCommand.descriptor,
});

const recentCommentLimit = 3;
const recentUpdateLimit = 5;

const commandDescriptors = new Map<string, unknown>([
	["config", configCommand],
	["config get", configGetCommand],
	["config set", configSetCommand],
	["store", storeCommand],
	["store path", storePathCommand],
	["store doctor", storeDoctorCommand],
	["project", projectCommand],
	["project add", projectAddCommand],
	["project root", projectRootCommand],
	["project root add", projectRootAddCommand],
	["project root remove", projectRootRemoveCommand],
	["project remove", projectRemoveCommand],
	["new", newCommand],
	["show", showCommand],
	["start", startCommand],
	["done", doneCommand],
	["comment", commentCommand],
	["comments", commentsCommand],
	["updates", updatesCommand],
	["history", historyCommand],
	["initiatives", initiativesCommand],
	["initiative", initiativeCommand],
	["list", listCommand],
	["ready", readyCommand],
	["next", nextCommand],
	["tree", treeCommand],
	["deps", depsCommand],
	["open", openCommand],
	["edit", editCommand],
	["projects", projectsCommand],
	["here", hereCommand],
]);

function helpForCommand(command: string): string {
	const descriptor = commandDescriptors.get(command);
	return descriptor === undefined
		? helpText
		: `${HelpDoc.toAnsiText(
				CliCommand.getHelp(
					descriptor as Parameters<typeof CliCommand.getHelp>[0],
					CliConfig.defaultConfig,
				),
			)}\n`;
}

const commandHelp: Record<string, string> = new Proxy(Object.create(null), {
	get: (_target, property) => helpForCommand(String(property)),
});

type ExitCodeTarget = { exitCode?: string | number | null | undefined };

export function runCliMain(
	argv: ReadonlyArray<string> = process.argv.slice(2),
	options: CliOptions = {},
	exitCodeTarget: ExitCodeTarget = process,
): Effect.Effect<void> {
	return Effect.promise(async () => {
		exitCodeTarget.exitCode = await runCli(argv, options);
	});
}

export async function runCli(
	argv: ReadonlyArray<string>,
	options: CliOptions = {},
): Promise<number> {
	const stderr = options.stderr ?? process.stderr;
	try {
		const baseContext = await createInvocationContext(options);
		if (isHelpInvocation(argv)) {
			writeOut(baseContext.stdout, helpForCommand(helpCommandName(argv)));
			return 0;
		}
		let output: CommandOutput = { value: undefined, code: 0 };
		await runForgePromise(
			CliApp.run(forgeCliApp, ["node", "forge", ...argv], (nativeConfig) =>
				Effect.gen(function* () {
					const parsed = parsedFromNativeConfig(nativeConfig, baseContext);
					output = yield* executeParsedCommandEffect(parsed);
					renderOutput(parsed, output);
				}),
			) as never,
		);
		return output.code;
	} catch (error) {
		writeOut(stderr, `${formatError(error)}\n`);
		return isForgeError(error) ? 2 : 1;
	}
}

type CliAction = (
	parsed: Parsed,
) => Effect.Effect<CommandOutput, unknown, FileSystem>;

type CliActionRegistration = {
	readonly path: ReadonlyArray<string>;
	readonly action: CliAction;
};

const operationalCliActions: ReadonlyArray<CliActionRegistration> = [
	{ path: ["project", "root", "add"], action: runProjectRootEffect },
	{ path: ["project", "root", "remove"], action: runProjectRootEffect },
	{ path: ["config", "get"], action: runConfigGetEffect },
	{ path: ["config", "set"], action: runConfigSetEffect },
	{ path: ["store", "path"], action: runStorePathEffect },
	{ path: ["store", "doctor"], action: runStoreDoctorEffect },
	{ path: ["project", "add"], action: runProjectAddEffect },
	{ path: ["project", "remove"], action: runProjectRemoveEffect },
	{ path: ["projects"], action: runProjectsEffect },
	{ path: ["here"], action: runHereEffect },
	{ path: ["config"], action: runConfigEffect },
	{ path: ["store"], action: runStoreEffect },
	{ path: ["project"], action: runProjectEffect },
];

function executeParsedCommandEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	const action = actionForParsedCommand(parsed);
	if (action !== undefined) {
		return action(parsed);
	}
	return legacyCommandEffect(parsed);
}

function actionForParsedCommand(parsed: Parsed): CliAction | undefined {
	const command = parsed.positionals[0];
	if (command === undefined) {
		return () => Effect.succeed(present(helpText));
	}
	return operationalCliActions.find((registration) =>
		commandPathMatches(parsed.positionals, registration.path),
	)?.action;
}

function commandPathMatches(
	positionals: ReadonlyArray<string>,
	path: ReadonlyArray<string>,
): boolean {
	return path.every((segment, index) => positionals[index] === segment);
}

function legacyCommandEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.promise(async () => executeParsedCommand(parsed));
}

async function executeParsedCommand(parsed: Parsed): Promise<CommandOutput> {
	const [command, subcommand, ...rest] = parsed.positionals;
	if (command === undefined) {
		return present(helpText);
	}

	switch (command) {
		case "new":
			return await runNew(parsed, subcommand, rest);
		case "show":
			return await runShow(parsed, subcommand, rest);
		case "start":
			return await runStart(parsed, subcommand, rest);
		case "done":
			return await runDone(parsed, subcommand, rest);
		case "comment":
			return await runComment(parsed, subcommand, rest);
		case "comments":
			return await runComments(parsed, subcommand, rest);
		case "updates":
			return await runUpdates(parsed, subcommand, rest);
		case "history":
			return await runHistory(parsed, subcommand, rest);
		case "initiatives":
			return await runInitiatives(parsed, subcommand, rest);
		case "initiative":
			return await runInitiative(parsed, subcommand, rest);
		case "list":
			return await runList(parsed, subcommand, rest);
		case "ready":
			return await runReady(parsed, subcommand, rest);
		case "next":
			return await runNext(parsed, subcommand, rest);
		case "tree":
			return await runTree(parsed, subcommand, rest);
		case "deps":
			return await runDeps(parsed, subcommand, rest);
		case "open":
			return await runOpen(parsed, subcommand, rest);
		case "edit":
			return await runEdit(parsed, subcommand, rest);
		default:
			throw usage(`Unknown command '${command}'. Run forge --help.`);
	}
}

function runConfigEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.promise(async () => {
		const [, subcommand, ...rest] = parsed.positionals;
		return await runConfig(parsed, subcommand, rest);
	});
}

function runConfigGetEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		const key = parsed.positionals[2];
		if (key !== undefined && key !== "storePath") {
			return yield* Effect.fail(usage("Usage: forge config get [storePath]"));
		}
		const storePathOverride =
			parsed.storeOverride === undefined
				? undefined
				: yield* parseAbsolutePathEffect(parsed.storeOverride, "storePath");
		const config = yield* loadForgeConfigEffect({
			homeDirectory,
			storePathOverride,
		});
		return present(key === "storePath" ? config.storePath : config);
	});
}

function runConfigSetEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [key, value, ...tail] = parsed.positionals.slice(2);
		if (key === undefined || value === undefined || tail.length > 0) {
			return yield* Effect.fail(
				usage("Usage: forge config set storePath <absolute-path>"),
			);
		}
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		const input = yield* decodeConfigSetInputEffect({ key, value });
		const config = { storePath: input.value };
		yield* writeForgeConfigEffect({ homeDirectory, config });
		yield* ensureStoreRootEffect({ storePath: input.value });
		return present({ updated: true, ...config });
	});
}

function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
	});
}

function parseProjectIdEffect(value: string | undefined, field: string) {
	return Effect.try({
		try: () => {
			if (value === undefined) {
				throw usage(`${field} is required.`);
			}
			return parseProjectId(value);
		},
		catch: (error) => error,
	});
}

function decodeConfigSetInputEffect(input: { key: string; value: string }) {
	return Effect.try({
		try: () => decodeConfigSetInput(input),
		catch: (error) => error,
	});
}

function decodeProjectAddInputEffect(input: {
	readonly id: string | undefined;
	readonly root: FlagValue | undefined;
	readonly name?: string;
	readonly remote?: string;
}) {
	return Effect.try({
		try: () =>
			decodeProjectAddInput({
				id: input.id,
				root: stringFlag(input.root),
				name: input.name,
				remote: input.remote,
			}),
		catch: (error) => error,
	});
}

function decodeProjectRootInputEffect(input: {
	readonly id: string | undefined;
	readonly root: string | undefined;
}) {
	return Effect.try({
		try: () => decodeProjectRootInput(input),
		catch: (error) => error,
	});
}

async function runConfig(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const homeDirectory = parseAbsolutePath(
		parsed.homeDirectory,
		"homeDirectory",
	);
	if (subcommand === "get") {
		const key = rest[0];
		if (key !== undefined && key !== "storePath") {
			throw usage("Usage: forge config get [storePath]");
		}
		const config = await loadForgeConfig({
			homeDirectory,
			storePathOverride:
				parsed.storeOverride === undefined
					? undefined
					: parseAbsolutePath(parsed.storeOverride, "storePath"),
		});
		return present(key === "storePath" ? config.storePath : config);
	}
	if (subcommand === "set") {
		const [key, value] = rest;
		if (key === undefined || value === undefined || rest.length !== 2) {
			throw usage("Usage: forge config set storePath <absolute-path>");
		}
		const input = decodeConfigSetInput({ key, value });
		const config = { storePath: input.value };
		await writeForgeConfig({ homeDirectory, config });
		await ensureStoreRoot({ storePath: input.value });
		return present({ updated: true, ...config });
	}
	throw usage(commandHelp.config);
}

function runStoreEffect(parsed: Parsed): Effect.Effect<CommandOutput> {
	return Effect.promise(async () => {
		const [, subcommand] = parsed.positionals;
		return await runStore(parsed, subcommand);
	});
}

function runStorePathEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.map(resolveStorePathEffect(parsed), (storePath) =>
		present(storePath),
	);
}

function runStoreDoctorEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* resolveStorePathEffect(parsed);
		const report = yield* storeDoctorEffect({ storePath });
		return present(report, report.ok ? 0 : 2);
	});
}

async function runStore(
	parsed: Parsed,
	subcommand: string | undefined,
): Promise<CommandOutput> {
	const storePath = await resolveStorePath(parsed);
	if (subcommand === "path") {
		return present(storePath);
	}
	if (subcommand === "doctor") {
		const report = await storeDoctor({ storePath });
		return present(report, report.ok ? 0 : 2);
	}
	throw usage(commandHelp.store);
}

function runProjectEffect(parsed: Parsed): Effect.Effect<CommandOutput> {
	return Effect.promise(async () => {
		const [, subcommand, ...rest] = parsed.positionals;
		return await runProject(parsed, subcommand, rest);
	});
}

function runProjectAddEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [id] = parsed.positionals.slice(2);
		const input = yield* decodeProjectAddInputEffect({
			id,
			root: parsed.flags.root,
			name: getOptionalStringFlag(parsed, "name"),
			remote: getOptionalStringFlag(parsed, "remote"),
		});
		const storePath = yield* readyStoreEffect(parsed);
		const project = yield* addProjectEffect({ storePath, ...input });
		return present(project);
	});
}

function runProjectRootEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const projectRootArgumentsOffset = 3;
		const [id, root] = parsed.positionals.slice(projectRootArgumentsOffset);
		const input = yield* decodeProjectRootInputEffect({ id, root });
		const storePath = yield* readyStoreEffect(parsed);
		const operation = parsed.positionals[2];
		const operationEffect =
			operation === "add"
				? addProjectRootEffect({ storePath, ...input })
				: removeProjectRootEffect({ storePath, ...input });
		const project = yield* operationEffect;
		return present(project);
	});
}

function runProjectRemoveEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [id] = parsed.positionals.slice(2);
		const storePath = yield* readyStoreEffect(parsed);
		const projectId = yield* parseProjectIdEffect(id, "id");
		yield* removeProjectEffect({ storePath, id: projectId });
		return present({ removed: projectId });
	});
}

async function runProject(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const storePath = await readyStore(parsed);
	if (subcommand === "add") {
		const [id, ...tail] = rest;
		const root = getRequiredFlag(
			parsed,
			"root",
			"Usage: forge project add <id> --root <path> [--name <name>] [--remote <url>]",
		);
		if (id === undefined) {
			throw usage(
				"Usage: forge project add <id> --root <path> [--name <name>] [--remote <url>]",
			);
		}
		if (tail.length > 0) {
			throw usage(
				"Usage: forge project add <id> --root <path> [--name <name>] [--remote <url>]",
			);
		}
		const input = decodeProjectAddInput({
			id,
			root,
			name: getOptionalStringFlag(parsed, "name"),
			remote: getOptionalStringFlag(parsed, "remote"),
		});
		return present(await addProject({ storePath, ...input }));
	}
	if (subcommand === "root") {
		const rootCommandArity = 3;
		const [operation, id, root] = rest;
		if (
			(operation !== "add" && operation !== "remove") ||
			id === undefined ||
			root === undefined ||
			rest.length !== rootCommandArity
		) {
			throw usage(
				"Usage: forge project root add <id> <path>\n       forge project root remove <id> <path>",
			);
		}
		const input = decodeProjectRootInput({ id, root });
		return present(
			operation === "add"
				? await addProjectRoot({ storePath, ...input })
				: await removeProjectRoot({ storePath, ...input }),
		);
	}
	if (subcommand === "remove") {
		const [id] = rest;
		if (id === undefined || rest.length !== 1) {
			throw usage("Usage: forge project remove <id>");
		}
		await removeProject({ storePath, id: parseProjectId(id) });
		return present({ removed: id });
	}
	throw usage(commandHelp.project);
}

async function runNew(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	if (rest.length > 0) {
		throw usage(commandHelp.new);
	}
	const storePath = await readyStore(parsed);
	const title = getRequiredFlag(parsed, "title", commandHelp.new);
	const kind = parseNewKind(subcommand);
	const parentId =
		getOptionalStringFlag(parsed, "parent") === undefined
			? undefined
			: parseRecordId(Number(getOptionalStringFlag(parsed, "parent")));
	const parent =
		parentId === undefined
			? undefined
			: await readWorkflowRecord(storePath, parentId);
	const body = await readProse(
		parsed,
		kind === "task" || kind === "grilling" ? "description" : "body",
	);
	const explicitProject = getOptionalStringFlag(parsed, "project");
	const project =
		explicitProject ??
		(kind === "spec"
			? await inferProjectIdForCwd(parsed, storePath)
			: undefined);
	const projects = getOptionalStringFlag(parsed, "projects");
	const initiative = getOptionalStringFlag(parsed, "initiative");
	const generatedBy = getOptionalStringFlag(parsed, "generated-by");
	const scope = getOptionalStringFlag(parsed, "scope");
	const record = await createWorkflowRecord({
		storePath,
		input: {
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
			}),
			parent: parentId ?? null,
			initiative:
				initiative === undefined ? null : parseRecordId(Number(initiative)),
			dependsOn: getStringArrayFlag(parsed, "depends-on").map((id) =>
				parseRecordId(Number(id)),
			),
			generatedBy:
				generatedBy === undefined ? null : parseRecordId(Number(generatedBy)),
			tags: [],
			profile: null,
			body,
		},
	});
	return present(record);
}

async function runShow(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.show);
	const storePath = await readyStore(parsed);
	const record = await readWorkflowRecord(storePath, id);
	const relationships = await readRecordRelationships(storePath);
	const shown = {
		...record,
		relationships: relationships[String(record.id)] ?? null,
		recentComments: (await listRecordComments(storePath, record.id)).slice(
			-recentCommentLimit,
		),
		recentUpdates: (await listRecordUpdates(storePath, record.id)).slice(
			-recentUpdateLimit,
		),
	};
	if (parsed.presentation === "json") {
		return present(shown);
	}
	return present(shown, 0, formatShownRecord(shown));
}

async function runStart(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.start);
	return present(
		await startWorkflowRecord({
			storePath: await readyStore(parsed),
			recordId: id,
		}),
	);
}

async function runDone(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.done);
	const resolution = getRequiredFlag(parsed, "resolution", commandHelp.done);
	return present(
		await completeWorkflowRecord({
			storePath: await readyStore(parsed),
			recordId: id,
			resolution,
		}),
	);
}

async function runComment(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const storePath = await readyStore(parsed);
	if (subcommand === "edit") {
		const [record, comment, ...tail] = rest;
		if (record === undefined || comment === undefined || tail.length > 0) {
			throw usage(commandHelp.comment);
		}
		const recordId = parseRecordId(Number(record));
		const commentId = parseCommentId(comment);
		const existing = await findRecordComment(storePath, recordId, commentId);
		const temporaryPath = parseAbsolutePath(
			`${storePath}/comment-${recordId}-${commentId}.edit-${process.pid}-${Date.now()}.md`,
			"temporaryPath",
		);
		const markdown = await editTemporaryFile(
			temporaryPath,
			formatRecordCommentMarkdown(existing),
			parsed,
		);
		const edited = await replaceRecordCommentFromEditedMarkdown({
			storePath,
			recordId,
			commentId,
			markdown,
		});
		return present({ updated: true, comment: edited });
	}
	const id = singleRecordId(subcommand, rest, commandHelp.comment);
	const comment = await addRecordComment({
		storePath,
		recordId: id,
		body: await readProse(parsed, "message"),
	});
	return present(comment);
}

async function runComments(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.comments);
	const comments = await listRecordComments(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(comments);
	}
	return present(comments, 0, formatRecordComments(comments));
}

async function runUpdates(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.updates);
	const updates = await listRecordUpdates(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(updates);
	}
	return present(updates, 0, formatRecordUpdates(updates));
}

async function runHistory(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.history);
	const history = await listRecordHistory(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(history);
	}
	return present(history, 0, formatRecordHistory(history));
}

async function runInitiatives(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	if (subcommand !== undefined || rest.length > 0) {
		throw usage(commandHelp.initiatives);
	}
	const storePath = await readyStore(parsed);
	const records = await listWorkflowRecords(storePath);
	const explicitProject = getOptionalStringFlag(parsed, "project");
	const project =
		explicitProject ??
		(parsed.flags["all-records"] !== true
			? await inferProjectIdForCwd(parsed, storePath)
			: undefined);
	return present(
		records.filter(
			(record) =>
				record.kind === "initiative" &&
				(project === undefined || recordHasProject(record, records, project)),
		),
	);
}

async function runInitiative(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const storePath = await readyStore(parsed);
	if (subcommand === "attach" || subcommand === "detach") {
		const [initiative, record, ...tail] = rest;
		if (initiative === undefined || record === undefined || tail.length > 0) {
			throw usage(commandHelp.initiative);
		}
		const input = {
			storePath,
			initiativeId: parseRecordId(Number(initiative)),
			recordId: parseRecordId(Number(record)),
		};
		return present(
			subcommand === "attach"
				? await attachWorkflowRecordToInitiative(input)
				: await detachWorkflowRecordFromInitiative(input),
		);
	}
	if (subcommand === "project") {
		const [operation, initiative, project, ...tail] = rest;
		if (
			(operation !== "add" && operation !== "remove") ||
			initiative === undefined ||
			project === undefined ||
			tail.length > 0
		) {
			throw usage(commandHelp.initiative);
		}
		const input = {
			storePath,
			initiativeId: parseRecordId(Number(initiative)),
			project: parseProjectId(project),
		};
		return present(
			operation === "add"
				? await addInitiativeDeclaredProject(input)
				: await removeInitiativeDeclaredProject(input),
		);
	}
	throw usage(commandHelp.initiative);
}

async function runList(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	if (subcommand !== undefined || rest.length > 0) {
		throw usage(commandHelp.list);
	}
	const storePath = await readyStore(parsed);
	const records = await listWorkflowRecords(storePath);
	const state = getOptionalStringFlag(parsed, "state");
	const kind = getOptionalStringFlag(parsed, "kind");
	const explicitProject = getOptionalStringFlag(parsed, "project");
	const initiative = getOptionalStringFlag(parsed, "initiative");
	const initiativeId =
		initiative === undefined ? undefined : parseRecordId(Number(initiative));
	const project =
		explicitProject ??
		(initiativeId === undefined && parsed.flags["all-records"] !== true
			? await inferProjectIdForCwd(parsed, storePath)
			: undefined);
	return present(
		records.filter(
			(record) =>
				(state === undefined || record.state === state) &&
				(kind === undefined || record.kind === kind) &&
				(project === undefined || recordHasProject(record, records, project)) &&
				(initiativeId === undefined ||
					recordBelongsToInitiative(record, initiativeId, records)),
		),
	);
}

async function runReady(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	if (subcommand !== undefined || rest.length > 0) {
		throw usage(commandHelp.ready);
	}
	if (parsed.presentation === "json" && parsed.flags.blocked === true) {
		throw usage("forge ready --json cannot be combined with --blocked.");
	}
	const storePath = await readyStore(parsed);
	const records = await listWorkflowRecords(storePath);
	const options = await navigationQueryOptions(parsed, storePath);
	const diagnoses = await listWorkflowRecordReadiness(storePath, {
		...options,
		blocked: parsed.flags.blocked === true,
		includeHitl: parsed.flags["include-hitl"] === true,
		planning: parsed.flags.planning === true,
	});
	if (parsed.presentation === "json") {
		return present(readyJsonContract(diagnoses, records));
	}
	return present(
		diagnoses,
		0,
		formatReadinessDiagnoses(diagnoses, records, parsed.flags.blocked === true),
	);
}

async function runNext(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	if (subcommand !== undefined || rest.length > 0) {
		throw usage(commandHelp.next);
	}
	const storePath = await readyStore(parsed);
	const record = await selectNextWorkflowRecord(storePath, {
		...(await navigationQueryOptions(parsed, storePath)),
		includeHitl: parsed.flags["include-hitl"] === true,
		planning: parsed.flags.planning === true,
	});
	return present(record ?? null);
}

async function runTree(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.tree);
	const tree = await readRecordTree(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(tree);
	}
	return present(tree, 0, formatRecordTree(tree));
}

async function runDeps(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const storePath = await readyStore(parsed);
	if (subcommand === "add" || subcommand === "remove") {
		const [record, ...tail] = rest;
		if (record === undefined || tail.length > 0) {
			throw usage(commandHelp.deps);
		}
		const dependsOn = getRequiredFlag(parsed, "depends-on", commandHelp.deps);
		const input = {
			storePath,
			recordId: parseRecordId(Number(record)),
			dependsOn: parseRecordId(Number(dependsOn)),
		};
		return present(
			subcommand === "add"
				? await addWorkflowRecordDependency(input)
				: await removeWorkflowRecordDependency(input),
		);
	}
	const id = singleRecordId(subcommand, rest, commandHelp.deps);
	const view = await readRecordDependencyView(storePath, id);
	if (parsed.presentation === "json") {
		return present(view);
	}
	return present(view, 0, formatDependencyView(view));
}

async function runOpen(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.open);
	const storePath = await readyStore(parsed);
	const locator = await locateWorkflowRecord(storePath, id);
	return present(recordFilePath(storePath, locator.kind, id));
}

async function runEdit(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
): Promise<CommandOutput> {
	const id = singleRecordId(subcommand, rest, commandHelp.edit);
	const storePath = await readyStore(parsed);
	const locator = await locateWorkflowRecord(storePath, id);
	const filePath = recordFilePath(storePath, locator.kind, id);
	const temporaryPath = parseAbsolutePath(
		`${filePath}.edit-${process.pid}-${Date.now()}`,
		"temporaryPath",
	);
	const markdown = await editTemporaryFile(
		temporaryPath,
		await readFileString(filePath),
		parsed,
	);
	const edited = await replaceWorkflowRecordFromEditedMarkdown({
		storePath,
		recordId: id,
		markdown,
	});
	return present({ updated: true, record: edited });
}

function runProjectsEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const projects = yield* listProjectsEffect(storePath);
		return present(projects);
	});
}

function runHereEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const cwd = yield* parseAbsolutePathEffect(parsed.cwd, "cwd");
		const project = yield* inferProjectByPathEffect({ storePath, cwd });
		if (project === undefined) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "project-not-found",
					message:
						"No registered project matches the current directory. Run `forge project add <id> --root <path>`.",
				}),
			);
		}
		return present(project);
	});
}

async function createInvocationContext(
	options: CliOptions,
): Promise<CliInvocationContext> {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const env = options.env ?? process.env;
	const homeDirectory = env.FORGE_HOME ?? env.HOME ?? process.env.HOME;
	if (homeDirectory === undefined) {
		throw usage("HOME must be set.");
	}
	return {
		presentation: "human",
		cwd: options.cwd ?? process.cwd(),
		homeDirectory,
		stdin: options.stdin ?? process.stdin,
		stdout,
		stderr,
		env,
	};
}

type NativeParsedConfig = Readonly<Record<string, unknown>>;
type NativeSubcommand = readonly [unknown, NativeParsedConfig];

function parsedFromNativeConfig(
	rootConfig: unknown,
	baseContext: CliInvocationContext,
): Parsed {
	const root = asNativeConfig(rootConfig);
	const path = collectCommandPath(root);
	const leaf = path.at(-1)?.config ?? root;
	const flags = collectNativeFlags(root);
	return {
		...baseContext,
		presentation: flags.json === true ? "json" : "human",
		cwd: optionalString(root.cwd) ?? baseContext.cwd,
		storeOverride: optionalString(root.store),
		positionals: [
			...path.map((entry) => entry.name),
			...leafPositionals(
				path.map((entry) => entry.name),
				leaf,
			),
		],
		flags,
	};
}

function asNativeConfig(value: unknown): NativeParsedConfig {
	return typeof value === "object" && value !== null
		? (value as NativeParsedConfig)
		: {};
}

function collectCommandPath(
	config: NativeParsedConfig,
): Array<{ name: string; config: NativeParsedConfig }> {
	const subcommand = nativeSubcommand(config.subcommand);
	if (subcommand === undefined) {
		return [];
	}
	const [, subcommandConfig] = subcommand;
	return [
		{ name: nativeCommandName(subcommand[0]), config: subcommandConfig },
		...collectCommandPath(subcommandConfig),
	];
}

function nativeSubcommand(value: unknown): NativeSubcommand | undefined {
	const option = value as { readonly _tag?: string; readonly value?: unknown };
	if (option?._tag !== "Some" || !Array.isArray(option.value)) {
		return undefined;
	}
	const [, config] = option.value;
	return [option.value[0], asNativeConfig(config)] as const;
}

function nativeCommandName(tag: unknown): string {
	const key = String((tag as { readonly key?: unknown })?.key ?? "");
	const match = /\(([^)]+)\)$/.exec(key);
	return match?.[1] ?? key;
}

function collectNativeFlags(
	config: NativeParsedConfig,
): Record<string, FlagValue> {
	const flags: Record<string, FlagValue> = {};
	for (const [key, value] of Object.entries(config)) {
		if (key === "subcommand") {
			const subcommand = nativeSubcommand(value);
			if (subcommand !== undefined) {
				Object.assign(flags, collectNativeFlags(subcommand[1]));
			}
			continue;
		}
		const flagValue = nativeFlagValue(value);
		if (flagValue !== undefined) {
			flags[nativeFlagName(key)] = flagValue;
		}
	}
	return flags;
}

function nativeFlagValue(value: unknown): FlagValue | undefined {
	const unwrapped = unwrapNativeOption(value);
	if (unwrapped === undefined || unwrapped === false) {
		return undefined;
	}
	if (Array.isArray(unwrapped)) {
		return unwrapped.map(String);
	}
	if (typeof unwrapped === "boolean") {
		return unwrapped;
	}
	return String(unwrapped);
}

function unwrapNativeOption(value: unknown): unknown {
	const option = value as { readonly _tag?: string; readonly value?: unknown };
	if (option?._tag === "None") {
		return undefined;
	}
	if (option?._tag === "Some") {
		return option.value;
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	const unwrapped = unwrapNativeOption(value);
	return unwrapped === undefined ? undefined : String(unwrapped);
}

function nativeFlagName(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function leafPositionals(
	path: ReadonlyArray<string>,
	leaf: NativeParsedConfig,
): ReadonlyArray<string> {
	const leafString = (key: string) => optionalString(leaf[key]);
	const present = (...values: Array<string | undefined>) =>
		values.filter((value): value is string => value !== undefined);
	const joined = path.join(" ");
	switch (joined) {
		case "config get":
			return present(leafString("key"));
		case "config set":
			return present(leafString("key"), leafString("value"));
		case "project add":
		case "project remove":
			return present(leafString("id"));
		case "project root add":
		case "project root remove":
			return present(leafString("id"), leafString("root"));
		case "show":
		case "start":
		case "done":
		case "comments":
		case "updates":
		case "history":
		case "tree":
		case "open":
		case "edit":
			return present(leafString("record"));
		case "comment":
			return present(leafString("record"));
		case "comment edit":
			return present(leafString("record"), leafString("comment"));
		case "initiative attach":
		case "initiative detach":
			return present(leafString("initiative"), leafString("record"));
		case "initiative project add":
		case "initiative project remove":
			return present(leafString("initiative"), leafString("project"));
		case "deps":
			return present(leafString("record"));
		case "deps add":
		case "deps remove":
			return present(leafString("record"));
		default:
			return [];
	}
}

function isHelpInvocation(argv: ReadonlyArray<string>): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function helpCommandName(argv: ReadonlyArray<string>): string {
	const commandTokens: Array<string> = [];
	let index = 0;
	while (index < argv.length) {
		const token = argv[index];
		if (token === undefined || token === "--help" || token === "-h") {
			index += 1;
			continue;
		}
		if (token === "--store" || token === "--cwd" || token === "-C") {
			index += 2;
			continue;
		}
		if (token === "--log-level" || token === "--completions") {
			index += 2;
			continue;
		}
		if (
			token === "--json" ||
			token === "--wizard" ||
			token === "--version" ||
			token.startsWith("--store=") ||
			token.startsWith("--cwd=") ||
			token.startsWith("--log-level=") ||
			token.startsWith("--completions=")
		) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		commandTokens.push(token);
		index += 1;
	}
	for (let length = commandTokens.length; length > 0; length -= 1) {
		const candidate = commandTokens.slice(0, length).join(" ");
		if (commandDescriptors.has(candidate)) {
			return candidate;
		}
	}
	return "forge";
}

async function navigationQueryOptions(
	parsed: Parsed,
	storePath: AbsolutePath,
): Promise<NextRecordOptions> {
	const projectFlag = getOptionalStringFlag(parsed, "project");
	const initiativeFlag = getOptionalStringFlag(parsed, "initiative");
	const project =
		projectFlag ??
		(initiativeFlag === undefined && parsed.flags["all-records"] !== true
			? await inferProjectIdForCwd(parsed, storePath)
			: undefined);
	return {
		project: project === undefined ? undefined : parseProjectId(project),
		initiative:
			initiativeFlag === undefined
				? undefined
				: parseRecordId(Number(initiativeFlag)),
	};
}

async function inferProjectIdForCwd(
	parsed: Parsed,
	storePath: AbsolutePath,
): Promise<string | undefined> {
	return (
		await inferProjectByPath({
			storePath,
			cwd: parseAbsolutePath(parsed.cwd, "cwd"),
		})
	)?.id;
}

function parseNewKind(value: string | undefined): RecordKind {
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

function parseTaskSubkind(value: string | undefined): TaskSubkind | null {
	if (value === undefined) {
		return null;
	}
	if (value === "research" || value === "prototype" || value === "review") {
		return value;
	}
	throw usage("Task kind must be research, prototype, or review.");
}

async function readProse(
	parsed: Parsed,
	field: "body" | "description" | "message",
): Promise<string> {
	const inline = getOptionalStringFlag(parsed, field);
	const file = getOptionalStringFlag(parsed, `${field}-file`);
	if ((inline === undefined) === (file === undefined)) {
		throw usage(
			`Provide exactly one of --${field} <md>, --${field}-file <file>, or --${field} -.`,
		);
	}
	if (file !== undefined) {
		return readTextFile(file);
	}
	if (inline === undefined) {
		throw usage(
			`Provide exactly one of --${field} <md>, --${field}-file <file>, or --${field} -.`,
		);
	}
	return inline === "-" ? readStreamText(parsed.stdin) : inline;
}

function scopeForNewRecord(options: {
	readonly kind: RecordKind;
	readonly project?: string;
	readonly projects?: string;
	readonly initiative?: string;
	readonly scope?: string;
	readonly parent?: WorkflowRecord;
}) {
	if (options.kind === "task" || options.kind === "grilling") {
		if (options.parent === undefined) {
			throw usage(commandHelp.new);
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
) {
	if (value === undefined || rest.length > 0) {
		throw usage(message);
	}
	return parseRecordId(Number(value));
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

function readyJsonContract(
	diagnoses: ReadonlyArray<ReadinessDiagnosis>,
	records: ReadonlyArray<WorkflowRecord>,
): {
	readonly records: ReadonlyArray<
		Pick<WorkflowRecord, "id" | "kind" | "state" | "title">
	>;
} {
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
			if (diagnosis.reasons.length === 0) {
				return summary;
			}
			return [
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

function formatRecordComments(comments: ReadonlyArray<RecordComment>): string {
	if (comments.length === 0) {
		return "No comments.";
	}
	return comments
		.map(
			(comment) =>
				`comment ${comment.id}\t${comment.createdAt}\n${comment.body.trimEnd()}`,
		)
		.join("\n\n");
}

function formatRecordUpdates(updates: ReadonlyArray<RecordUpdate>): string {
	if (updates.length === 0) {
		return "No updates.";
	}
	return updates
		.map(
			(update) =>
				`update ${update.sequence}\t${update.createdAt}\t${update.type}\t${update.summary}`,
		)
		.join("\n");
}

function formatRecordHistory(
	history: ReadonlyArray<RecordHistoryEntry>,
): string {
	if (history.length === 0) {
		return "No history.";
	}
	return history
		.map((entry) =>
			entry.kind === "comment"
				? `[comment] ${entry.comment.id}\t${entry.createdAt}\n${entry.comment.body.trimEnd()}`
				: `[update] ${entry.update.sequence}\t${entry.createdAt}\t${entry.update.type}\t${entry.update.summary}`,
		)
		.join("\n");
}

async function findRecordComment(
	storePath: AbsolutePath,
	recordId: ReturnType<typeof parseRecordId>,
	commentId: CommentId,
): Promise<RecordComment> {
	const comment = (await listRecordComments(storePath, recordId)).find(
		(candidate) => candidate.id === commentId,
	);
	if (comment === undefined) {
		throw new ForgeError({
			kind: "record-not-found",
			message: `Comment '${commentId}' was not found for record '${recordId}'.`,
		});
	}
	return comment;
}

function parseCommentId(value: string): CommentId {
	const numeric = Number(value);
	if (!Number.isInteger(numeric) || numeric <= 0) {
		throw usage(`Invalid comment id '${value}'.`);
	}
	return numeric as CommentId;
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

function recordBelongsToInitiative(
	record: WorkflowRecord,
	initiativeId: RecordId,
	records: ReadonlyArray<WorkflowRecord>,
): boolean {
	return effectiveInitiativeId(record, records) === initiativeId;
}

function effectiveInitiativeId(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
): RecordId | null {
	if (record.kind === "initiative") {
		return record.id;
	}
	if (record.initiative !== null) {
		return record.initiative;
	}
	if (record.scope.type === "initiative") {
		return record.scope.initiative;
	}
	if (record.parent === null) {
		return null;
	}
	const parent = records.find((candidate) => candidate.id === record.parent);
	return parent === undefined ? null : effectiveInitiativeId(parent, records);
}

function recordHasProject(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
	project: string,
): boolean {
	const projectId = parseProjectId(project);
	if (record.scope.type === "project") {
		return record.scope.project === projectId;
	}
	if (record.scope.type === "project-set") {
		return record.scope.projects.includes(projectId);
	}
	const initiativeId =
		record.scope.type === "initiative"
			? record.scope.initiative
			: record.initiative;
	if (initiativeId === null) {
		return false;
	}
	const initiative = records.find((candidate) => candidate.id === initiativeId);
	return initiative?.scope.type === "project-set"
		? initiative.scope.projects.includes(projectId)
		: false;
}

async function editTemporaryFile(
	filePath: AbsolutePath,
	initialContent: string,
	parsed: Parsed,
): Promise<string> {
	return runForgePromise(
		editTemporaryFileEffect(filePath, initialContent, parsed),
	);
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

async function readFileString(filePath: AbsolutePath): Promise<string> {
	return readTextFile(filePath);
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
	const editor = parsed.env?.EDITOR ?? process.env.EDITOR;
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

async function resolveStorePath(parsed: Parsed) {
	if (parsed.storeOverride !== undefined) {
		return parseAbsolutePath(parsed.storeOverride, "storePath");
	}
	return (
		await loadForgeConfig({
			homeDirectory: parseAbsolutePath(parsed.homeDirectory, "homeDirectory"),
		})
	).storePath;
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

async function readyStore(parsed: Parsed) {
	const storePath = await resolveStorePath(parsed);
	await ensureStoreRoot({ storePath });
	return storePath;
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

function present(value: unknown, code = 0, human?: string): CommandOutput {
	return { value, code, human };
}

function renderOutput(
	parsed: Pick<CliInvocationContext, "presentation" | "stdout">,
	output: CommandOutput,
): void {
	if (output.value === undefined && output.human === undefined) {
		return;
	}
	if (parsed.presentation === "json") {
		writeOut(parsed.stdout, `${JSON.stringify(output.value, null, "\t")}\n`);
		return;
	}
	writeOut(parsed.stdout, `${output.human ?? formatHuman(output.value)}\n`);
}

function formatHuman(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "No projects registered.";
		}
		return value.map((entry) => formatHuman(entry)).join("\n");
	}
	if (isWorkflowRecord(value)) {
		return `${value.id}\t${value.kind}\t${value.state}\t${value.title}`;
	}
	if (isProject(value)) {
		return `${value.id}\t${value.name}\t${value.roots.join(", ")}`;
	}
	if (isStoreDoctorReport(value)) {
		if (value.ok) {
			return "Store ok.";
		}
		return value.problems
			.map((problem) => `${problem.path}: ${problem.message}`)
			.join("\n");
	}
	if (typeof value === "object" && value !== null && "storePath" in value) {
		return `storePath\t${String((value as { storePath: unknown }).storePath)}`;
	}
	if (typeof value === "object" && value !== null && "removed" in value) {
		return `Removed project ${String((value as { removed: unknown }).removed)}.`;
	}
	return JSON.stringify(value);
}

function formatError(error: unknown): string {
	if (ValidationError.isValidationError(error)) {
		return `${HelpDoc.toAnsiText(error.error)}\n`;
	}
	if (isForgeError(error)) {
		return `forge: ${error.message}`;
	}
	return error instanceof Error
		? `forge: ${error.message}`
		: `forge: ${String(error)}`;
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

function writeOut(
	stream: Pick<NodeJS.WriteStream, "write">,
	value: string,
): void {
	stream.write(value);
}

function isWorkflowRecord(value: unknown): value is WorkflowRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		"kind" in value &&
		"state" in value &&
		"title" in value &&
		"body" in value
	);
}

function isProject(
	value: unknown,
): value is { id: string; name: string; roots: ReadonlyArray<string> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		"name" in value &&
		"roots" in value &&
		Array.isArray((value as { roots: unknown }).roots)
	);
}

function isStoreDoctorReport(value: unknown): value is {
	ok: boolean;
	problems: ReadonlyArray<{ path: string; message: string }>;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		"problems" in value &&
		Array.isArray((value as { problems: unknown }).problems)
	);
}

export function isCliEntrypoint(
	metaUrl = import.meta.url,
	argv1 = process.argv[1],
) {
	if (argv1 === undefined) {
		return false;
	}

	try {
		return (
			pathToFileURL(realpathSync(fileURLToPath(metaUrl))).href ===
			pathToFileURL(realpathSync(argv1)).href
		);
	} catch {
		return metaUrl === pathToFileURL(argv1).href;
	}
}

if (isCliEntrypoint()) {
	runForgeMain(runCliMain());
}
