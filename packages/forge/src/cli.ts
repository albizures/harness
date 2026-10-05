#!/usr/bin/env node
import {
	defaultArgv,
	defaultCwd,
	defaultEnv,
	defaultExitCodeTarget,
	defaultHomeDirectory,
	defaultStderr,
	defaultStdin,
	defaultStdout,
	isNodeCliEntrypoint,
	type ExitCodeTarget,
} from "./cli-node.ts";

import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { FileSystem } from "@effect/platform/FileSystem";
import * as CliCommand from "@effect/cli/Command";
import * as CliConfig from "@effect/cli/CliConfig";
import * as HelpDoc from "@effect/cli/HelpDoc";
import * as Options from "@effect/cli/Options";
import * as ValidationError from "@effect/cli/ValidationError";
import { Effect } from "effect";
import type {
	CliAction,
	CliCommandRegistration,
	CliInvocationContext,
	CliOutput,
	CommandOutput,
} from "./cli/types.ts";
import {
	CliRuntimeContext,
	commandHandler as buildCommandHandler,
	parsedFromCommandConfig,
	present,
	renderOutput as renderSupportOutput,
} from "./cli/support.ts";

import { ForgeError, isForgeError } from "./errors.ts";
import type { WorkflowRecord } from "./record-domain.ts";
import { runForgeMain } from "./runtime.ts";
import { renderRootHelp, rootHelpModel } from "./cli-help.ts";
import { createConfigStoreCommands } from "./cli/config-store.ts";
import { createProjectsCommands } from "./cli/projects.ts";
import { createCommentsCommands } from "./cli/comments.ts";
import { createInitiativesCommands } from "./cli/initiatives.ts";
import { createNavigationCommands } from "./cli/navigation.ts";
import { createRecordsCommands } from "./cli/records.ts";
import { createWorktreeCommands } from "./cli/worktrees.ts";

export type CliOptions = {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdin?: NodeJS.ReadableStream;
	readonly stdout?: CliOutput;
	readonly stderr?: CliOutput;
};

function rootCommandHandler<A>(
	config: A,
): Effect.Effect<void, unknown, CliRuntimeContext> {
	return Effect.gen(function* () {
		const runtime = yield* CliRuntimeContext;
		const parsed = parsedFromCommandConfig(
			[],
			config,
			config,
			runtime.invocationContext,
			[],
		);
		const output = present(
			renderRootHelpForOutput(runtime.invocationContext.stdout),
		);
		runtime.setOutput(output);
		renderSupportOutput(parsed, output, formatHuman);
	});
}

function commandHandler(
	path: ReadonlyArray<string>,
	action: CliAction,
	positionals: ReadonlyArray<string> = [],
) {
	return buildCommandHandler(path, action, positionals, formatHuman);
}

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

const configStoreCommands = createConfigStoreCommands(commandHandler);
const { configCommand, storeCommand } = configStoreCommands;
const projectsCommands = createProjectsCommands(commandHandler);
const { projectCommand, projectsCommand, hereCommand } = projectsCommands;
const recordsCommands = createRecordsCommands(commandHandler, helpForCommand);
const {
	newCommand,
	showCommand,
	summaryCommand,
	startCommand,
	doneCommand,
	openCommand,
	editCommand,
} = recordsCommands;
const commentsCommands = createCommentsCommands(commandHandler, helpForCommand);
const { commentCommand, commentsCommand, updatesCommand, historyCommand } =
	commentsCommands;
const initiativesCommands = createInitiativesCommands(commandHandler);
const { initiativesCommand, initiativeCommand } = initiativesCommands;
const navigationCommands = createNavigationCommands(commandHandler);
const { listCommand, readyCommand, nextCommand, treeCommand, depsCommand } =
	navigationCommands;
const worktreeCommands = createWorktreeCommands(commandHandler);
const { worktreeCommand } = worktreeCommands;

