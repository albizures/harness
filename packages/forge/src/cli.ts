#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { text as readStreamText } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as Command from "@effect/platform/Command";
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
	loadForgeConfig,
	storeDoctor,
	writeForgeConfig,
} from "./filesystem-store.ts";
import {
	addProject,
	addProjectRoot,
	inferProjectByPath,
	listProjects,
	removeProject,
	removeProjectRoot,
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

type Presentation = "human" | "json" | "plain";

type FlagValue = string | boolean | ReadonlyArray<string>;

type Parsed = {
	readonly positionals: ReadonlyArray<string>;
	readonly flags: Readonly<Record<string, FlagValue>>;
	readonly presentation: Presentation;
	readonly cwd: string;
	readonly homeDirectory: string;
	readonly storeOverride?: string;
	readonly stdin: NodeJS.ReadableStream;
	readonly env: NodeJS.ProcessEnv;
};

const helpText = `Forge personal workflow CLI

Usage:
  forge [--json|--plain] [--store <path>] [--cwd <path>] <command>

Commands:
  forge config get [storePath]
  forge config set storePath <absolute-path>
  forge store path
  forge store doctor
  forge project add <id> --root <path> [--name <name>] [--remote <url>]
  forge project root add <id> <path>
  forge project root remove <id> <path>
  forge project remove <id>
  forge new initiative --title <title> (--body <md>|--body-file <file>|--body -) --projects <ids>
  forge new wayfinder --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>|--projects <ids>|--initiative <id>|--scope global]
  forge new spec --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>] [--initiative <id>] [--generated-by <id>]
  forge new task --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--kind research|prototype|review] [--depends-on <id>]...
  forge new grilling --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--depends-on <id>]...
  forge show <record>
  forge start <record>
  forge done <record> --resolution <slug>
  forge comment <record> --message <md>
  forge comment <record> --message-file <file>
  forge comment <record> --message -
  forge comment edit <record> <comment-id>
  forge comments <record>
  forge updates <record>
  forge history <record>
  forge initiatives [--project <id>|--all-records]
  forge initiative attach <initiative> <record>
  forge initiative detach <initiative> <record>
  forge initiative project add <initiative> <project>
  forge initiative project remove <initiative> <project>
  forge list [--state <state>] [--kind <kind>] [--project <id>|--initiative <id>|--all-records]
  forge ready [--json] [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]
  forge ready --blocked [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]
  forge next [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]
  forge tree <record>
  forge deps <record>
  forge deps add <record> --depends-on <id>
  forge deps remove <record> --depends-on <id>
  forge open <record>
  forge edit <record>
  forge projects
  forge here
`;

const recentCommentLimit = 3;
const recentUpdateLimit = 5;

const commandHelp: Record<string, string> = {
	config: `Usage:\n  forge config get [storePath]\n  forge config set storePath <absolute-path>\n`,
	store: `Usage:\n  forge store path\n  forge store doctor\n`,
	project: `Usage:\n  forge project add <id> --root <path> [--name <name>] [--remote <url>]\n  forge project root add <id> <path>\n  forge project root remove <id> <path>\n  forge project remove <id>\n`,
	new: `Usage:\n  forge new initiative --title <title> (--body <md>|--body-file <file>|--body -) --projects <ids>\n  forge new wayfinder --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>|--projects <ids>|--initiative <id>|--scope global]\n  forge new spec --title <title> (--body <md>|--body-file <file>|--body -) [--project <id>] [--initiative <id>] [--generated-by <id>]\n  forge new task --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--kind research|prototype|review] [--depends-on <id>]...\n  forge new grilling --title <title> (--description <md>|--description-file <file>|--description -) --parent <id> [--depends-on <id>]...\n`,
	show: `Usage:\n  forge show <record>\n`,
	start: `Usage:\n  forge start <record>\n`,
	done: `Usage:\n  forge done <record> --resolution <slug>\n`,
	comment: `Usage:\n  forge comment <record> --message <md>\n  forge comment <record> --message-file <file>\n  forge comment <record> --message -\n  forge comment edit <record> <comment-id>\n`,
	comments: `Usage:\n  forge comments <record>\n`,
	updates: `Usage:\n  forge updates <record>\n`,
	history: `Usage:\n  forge history <record>\n`,
	initiatives: `Usage:\n  forge initiatives [--project <id>|--all-records]\n`,
	initiative: `Usage:\n  forge initiative attach <initiative> <record>\n  forge initiative detach <initiative> <record>\n  forge initiative project add <initiative> <project>\n  forge initiative project remove <initiative> <project>\n`,
	list: `Usage:\n  forge list [--state <state>] [--kind <kind>] [--project <id>|--initiative <id>|--all-records]\n`,
	ready: `Usage:\n  forge ready [--json] [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]\n  forge ready --blocked [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]\n\nJSON output is not supported with --blocked.\n`,
	next: `Usage:\n  forge next [--include-hitl] [--planning] [--project <id>|--initiative <id>|--all-records]\n`,
	tree: `Usage:\n  forge tree <record>\n`,
	deps: `Usage:\n  forge deps <record>\n  forge deps add <record> --depends-on <id>\n  forge deps remove <record> --depends-on <id>\n`,
	open: `Usage:\n  forge open <record>\n`,
	edit: `Usage:\n  forge edit <record>\n`,
	projects: `Usage:\n  forge projects\n`,
	here: `Usage:\n  forge here\n`,
};

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
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	try {
		const parsed = parseArgs(argv, options);
		const [command, subcommand, ...rest] = parsed.positionals;
		if (command === undefined) {
			writeOut(stdout, helpText);
			return 0;
		}
		if (
			parsed.flags.help === true ||
			subcommand === "help" ||
			rest.includes("help")
		) {
			writeOut(stdout, commandHelp[command] ?? helpText);
			return 0;
		}

		switch (command) {
			case "config":
				return await runConfig(parsed, subcommand, rest, stdout);
			case "store":
				return await runStore(parsed, subcommand, stdout);
			case "project":
				return await runProject(parsed, subcommand, rest, stdout);
			case "new":
				return await runNew(parsed, subcommand, rest, stdout);
			case "show":
				return await runShow(parsed, subcommand, rest, stdout);
			case "start":
				return await runStart(parsed, subcommand, rest, stdout);
			case "done":
				return await runDone(parsed, subcommand, rest, stdout);
			case "comment":
				return await runComment(parsed, subcommand, rest, stdout);
			case "comments":
				return await runComments(parsed, subcommand, rest, stdout);
			case "updates":
				return await runUpdates(parsed, subcommand, rest, stdout);
			case "history":
				return await runHistory(parsed, subcommand, rest, stdout);
			case "initiatives":
				return await runInitiatives(parsed, subcommand, rest, stdout);
			case "initiative":
				return await runInitiative(parsed, subcommand, rest, stdout);
			case "list":
				return await runList(parsed, subcommand, rest, stdout);
			case "ready":
				return await runReady(parsed, subcommand, rest, stdout);
			case "next":
				return await runNext(parsed, subcommand, rest, stdout);
			case "tree":
				return await runTree(parsed, subcommand, rest, stdout);
			case "deps":
				return await runDeps(parsed, subcommand, rest, stdout);
			case "open":
				return await runOpen(parsed, subcommand, rest, stdout);
			case "edit":
				return await runEdit(parsed, subcommand, rest, stdout);
			case "projects":
				return await runProjects(parsed, stdout);
			case "here":
				return await runHere(parsed, stdout);
			default:
				throw usage(`Unknown command '${command}'. Run forge --help.`);
		}
	} catch (error) {
		writeOut(stderr, `${formatError(error)}\n`);
		return isForgeError(error) ? 2 : 1;
	}
}

