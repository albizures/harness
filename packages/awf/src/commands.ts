import { randomUUID } from "node:crypto";
import { defaultManifest } from "./default-manifest.ts";
import { type Envelope, failure, success } from "./envelope.ts";
import {
	loadManifest,
	ManifestValidationError,
	type ManifestTransition,
	type WorkflowManifest,
} from "./manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	createInMemoryTracker,
	type Tracker,
} from "./tracker.ts";

type CommandSpec = {
	name: string;
	usage: string;
	description: string;
};

const commands: Array<CommandSpec> = [
	{
		name: "get",
		usage: "awf get <id>",
		description: "Return a workflow entity.",
	},
	{
		name: "ready",
		usage: "awf ready [--spec <id>]",
		description: "Return legally executable work.",
	},
	{
		name: "logs",
		usage: "awf logs <id>",
		description: "Return immutable workflow logs.",
	},
	{
		name: "spec create",
		usage: "awf spec create --title <title> --content <file>",
		description: "Create a Spec.",
	},
	{
		name: "plan apply",
		usage: "awf plan apply <spec> --input <plan.json>",
		description: "Apply a plan to a Spec.",
	},
	{
		name: "handoff",
		usage: "awf handoff <source> --input <handoff.json>",
		description: "Create a Handoff.",
	},
	{
		name: "manifest validate",
		usage: "awf manifest validate <file>",
		description: "Load and validate a workflow manifest.",
	},
	{
		name: "start",
		usage: "awf start <id>",
		description: "Start the current action.",
	},
	{
		name: "succeed",
		usage: "awf succeed <id> --run <run>",
		description: "Mark a run as succeeded.",
	},
	{
		name: "fail",
		usage: "awf fail <id> --run <run>",
		description: "Mark a run as failed.",
	},
];

export type ExecuteOptions = { tracker?: Tracker; manifest?: WorkflowManifest };

export async function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): Promise<Envelope> {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return success({
			name: "awf",
			description: "Agent workflow CLI.",
			commands,
		});
	}

	if (args[0] === "--version" || args[0] === "-v") {
		return success({ name: "@albizures/awf", version: "0.0.0" });
	}

	const parseError = validateKnownCommand(args);
	if (parseError !== undefined) {
		return parseError;
	}

	if (args[0] === "manifest" && args[1] === "validate") {
		return validateManifestCommand(args[2]);
	}

	const tracker = options.tracker ?? createInMemoryTracker();
	const manifest = options.manifest ?? defaultManifest;

	if (args[0] === "get") {
		return getIssueCommand(args[1], tracker);
	}
	if (args[0] === "logs") {
		return logsCommand(args[1], tracker);
	}
	if (args[0] === "start") {
		return startCommand(args[1], tracker, manifest);
	}
	if (args[0] === "succeed" || args[0] === "fail") {
		return terminalCommand(
			args[0],
			args[1],
			readOption(args, "--run"),
			tracker,
			manifest,
		);
	}

	return failure(
		"NOT_IMPLEMENTED",
		"This workflow command is not implemented yet.",
		{
			command: args.join(" "),
		},
	);
}

function validateKnownCommand(args: Array<string>): Envelope | undefined {
	const [command, subcommand] = args;

	switch (command) {
		case "get":
		case "logs":
		case "start":
			return requirePositionalCount(args, 1, `awf ${command} <id>`);
		case "ready":
			return validateReady(args);
		case "handoff":
			return requirePositionalAndOption(
				args,
				"awf handoff <source> --input <handoff.json>",
				"--input",
			);
		case "succeed":
		case "fail":
			return requirePositionalAndOption(
				args,
				`awf ${command} <id> --run <run>`,
				"--run",
			);
		case "spec":
			if (subcommand !== "create") {
				return unknownCommand(args);
			}
			return requireOptions(
				args,
				"awf spec create --title <title> --content <file>",
				["--title", "--content"],
			);
		case "plan":
			if (subcommand !== "apply") {
				return unknownCommand(args);
			}
			return requirePositionalAndOption(
				args,
				"awf plan apply <spec> --input <plan.json>",
				"--input",
				2,
			);
		case "manifest":
			if (subcommand !== "validate") {
				return unknownCommand(args);
			}
			return requirePositionalCount(args, 1, "awf manifest validate <file>", 2);
		default:
			return unknownCommand(args);
	}
}

const READY_WITH_SPEC_ARGUMENT_COUNT = 3;