const forgeRootCommand = CliCommand.make("forge", forgeRootOptions).pipe(
	CliCommand.withHandler(rootCommandHandler),
	CliCommand.withDescription("Forge personal workflow CLI"),
	CliCommand.withSubcommands([
		configCommand,
		storeCommand,
		projectCommand,
		newCommand,
		showCommand,
		summaryCommand,
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
		worktreeCommand,
		openCommand,
		editCommand,
		projectsCommand,
		hereCommand,
	]),
);

const helpText = renderRootHelp();

function helpWidth(output: CliOutput): number | undefined {
	return output.columns;
}

function helpColor(output: CliOutput): boolean {
	return output.isTTY === true;
}

function renderRootHelpForOutput(output: CliOutput): string {
	return renderRootHelp(rootHelpModel, {
		width: helpWidth(output),
		color: helpColor(output),
	});
}

const ansiEscapeCharacter = "\u001b";

function stripAnsi(text: string): string {
	return text.replace(
		new RegExp(`${ansiEscapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g"),
		"",
	);
}

/**
 * Effect CLI derives nested help usage from each descriptor's local command
 * name. Keep that semantic tree intact, but repair the known duplicated
 * prefixes when presenting a usage path to users.
 */
function normalizeDisplayedHelpPaths(text: string): string {
	return text
		.replace(/\bproject project root (add|remove)\b/g, "project root $1")
		.replace(
			/\binitiative initiative project (add|remove)\b/g,
			"initiative project $1",
		);
}

const cliCommandRegistrations: ReadonlyArray<CliCommandRegistration> = [
	...configStoreCommands.registrations,
	...projectsCommands.registrations.filter(
		(registration) => registration.path[0] === "project",
	),
	...recordsCommands.registrations.filter(
		(registration) =>
			registration.path[0] !== "open" && registration.path[0] !== "edit",
	),
	...commentsCommands.registrations,
	...initiativesCommands.registrations,
	...navigationCommands.registrations,
	...worktreeCommands.registrations,
	...recordsCommands.registrations.filter(
		(registration) =>
			registration.path[0] === "open" || registration.path[0] === "edit",
	),
	...projectsCommands.registrations.filter(
		(registration) =>
			registration.path[0] === "projects" || registration.path[0] === "here",
	),
];

const commandDescriptors = new Map(
	cliCommandRegistrations.map((registration) => [
		commandKey(registration.path),
		registration.descriptor,
	]),
);

function commandKey(path: ReadonlyArray<string>): string {
	return path.join(" ");
}

function helpForCommand(command: string, output?: CliOutput): string {
	const descriptor = commandDescriptors.get(command);
	if (descriptor === undefined) {
		return output === undefined ? helpText : renderRootHelpForOutput(output);
	}
	const text = normalizeDisplayedHelpPaths(
		HelpDoc.toAnsiText(
			CliCommand.getHelp(
				descriptor as Parameters<typeof CliCommand.getHelp>[0],
				CliConfig.defaultConfig,
			),
		),
	);
	return `${output !== undefined && !helpColor(output) ? stripAnsi(text) : text}\n`;
}

function applyRootInvocationOverrides(
	context: CliInvocationContext,
	argv: ReadonlyArray<string>,
): CliInvocationContext {
	let presentation = context.presentation;
	let cwd = context.cwd;
	let storeOverride = context.storeOverride;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--json") {
			presentation = "json";
			continue;
		}
		if (token === "--store") {
			storeOverride = argv[index + 1] ?? storeOverride;
			index += 1;
			continue;
		}
		if (token?.startsWith("--store=")) {
			storeOverride = token.slice("--store=".length);
			continue;
		}
		if (token === "--cwd" || token === "-C") {
			cwd = argv[index + 1] ?? cwd;
			index += 1;
			continue;
		}
		if (token?.startsWith("--cwd=")) {
			cwd = token.slice("--cwd=".length);
		}
	}
	return { ...context, presentation, cwd, storeOverride };
}

export function runCliMain(
	argv: ReadonlyArray<string> = defaultArgv(),
	options: CliOptions = {},
	exitCodeTarget: ExitCodeTarget = defaultExitCodeTarget(),
): Effect.Effect<void, never, CommandExecutor | FileSystem> {
	return runCliEffect(argv, options).pipe(
		Effect.map((code) => {
			exitCodeTarget.exitCode = code;
			return undefined;
		}),
	);
}

export function runCliEffect(
	argv: ReadonlyArray<string>,
	options: CliOptions = {},
): Effect.Effect<number, never, CommandExecutor | FileSystem> {
	const stderr = options.stderr ?? defaultStderr();
	return Effect.gen(function* () {
		const baseContext = applyRootInvocationOverrides(
			yield* createInvocationContextEffect(options),
			argv,
		);
		if (isHelpInvocation(argv)) {
			writeOut(
				baseContext.stdout,
				helpForCommand(helpCommandName(argv), baseContext.stdout),
			);
			return 0;
		}
		let output: CommandOutput = { value: undefined, code: 0 };
		const run = CliCommand.run(forgeRootCommand, {
			name: "forge",
			version: "0.0.0",
		});
		yield* run(["node", "forge", ...argv]).pipe(
			Effect.provideService(CliRuntimeContext, {
				invocationContext: baseContext,
				setOutput: (nextOutput) => {
					output = nextOutput;
				},
			}),
		) as unknown as Effect.Effect<void, unknown, CommandExecutor | FileSystem>;
		return output.code;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.sync(() => {
				writeOut(stderr, `${formatError(error)}\n`);
				return isForgeError(error) ? 2 : 1;
			}),
		),
	);
}

function createInvocationContextEffect(
	options: CliOptions,
): Effect.Effect<CliInvocationContext, ForgeError> {
	return Effect.try({
		try: () => {
			const stdout = options.stdout ?? defaultStdout();
			const stderr = options.stderr ?? defaultStderr();
			const env = options.env ?? defaultEnv();
			const homeDirectory = defaultHomeDirectory(env);
			if (homeDirectory === undefined) {
				throw usage("HOME must be set.");
			}
			return {
				presentation: "human",
				cwd: options.cwd ?? defaultCwd(),
				homeDirectory,
				stdin: options.stdin ?? defaultStdin(),
				stdout,
				stderr,
				env,
			};
		},
		catch: (error) =>
			error instanceof ForgeError
				? error
				: new ForgeError({
						kind: "config-invalid",
						message: String(error),
					}),
	});
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
	if (isWorktreeListResult(value)) {
		if (value.worktrees.length === 0) {
			return "No managed worktrees.";
		}
		return value.worktrees.map(formatWorktreeRecord).join("\n");
	}
	if (isWorktreeDoctorReport(value)) {
		if (value.ok) {
			return "Worktree store ok.";
		}
		return value.problems
			.map((problem) => `${problem.worktreeId}: ${problem.message}`)
			.join("\n");
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

function isWorktreeListResult(value: unknown): value is {
	worktrees: ReadonlyArray<{
		id: string;
		status: string;
		taskId: number;
		branch: string;
		worktreePath: string;
	}>;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"worktrees" in value &&
		Array.isArray((value as { worktrees: unknown }).worktrees)
	);
}

function isWorktreeDoctorReport(value: unknown): value is {
	ok: boolean;
	worktrees: number;
	problems: ReadonlyArray<{ worktreeId: string; message: string }>;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		"worktrees" in value &&
		"problems" in value &&
		Array.isArray((value as { problems: unknown }).problems)
	);
}

function formatWorktreeRecord(worktree: {
	readonly id: string;
	readonly status: string;
	readonly taskId: number;
	readonly branch: string;
	readonly worktreePath: string;
}): string {
	return `${worktree.id}\t${worktree.status}\ttask:${worktree.taskId}\t${worktree.branch}\t${worktree.worktreePath}`;
}

export function isCliEntrypoint(metaUrl = import.meta.url, argv1?: string) {
	return isNodeCliEntrypoint(metaUrl, argv1);
}

if (isCliEntrypoint()) {
	runForgeMain(runCliMain());
}