async function runConfig(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		return present(
			stdout,
			parsed,
			key === "storePath" ? config.storePath : config,
		);
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
		return present(stdout, parsed, { updated: true, ...config });
	}
	throw usage(commandHelp.config);
}

async function runStore(
	parsed: Parsed,
	subcommand: string | undefined,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const storePath = await resolveStorePath(parsed);
	if (subcommand === "path") {
		return present(stdout, parsed, storePath);
	}
	if (subcommand === "doctor") {
		const report = await storeDoctor({ storePath });
		return present(stdout, parsed, report, report.ok ? 0 : 2);
	}
	throw usage(commandHelp.store);
}

async function runProject(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		return present(stdout, parsed, await addProject({ storePath, ...input }));
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
			stdout,
			parsed,
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
		return present(stdout, parsed, { removed: id });
	}
	throw usage(commandHelp.project);
}

async function runNew(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
	return present(stdout, parsed, record);
}

async function runShow(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		return present(stdout, parsed, shown);
	}
	writeOut(stdout, `${formatShownRecord(shown)}\n`);
	return 0;
}

async function runStart(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.start);
	return present(
		stdout,
		parsed,
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
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.done);
	const resolution = getRequiredFlag(parsed, "resolution", commandHelp.done);
	return present(
		stdout,
		parsed,
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
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		await writeFile(
			temporaryPath,
			formatRecordCommentMarkdown(existing),
			"utf8",
		);
		try {
			await runEditor(temporaryPath, parsed);
			const edited = await replaceRecordCommentFromEditedMarkdown({
				storePath,
				recordId,
				commentId,
				markdown: await readFile(temporaryPath, "utf8"),
			});
			return present(stdout, parsed, { updated: true, comment: edited });
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}
	const id = singleRecordId(subcommand, rest, commandHelp.comment);
	const comment = await addRecordComment({
		storePath,
		recordId: id,
		body: await readProse(parsed, "message"),
	});
	return present(stdout, parsed, comment);
}