function validateReady(args: Array<string>): Envelope | undefined {
	if (args.length === 1) {
		return undefined;
	}
	if (
		args.length === READY_WITH_SPEC_ARGUMENT_COUNT &&
		args[1] === "--spec" &&
		args[2] !== ""
	) {
		return undefined;
	}
	return failure("INVALID_ARGUMENTS", "Invalid arguments for ready.", {
		usage: "awf ready [--spec <id>]",
	});
}

function requirePositionalCount(
	args: Array<string>,
	count: number,
	usage: string,
	offset = 1,
): Envelope | undefined {
	const positionals = args.slice(offset).filter((arg) => !arg.startsWith("-"));
	if (positionals.length === count && args.length === offset + count) {
		return undefined;
	}

	return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}

function requirePositionalAndOption(
	args: Array<string>,
	usage: string,
	optionName: string,
	prefixPositionals = 1,
): Envelope | undefined {
	const prefix = args.slice(1, 1 + prefixPositionals);
	const optionIndex = args.indexOf(optionName);
	if (
		prefix.every(
			(arg) => arg !== undefined && arg !== "" && !arg.startsWith("-"),
		) &&
		optionIndex === 1 + prefixPositionals &&
		args[optionIndex + 1] !== undefined &&
		args[optionIndex + 1] !== "" &&
		args.length === optionIndex + 2
	) {
		return undefined;
	}

	return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}

function requireOptions(
	args: Array<string>,
	usage: string,
	optionNames: Array<string>,
): Envelope | undefined {
	if (args.length !== 2 + optionNames.length * 2) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}

	for (const optionName of optionNames) {
		const optionIndex = args.indexOf(optionName);
		if (
			optionIndex === -1 ||
			args[optionIndex + 1] === undefined ||
			args[optionIndex + 1] === ""
		) {
			return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage,
			});
		}
	}

	return undefined;
}

async function getIssueCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf get <id>",
		});
	}

	try {
		const issue = await tracker.getIssue(id);
		const logs = await tracker.readLogs(id);
		return success({
			issue,
			runs: deriveRuns(issue.workflow.activeRunId, logs),
		});
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		if (error instanceof CorruptWorkflowProjectionError) {
			return failure("CORRUPT_WORKFLOW_PROJECTION", error.message, { id });
		}
		throw error;
	}
}

async function logsCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf logs <id>",
		});
	}

	try {
		return success({ logs: await tracker.readLogs(id) });
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		throw error;
	}
}

