#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { text as readStreamText } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as PlatformCommand from "@effect/platform/Command";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
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
	ensureStoreRootEffect,
	loadForgeConfigEffect,
	readTextFileEffect,
	storeDoctorEffect,
	writeForgeConfigEffect,
} from "./filesystem-store.ts";
import {
	addProjectEffect,
	addProjectRootEffect,
	inferProjectByPathEffect,
	listProjectsEffect,
	removeProjectEffect,
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
	addInitiativeDeclaredProjectEffect,
	addRecordCommentEffect,
	addWorkflowRecordDependencyEffect,
	attachWorkflowRecordToInitiativeEffect,
	completeWorkflowRecordEffect,
	createWorkflowRecordEffect,
	detachWorkflowRecordFromInitiativeEffect,
	formatRecordCommentMarkdown,
	listRecordCommentsEffect,
	listRecordHistoryEffect,
	listRecordUpdatesEffect,
	listWorkflowRecordsEffect,
	locateWorkflowRecordEffect,
	listWorkflowRecordReadinessEffect,
	readRecordDependencyViewEffect,
	readRecordRelationshipsEffect,
	readRecordTreeEffect,
	readWorkflowRecordEffect,
	removeInitiativeDeclaredProjectEffect,
	removeWorkflowRecordDependencyEffect,
	replaceRecordCommentFromEditedMarkdownEffect,
	replaceWorkflowRecordFromEditedMarkdownEffect,
	selectNextWorkflowRecordEffect,
	startWorkflowRecordEffect,
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

const initiativeProjectPathLength = 3;

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
const commentEditCommand = CliCommand.make("edit", {
	record: recordArg,
	comment: Args.text({ name: "comment" }),
}).pipe(CliCommand.withDescription("Edit a record comment."));
const commentCommand = CliCommand.make("comment", {
	record: Args.optional(recordArg),
	message: Options.text("message").pipe(Options.optional),
	messageFile: Options.text("message-file").pipe(Options.optional),
}).pipe(
	CliCommand.withDescription("Add or edit record comments."),
	CliCommand.withSubcommands([commentEditCommand]),
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
	...presentationOptions,
}).pipe(CliCommand.withDescription("List initiative records."));
const initiativeAttachCommand = CliCommand.make("attach", {
	initiative: Args.text({ name: "initiative" }),
	record: recordArg,
	...presentationOptions,
}).pipe(CliCommand.withDescription("Attach a record to an initiative."));
const initiativeDetachCommand = CliCommand.make("detach", {
	initiative: Args.text({ name: "initiative" }),
	record: recordArg,
	...presentationOptions,
}).pipe(CliCommand.withDescription("Detach a record from an initiative."));
const initiativeProjectAddCommand = CliCommand.make("add", {
	initiative: Args.text({ name: "initiative" }),
	project: Args.text({ name: "project" }),
	...presentationOptions,
}).pipe(CliCommand.withDescription("Add a declared project to an initiative."));
const initiativeProjectRemoveCommand = CliCommand.make("remove", {
	initiative: Args.text({ name: "initiative" }),
	project: Args.text({ name: "project" }),
	...presentationOptions,
}).pipe(
	CliCommand.withDescription("Remove a declared project from an initiative."),
);
const initiativeProjectCommand = CliCommand.make("project").pipe(
	CliCommand.withDescription("Maintain initiative project declarations."),
	CliCommand.withSubcommands([
		initiativeProjectAddCommand,
		initiativeProjectRemoveCommand,
	]),
);
const initiativeCommand = CliCommand.make("initiative").pipe(
	CliCommand.withDescription("Maintain initiative membership."),
	CliCommand.withSubcommands([
		initiativeAttachCommand,
		initiativeDetachCommand,
		initiativeProjectCommand,
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
const depsAddCommand = CliCommand.make("add", {
	record: recordArg,
	dependsOn: Options.text("depends-on"),
	...presentationOptions,
});
const depsRemoveCommand = CliCommand.make("remove", {
	record: recordArg,
	dependsOn: Options.text("depends-on"),
	...presentationOptions,
});
const depsCommand = CliCommand.make("deps", {
	record: Args.optional(recordArg),
}).pipe(
	CliCommand.withDescription("Show or mutate dependencies."),
	CliCommand.withSubcommands([depsAddCommand, depsRemoveCommand]),
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

type CliAction = (
	parsed: Parsed,
) => Effect.Effect<CommandOutput, unknown, CommandExecutor | FileSystem>;

type CliCommandRegistration = {
	readonly path: ReadonlyArray<string>;
	readonly descriptor: unknown;
	readonly action?: CliAction;
	readonly positionals?: ReadonlyArray<string>;
};

type CliActionRegistration = {
	readonly path: ReadonlyArray<string>;
	readonly action: CliAction;
};

const cliCommandRegistrations: ReadonlyArray<CliCommandRegistration> = [
	{ path: ["config"], descriptor: configCommand, action: runConfigEffect },
	{
		path: ["config", "get"],
		descriptor: configGetCommand,
		action: runConfigGetEffect,
		positionals: ["key"],
	},
	{
		path: ["config", "set"],
		descriptor: configSetCommand,
		action: runConfigSetEffect,
		positionals: ["key", "value"],
	},
	{ path: ["store"], descriptor: storeCommand, action: runStoreEffect },
	{
		path: ["store", "path"],
		descriptor: storePathCommand,
		action: runStorePathEffect,
	},
	{
		path: ["store", "doctor"],
		descriptor: storeDoctorCommand,
		action: runStoreDoctorEffect,
	},
	{ path: ["project"], descriptor: projectCommand, action: runProjectEffect },
	{
		path: ["project", "add"],
		descriptor: projectAddCommand,
		action: runProjectAddEffect,
		positionals: ["id"],
	},
	{ path: ["project", "root"], descriptor: projectRootCommand },
	{
		path: ["project", "root", "add"],
		descriptor: projectRootAddCommand,
		action: runProjectRootEffect,
		positionals: ["id", "root"],
	},
	{
		path: ["project", "root", "remove"],
		descriptor: projectRootRemoveCommand,
		action: runProjectRootEffect,
		positionals: ["id", "root"],
	},
	{
		path: ["project", "remove"],
		descriptor: projectRemoveCommand,
		action: runProjectRemoveEffect,
		positionals: ["id"],
	},
	{ path: ["new"], descriptor: newCommand },
	{
		path: ["new", "initiative"],
		descriptor: newInitiativeCommand,
		action: runNewEffect,
	},
	{
		path: ["new", "wayfinder"],
		descriptor: newWayfinderCommand,
		action: runNewEffect,
	},
	{
		path: ["new", "spec"],
		descriptor: newSpecCommand,
		action: runNewEffect,
	},
	{
		path: ["new", "task"],
		descriptor: newTaskCommand,
		action: runNewEffect,
	},
	{
		path: ["new", "grilling"],
		descriptor: newGrillingCommand,
		action: runNewEffect,
	},
	{
		path: ["show"],
		descriptor: showCommand,
		action: runShowEffect,
		positionals: ["record"],
	},
	{
		path: ["start"],
		descriptor: startCommand,
		action: runStartEffect,
		positionals: ["record"],
	},
	{
		path: ["done"],
		descriptor: doneCommand,
		action: runDoneEffect,
		positionals: ["record"],
	},
	{
		path: ["comment"],
		descriptor: commentCommand,
		action: runCommentEffect,
		positionals: ["record"],
	},
	{
		path: ["comment", "edit"],
		descriptor: commentEditCommand,
		action: runCommentEffect,
		positionals: ["record", "comment"],
	},
	{
		path: ["comments"],
		descriptor: commentsCommand,
		action: runCommentsEffect,
		positionals: ["record"],
	},
	{
		path: ["updates"],
		descriptor: updatesCommand,
		action: runUpdatesEffect,
		positionals: ["record"],
	},
	{
		path: ["history"],
		descriptor: historyCommand,
		action: runHistoryEffect,
		positionals: ["record"],
	},
	{
		path: ["initiatives"],
		descriptor: initiativesCommand,
		action: runInitiativesEffect,
	},
	{ path: ["initiative"], descriptor: initiativeCommand },
	{
		path: ["initiative", "attach"],
		descriptor: initiativeAttachCommand,
		action: runInitiativeEffect,
		positionals: ["initiative", "record"],
	},
	{
		path: ["initiative", "detach"],
		descriptor: initiativeDetachCommand,
		action: runInitiativeEffect,
		positionals: ["initiative", "record"],
	},
	{ path: ["initiative", "project"], descriptor: initiativeProjectCommand },
	{
		path: ["initiative", "project", "add"],
		descriptor: initiativeProjectAddCommand,
		action: runInitiativeEffect,
		positionals: ["initiative", "project"],
	},
	{
		path: ["initiative", "project", "remove"],
		descriptor: initiativeProjectRemoveCommand,
		action: runInitiativeEffect,
		positionals: ["initiative", "project"],
	},
	{ path: ["list"], descriptor: listCommand, action: runListEffect },
	{ path: ["ready"], descriptor: readyCommand, action: runReadyEffect },
	{ path: ["next"], descriptor: nextCommand, action: runNextEffect },
	{
		path: ["tree"],
		descriptor: treeCommand,
		action: runTreeEffect,
		positionals: ["record"],
	},
	{
		path: ["deps"],
		descriptor: depsCommand,
		action: runDepsEffect,
		positionals: ["record"],
	},
	{
		path: ["deps", "add"],
		descriptor: depsAddCommand,
		action: runDepsEffect,
		positionals: ["record"],
	},
	{
		path: ["deps", "remove"],
		descriptor: depsRemoveCommand,
		action: runDepsEffect,
		positionals: ["record"],
	},
	{
		path: ["open"],
		descriptor: openCommand,
		action: runOpenEffect,
		positionals: ["record"],
	},
	{
		path: ["edit"],
		descriptor: editCommand,
		action: runEditEffect,
		positionals: ["record"],
	},
	{ path: ["projects"], descriptor: projectsCommand, action: runProjectsEffect },
	{ path: ["here"], descriptor: hereCommand, action: runHereEffect },
];

const commandDescriptors = new Map(
	cliCommandRegistrations.map((registration) => [
		commandKey(registration.path),
		registration.descriptor,
	]),
);

const operationalCliActions: ReadonlyArray<CliActionRegistration> = [
	...cliCommandRegistrations.flatMap((registration): Array<CliActionRegistration> =>
		registration.action === undefined
			? []
			: [{ path: registration.path, action: registration.action }],
	),
].sort((left, right) => right.path.length - left.path.length);

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

function executeParsedCommandEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, CommandExecutor | FileSystem> {
	const action = actionForParsedCommand(parsed);
	if (action !== undefined) {
		return action(parsed);
	}
	const command = parsed.positionals[0];
	return Effect.fail(
		usage(
			command === undefined
				? helpText
				: `Unknown command '${command}'. Run forge --help.`,
		),
	);
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

function commandKey(path: ReadonlyArray<string>): string {
	return path.join(" ");
}

function runConfigEffect(
	_parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.fail(usage(commandHelp.config));
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

function runStoreEffect(
	_parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.fail(usage(commandHelp.store));
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

function runProjectEffect(
	_parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.fail(usage(commandHelp.project));
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

function runNewEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const title = yield* requiredStringFlagEffect(
			parsed,
			"title",
			commandHelp.new,
		);
		const kind = yield* parseNewKindEffect(parsed.positionals[1]);
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
				}),
				parent: parentId ?? null,
				initiative:
					initiative === undefined ? null : parseRecordId(Number(initiative)),
				dependsOn: recordIdsFromFlag(parsed, "depends-on"),
				generatedBy:
					generatedBy === undefined ? null : parseRecordId(Number(generatedBy)),
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
}

function runShowEffect(
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
		const recentUpdates = yield* listRecordUpdatesEffect(storePath, record.id);
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
}

function runStartEffect(
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
}

function runDoneEffect(
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
}

function runCommentEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, CommandExecutor | FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const subcommand = parsed.positionals[1];
		if (subcommand === "edit") {
			const [record, comment, ...tail] = parsed.positionals.slice(2);
			if (record === undefined || comment === undefined || tail.length > 0) {
				return yield* Effect.fail(usage(commandHelp.comment));
			}
			const recordId = yield* recordIdFromTextEffect(record);
			const commentId = yield* parseCommentIdEffect(comment);
			const existing = yield* findRecordCommentEffect(
				storePath,
				recordId,
				commentId,
			);
			const temporaryPath = yield* commentEditTemporaryPathEffect(
				storePath,
				recordId,
				commentId,
			);
			const markdown = yield* editTemporaryFileEffect(
				temporaryPath,
				formatRecordCommentMarkdown(existing),
				parsed,
			);
			const edited = yield* replaceRecordCommentFromEditedMarkdownEffect({
				storePath,
				recordId,
				commentId,
				markdown,
			});
			return present({ updated: true, comment: edited });
		}
		const id = yield* singleRecordIdEffect(
			parsed.positionals[1],
			parsed.positionals.slice(2),
			commandHelp.comment,
		);
		const comment = yield* addRecordCommentEffect({
			storePath,
			recordId: id,
			body: yield* readProseEffect(parsed, "message"),
		});
		return present(comment);
	});
}

function runCommentsEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const id = yield* singleRecordIdEffect(
			parsed.positionals[1],
			parsed.positionals.slice(2),
			commandHelp.comments,
		);
		const comments = yield* listRecordCommentsEffect(
			yield* readyStoreEffect(parsed),
			id,
		);
		if (parsed.presentation === "json") {
			return present(comments);
		}
		return present(comments, 0, formatRecordComments(comments));
	});
}

function runUpdatesEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const id = yield* singleRecordIdEffect(
			parsed.positionals[1],
			parsed.positionals.slice(2),
			commandHelp.updates,
		);
		const updates = yield* listRecordUpdatesEffect(
			yield* readyStoreEffect(parsed),
			id,
		);
		if (parsed.presentation === "json") {
			return present(updates);
		}
		return present(updates, 0, formatRecordUpdates(updates));
	});
}

function runHistoryEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const id = yield* singleRecordIdEffect(
			parsed.positionals[1],
			parsed.positionals.slice(2),
			commandHelp.history,
		);
		const history = yield* listRecordHistoryEffect(
			yield* readyStoreEffect(parsed),
			id,
		);
		if (parsed.presentation === "json") {
			return present(history);
		}
		return present(history, 0, formatRecordHistory(history));
	});
}

function runInitiativesEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const records = yield* listWorkflowRecordsEffect(storePath);
		const explicitProject = getOptionalStringFlag(parsed, "project");
		const project =
			explicitProject ??
			(parsed.flags["all-records"] !== true
				? yield* inferProjectIdForCwdEffect(parsed, storePath)
				: undefined);
		return present(
			records.filter(
				(record) =>
					record.kind === "initiative" &&
					(project === undefined || recordHasProject(record, records, project)),
			),
		);
	});
}

function runInitiativeEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const memberPath = parsed.positionals.slice(0, 2).join(" ");
		const projectPath = parsed.positionals
			.slice(0, initiativeProjectPathLength)
			.join(" ");
		if (
			memberPath === "initiative attach" ||
			memberPath === "initiative detach"
		) {
			const initiativeId = yield* recordIdFromTextEffect(parsed.positionals[2]);
			const recordId = yield* recordIdFromTextEffect(parsed.positionals[3]);
			return present(
				memberPath === "initiative attach"
					? yield* attachWorkflowRecordToInitiativeEffect({
							storePath,
							initiativeId,
							recordId,
						})
					: yield* detachWorkflowRecordFromInitiativeEffect({
							storePath,
							initiativeId,
							recordId,
						}),
			);
		}
		if (
			projectPath === "initiative project add" ||
			projectPath === "initiative project remove"
		) {
			const initiativeId = yield* recordIdFromTextEffect(parsed.positionals[3]);
			const project = yield* parseProjectIdEffect(
				parsed.positionals[4],
				"project",
			);
			return present(
				projectPath === "initiative project add"
					? yield* addInitiativeDeclaredProjectEffect({
							storePath,
							initiativeId,
							project,
						})
					: yield* removeInitiativeDeclaredProjectEffect({
							storePath,
							initiativeId,
							project,
						}),
			);
		}
		return yield* Effect.fail(usage(commandHelp.initiative));
	});
}

function runListEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const records = yield* listWorkflowRecordsEffect(storePath);
		const state = getOptionalStringFlag(parsed, "state");
		const kind = getOptionalStringFlag(parsed, "kind");
		const explicitProject = getOptionalStringFlag(parsed, "project");
		const initiative = getOptionalStringFlag(parsed, "initiative");
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
		const storePath = yield* readyStoreEffect(parsed);
		const records = yield* listWorkflowRecordsEffect(storePath);
		const options = yield* navigationQueryOptionsEffect(parsed, storePath);
		const diagnoses = yield* listWorkflowRecordReadinessEffect(storePath, {
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
			commandHelp.tree,
		);
		const tree = yield* readRecordTreeEffect(
			yield* readyStoreEffect(parsed),
			id,
		);
		if (parsed.presentation === "json") {
			return present(tree);
		}
		return present(tree, 0, formatRecordTree(tree));
	});
}

function runDepsEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const subcommand = parsed.positionals[1];
		if (subcommand === "add" || subcommand === "remove") {
			const [record, ...tail] = parsed.positionals.slice(2);
			if (record === undefined || tail.length > 0) {
				return yield* Effect.fail(usage(commandHelp.deps));
			}
			const dependsOn = yield* requiredStringFlagEffect(
				parsed,
				"depends-on",
				commandHelp.deps,
			);
			const input = {
				storePath,
				recordId: yield* recordIdFromTextEffect(record),
				dependsOn: yield* recordIdFromTextEffect(dependsOn),
			};
			const updated =
				subcommand === "add"
					? yield* addWorkflowRecordDependencyEffect(input)
					: yield* removeWorkflowRecordDependencyEffect(input);
			return present(updated);
		}
		const id = yield* singleRecordIdEffect(
			parsed.positionals[1],
			parsed.positionals.slice(2),
			commandHelp.deps,
		);
		const view = yield* readRecordDependencyViewEffect(storePath, id);
		if (parsed.presentation === "json") {
			return present(view);
		}
		return present(view, 0, formatDependencyView(view));
	});
}