async function runComments(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.comments);
	const comments = await listRecordComments(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(stdout, parsed, comments);
	}
	writeOut(stdout, `${formatRecordComments(comments)}\n`);
	return 0;
}

async function runUpdates(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.updates);
	const updates = await listRecordUpdates(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(stdout, parsed, updates);
	}
	writeOut(stdout, `${formatRecordUpdates(updates)}\n`);
	return 0;
}

async function runHistory(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.history);
	const history = await listRecordHistory(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(stdout, parsed, history);
	}
	writeOut(stdout, `${formatRecordHistory(history)}\n`);
	return 0;
}

async function runInitiatives(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		stdout,
		parsed,
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
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
			stdout,
			parsed,
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
			stdout,
			parsed,
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
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		stdout,
		parsed,
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
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
		return present(stdout, parsed, readyJsonContract(diagnoses, records));
	}
	writeOut(
		stdout,
		`${formatReadinessDiagnoses(diagnoses, records, parsed.flags.blocked === true)}\n`,
	);
	return 0;
}

async function runNext(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	if (subcommand !== undefined || rest.length > 0) {
		throw usage(commandHelp.next);
	}
	const storePath = await readyStore(parsed);
	const record = await selectNextWorkflowRecord(storePath, {
		...(await navigationQueryOptions(parsed, storePath)),
		includeHitl: parsed.flags["include-hitl"] === true,
		planning: parsed.flags.planning === true,
	});
	return present(stdout, parsed, record ?? null);
}

async function runTree(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.tree);
	const tree = await readRecordTree(await readyStore(parsed), id);
	if (parsed.presentation === "json") {
		return present(stdout, parsed, tree);
	}
	writeOut(stdout, `${formatRecordTree(tree)}\n`);
	return 0;
}

async function runDeps(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
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
			stdout,
			parsed,
			subcommand === "add"
				? await addWorkflowRecordDependency(input)
				: await removeWorkflowRecordDependency(input),
		);
	}
	const id = singleRecordId(subcommand, rest, commandHelp.deps);
	const view = await readRecordDependencyView(storePath, id);
	if (parsed.presentation === "json") {
		return present(stdout, parsed, view);
	}
	writeOut(stdout, `${formatDependencyView(view)}\n`);
	return 0;
}

async function runOpen(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.open);
	const storePath = await readyStore(parsed);
	const locator = await locateWorkflowRecord(storePath, id);
	return present(stdout, parsed, recordFilePath(storePath, locator.kind, id));
}