async function startCommand(
	id: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf start <id>",
		});
	}

	try {
		const issue = await tracker.getIssue(id);
		const transition = findTransition(manifest, issue.workflow, "start");
		if (transition === undefined) {
			return invalidTransition(id, "start");
		}
		const runId = `run-${randomUUID()}`;
		const updated = await tracker.updateIssue(id, {
			expect: {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			},
			workflow: { ...workflowTarget(transition.to), activeRunId: runId },
		});
		const log = await tracker.appendLog(id, {
			type: "action_started",
			runId,
			payload: { event: "start", to: cleanTransitionTarget(transition.to) },
		});
		return success({ issue: updated, run: { id: runId }, log });
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function terminalCommand(
	event: "succeed" | "fail",
	id: string | undefined,
	runId: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	if (id === undefined || runId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf ${event} <id> --run <run>`,
		});
	}

	try {
		const logs = await tracker.readLogs(id);
		const terminalPayload = terminalLogPayload(
			manifest,
			await tracker.getIssue(id),
			event,
		);
		const existing = logs.find(
			(log) => log.runId === runId && isTerminalLog(log.type),
		);
		const logType = terminalLogType(event);
		if (existing !== undefined) {
			if (
				existing.type === logType &&
				stableStringify(existing.payload) === stableStringify(terminalPayload)
			) {
				const issue = await tracker.getIssue(id);
				return success({
					issue,
					run: { id: runId, status: event },
					log: existing,
				});
			}
			return failure(
				"CONFLICTING_TERMINAL_OUTCOME",
				"Workflow run already has a different terminal outcome.",
				{ id, runId },
			);
		}

		const issue = await tracker.getIssue(id);
		if (issue.workflow.activeRunId !== runId) {
			return failure(
				"RUN_MISMATCH",
				"Command run id does not match the active workflow run.",
				{
					id,
					...(issue.workflow.activeRunId === undefined
						? {}
						: { activeRunId: issue.workflow.activeRunId }),
					runId,
				},
			);
		}
		const transition = findTransition(manifest, issue.workflow, event);
		if (transition === undefined) {
			return invalidTransition(id, event);
		}
		const updated = await tracker.updateIssue(id, {
			expect: {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			},
			workflow: { ...workflowTarget(transition.to), activeRunId: undefined },
		});
		const log = await tracker.appendLog(id, {
			type: logType,
			runId,
			payload: { event, to: cleanTransitionTarget(transition.to) },
		});
		return success({ issue: updated, run: { id: runId, status: event }, log });
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function validateManifestCommand(
	path: string | undefined,
): Promise<Envelope> {
	if (path === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf manifest validate <file>",
		});
	}

	try {
		const manifest = await loadManifest(path);
		return success({
			manifest: manifest.workflow.id,
			version: manifest.version,
			kinds: manifest.kinds.map((kind) => kind.id),
		});
	} catch (error) {
		if (error instanceof ManifestValidationError) {
			return failure(
				"MANIFEST_VALIDATION_FAILED",
				"Workflow manifest validation failed.",
				{ issues: error.issues },
			);
		}
		return failure(
			"MANIFEST_LOAD_FAILED",
			"Workflow manifest could not be loaded.",
			{ message: error instanceof Error ? error.message : String(error) },
		);
	}
}

type WorkflowFields = {
	kind: string;
	state: string;
	action?: string;
	reason?: string;
	activeRunId?: string;
};

function readOption(args: Array<string>, name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function findTransition(
	manifest: WorkflowManifest,
	workflow: WorkflowFields,
	event: string,
): ManifestTransition | undefined {
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === workflow.kind,
	);
	return kind?.transitions.find(
		(transition) =>
			transition.event === event && fieldsMatch(transition.from, workflow),
	);
}

function fieldsMatch(
	from: ManifestTransition["from"],
	workflow: WorkflowFields,
): boolean {
	return (
		from.state === workflow.state &&
		from.action === workflow.action &&
		from.reason === workflow.reason
	);
}

function invalidTransition(id: string, event: string): Envelope {
	return failure(
		"INVALID_TRANSITION",
		"No manifest transition matches the current workflow fields for this event.",
		{ id, event },
	);
}

function lifecycleError(id: string, error: unknown): Envelope {
	if (error instanceof IssueNotFoundError) {
		return failure("NOT_FOUND", error.message, { id });
	}
	if (error instanceof CorruptWorkflowProjectionError) {
		return failure("CORRUPT_WORKFLOW_PROJECTION", error.message, { id });
	}
	throw error;
}

function terminalLogType(event: "succeed" | "fail"): string {
	return event === "succeed" ? "action_succeeded" : "action_failed";
}

function isTerminalLog(type: string): boolean {
	return type === "action_succeeded" || type === "action_failed";
}

function terminalLogPayload(
	manifest: WorkflowManifest,
	issue: { workflow: WorkflowFields },
	event: "succeed" | "fail",
): unknown {
	const transition = findTransition(manifest, issue.workflow, event);
	return {
		event,
		to: cleanTransitionTarget(transition?.to ?? issue.workflow),
	};
}

function workflowTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): { state: string; action?: string; reason?: string } {
	return {
		state: target.state,
		...(target.action === undefined ? {} : { action: target.action }),
		...(target.reason === undefined || target.reason === null
			? {}
			: { reason: target.reason }),
	};
}

function cleanTransitionTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): Record<string, string | null> {
	return Object.fromEntries(
		Object.entries({
			state: target.state,
			action: target.action,
			reason: target.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string | null>;
}

function deriveRuns(
	activeRunId: string | undefined,
	logs: Array<{ type: string; runId?: string }>,
): {
	activeRunId?: string;
	attempts: Array<{ runId: string; status: string }>;
} {
	const attempts = new Map<string, { runId: string; status: string }>();
	for (const log of logs) {
		if (log.runId === undefined) {
			continue;
		}
		if (!attempts.has(log.runId)) {
			attempts.set(log.runId, { runId: log.runId, status: "unknown" });
		}
		const attempt = attempts.get(log.runId);
		if (attempt === undefined) {
			continue;
		}
		if (log.type === "action_started") {
			attempt.status = "running";
		}
		if (log.type === "action_succeeded") {
			attempt.status = "succeeded";
		}
		if (log.type === "action_failed") {
			attempt.status = "failed";
		}
	}
	if (activeRunId !== undefined && !attempts.has(activeRunId)) {
		attempts.set(activeRunId, { runId: activeRunId, status: "running" });
	}
	return { activeRunId, attempts: [...attempts.values()] };
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function unknownCommand(args: Array<string>): Envelope {
	return failure("UNKNOWN_COMMAND", "Unknown command.", {
		command: args.join(" "),
	});
}