function runOpenEffect(
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
}

function runEditEffect(
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
	const registration = cliCommandRegistrations.find(
		(candidate) => commandKey(candidate.path) === commandKey(path),
	);
	return (
		registration?.positionals
			?.map((key) => optionalString(leaf[key]))
			.filter((value): value is string => value !== undefined) ?? []
	);
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

function navigationQueryOptionsEffect(
	parsed: Parsed,
	storePath: AbsolutePath,
): Effect.Effect<NextRecordOptions, unknown, FileSystem> {
	return Effect.gen(function* () {
		const projectFlag = getOptionalStringFlag(parsed, "project");
		const initiativeFlag = getOptionalStringFlag(parsed, "initiative");
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

function inferProjectIdForCwdEffect(
	parsed: Parsed,
	storePath: AbsolutePath,
): Effect.Effect<string | undefined, unknown, FileSystem> {
	return Effect.gen(function* () {
		const cwd = yield* parseAbsolutePathEffect(parsed.cwd, "cwd");
		return (yield* inferProjectByPathEffect({ storePath, cwd }))?.id;
	});
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

function parseNewKindEffect(value: string | undefined) {
	return Effect.try({
		try: () => parseNewKind(value),
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
			return yield* Effect.promise(() => readStreamText(parsed.stdin));
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

function recordIdFromTextEffect(value: string) {
	return Effect.try({
		try: () => recordIdFromText(value),
		catch: (error) => error,
	});
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

function findRecordCommentEffect(
	storePath: AbsolutePath,
	recordId: ReturnType<typeof parseRecordId>,
	commentId: CommentId,
) {
	return Effect.gen(function* () {
		const comment = (yield* listRecordCommentsEffect(storePath, recordId)).find(
			(candidate) => candidate.id === commentId,
		);
		if (comment === undefined) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "record-not-found",
					message: `Comment '${commentId}' was not found for record '${recordId}'.`,
				}),
			);
		}
		return comment;
	});
}

function parseCommentId(value: string): CommentId {
	const numeric = Number(value);
	if (!Number.isInteger(numeric) || numeric <= 0) {
		throw usage(`Invalid comment id '${value}'.`);
	}
	return numeric as CommentId;
}

function parseCommentIdEffect(value: string) {
	return Effect.try({
		try: () => parseCommentId(value),
		catch: (error) => error,
	});
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

function recordEditTemporaryPathEffect(filePath: AbsolutePath) {
	return Effect.try({
		try: () =>
			parseAbsolutePath(
				`${filePath}.edit-${process.pid}-${Date.now()}`,
				"temporaryPath",
			),
		catch: (error) => error,
	});
}

function commentEditTemporaryPathEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
	commentId: CommentId,
) {
	return Effect.try({
		try: () =>
			parseAbsolutePath(
				`${storePath}/comment-${recordId}-${commentId}.edit-${process.pid}-${Date.now()}.md`,
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