async function runEdit(
	parsed: Parsed,
	subcommand: string | undefined,
	rest: ReadonlyArray<string>,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const id = singleRecordId(subcommand, rest, commandHelp.edit);
	const storePath = await readyStore(parsed);
	const locator = await locateWorkflowRecord(storePath, id);
	const filePath = recordFilePath(storePath, locator.kind, id);
	const temporaryPath = parseAbsolutePath(
		`${filePath}.edit-${process.pid}-${Date.now()}`,
		"temporaryPath",
	);
	await writeFile(temporaryPath, await readFile(filePath, "utf8"), "utf8");
	try {
		await runEditor(temporaryPath, parsed);
		const edited = await replaceWorkflowRecordFromEditedMarkdown({
			storePath,
			recordId: id,
			markdown: await readFile(temporaryPath, "utf8"),
		});
		return present(stdout, parsed, { updated: true, record: edited });
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function runProjects(
	parsed: Parsed,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	return present(stdout, parsed, await listProjects(await readyStore(parsed)));
}

async function runHere(
	parsed: Parsed,
	stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<number> {
	const project = await inferProjectByPath({
		storePath: await readyStore(parsed),
		cwd: parseAbsolutePath(parsed.cwd, "cwd"),
	});
	if (project === undefined) {
		throw new ForgeError({
			kind: "project-not-found",
			message:
				"No registered project matches the current directory. Run `forge project add <id> --root <path>`.",
		});
	}
	return present(stdout, parsed, project);
}

function parseArgs(argv: ReadonlyArray<string>, options: CliOptions): Parsed {
	const flags: Record<string, FlagValue> = {};
	const positionals: Array<string> = [];
	let index = 0;
	while (index < argv.length) {
		const token = argv[index];
		if (token === undefined) {
			break;
		}
		if (!token.startsWith("-")) {
			positionals.push(token);
			index += 1;
			continue;
		}
		const flagName = flagAlias(token);
		if (
			flagName === "help" ||
			flagName === "json" ||
			flagName === "plain" ||
			flagName === "quiet" ||
			flagName === "verbose" ||
			flagName === "all-records" ||
			flagName === "blocked" ||
			flagName === "include-hitl" ||
			flagName === "planning"
		) {
			flags[flagName] = true;
			index += 1;
			continue;
		}
		const value = argv[index + 1];
		if (value === undefined || (value.startsWith("-") && value !== "-")) {
			throw usage(`Flag ${token} requires a value.`);
		}
		const current = flags[flagName];
		if (current === undefined || typeof current === "boolean") {
			flags[flagName] = value;
		} else if (typeof current === "string") {
			flags[flagName] = [current, value];
		} else {
			flags[flagName] = [...current, value];
		}
		index += 2;
	}
	const cwd = stringFlag(flags.cwd) ?? options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const homeDirectory = env.FORGE_HOME ?? env.HOME ?? process.env.HOME;
	if (homeDirectory === undefined) {
		throw usage("HOME must be set.");
	}
	let presentation: Presentation = "human";
	if (flags.json === true) {
		presentation = "json";
	} else if (flags.plain === true) {
		presentation = "plain";
	}
	return {
		positionals,
		flags,
		presentation,
		cwd,
		homeDirectory,
		storeOverride: stringFlag(flags.store),
		stdin: options.stdin ?? process.stdin,
		env,
	};
}

function flagAlias(token: string): string {
	switch (token) {
		case "-h":
		case "--help":
			return "help";
		case "-C":
		case "--cwd":
			return "cwd";
		case "--store":
			return "store";
		case "--json":
			return "json";
		case "--plain":
			return "plain";
		case "-q":
		case "--quiet":
			return "quiet";
		case "-v":
		case "--verbose":
			return "verbose";
		case "--root":
			return "root";
		case "--name":
			return "name";
		case "--remote":
			return "remote";
		case "--title":
			return "title";
		case "--body":
			return "body";
		case "--body-file":
			return "body-file";
		case "--description":
			return "description";
		case "--description-file":
			return "description-file";
		case "--parent":
			return "parent";
		case "--kind":
			return "kind";
		case "--depends-on":
			return "depends-on";
		case "--project":
			return "project";
		case "--projects":
			return "projects";
		case "--initiative":
			return "initiative";
		case "--scope":
			return "scope";
		case "--generated-by":
			return "generated-by";
		case "--resolution":
			return "resolution";
		case "--message":
			return "message";
		case "--message-file":
			return "message-file";
		case "--state":
			return "state";
		case "--blocked":
			return "blocked";
		case "--include-hitl":
			return "include-hitl";
		case "--planning":
			return "planning";
		case "--all-records":
			return "all-records";
		default:
			throw usage(`Unknown flag '${token}'.`);
	}
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
		return readFile(file, "utf8");
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

async function runEditor(
	filePath: AbsolutePath,
	parsed: Parsed,
): Promise<void> {
	return runForgePromise(runEditorEffect(filePath, parsed));
}

function runEditorEffect(filePath: AbsolutePath, parsed: Parsed) {
	const editor = parsed.env?.EDITOR ?? process.env.EDITOR;
	if (editor === undefined || editor.trim() === "") {
		return Effect.fail(usage("EDITOR must be set to edit records."));
	}
	return Command.make(`${editor} ${shellQuote(filePath)}`).pipe(
		Command.runInShell(true),
		Command.stdin("inherit"),
		Command.stdout("inherit"),
		Command.stderr("inherit"),
		Command.env(parsed.env),
		Command.exitCode,
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

async function readyStore(parsed: Parsed) {
	const storePath = await resolveStorePath(parsed);
	await ensureStoreRoot({ storePath });
	return storePath;
}

function present(
	stdout: Pick<NodeJS.WriteStream, "write">,
	parsed: Parsed,
	value: unknown,
	code = 0,
): number {
	if (parsed.presentation === "json") {
		writeOut(stdout, `${JSON.stringify(value, null, "\t")}\n`);
		return code;
	}
	writeOut(stdout, `${formatHuman(value)}\n`);
	return code;
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
