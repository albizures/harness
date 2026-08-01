import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defaultManifest } from "./default-manifest.ts";
import { type Envelope, failure, success } from "./envelope.ts";
import type { JsonValue } from "type-fest";
import {
	loadManifest,
	ManifestValidationError,
	validateManifest,
	type ManifestCommand,
	type ManifestNamedReadinessFilter,
	type PayloadZodSchema,
	type ManifestTransition,
	type WorkflowManifest,
} from "./manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	NeedReconciliationError,
	ProjectionConflictError,
	createInMemoryTracker,
	type Tracker,
} from "./tracker.ts";

type CommandSpec = {
	name: string;
	usage: string;
	description: string;
};

type HelpReadinessFilterSpec = {
	kind?: string;
	state?: string;
	action?: string;
	reason?: string;
};

type HelpNamedReadinessFilterSpec = {
	name: string;
	kind: string;
	relationship: "parent";
	usage: string;
};

const maxReconcileArgumentCount = 3;
const createHandoffArgumentCount = 6;

const runtimeCommands: Array<CommandSpec> = [
	{
		name: "get",
		usage: "awf get <id>",
		description: "Return a workflow entity.",
	},
	{
		name: "ready",
		usage: "awf ready [--filter <name=value>] [--limit <n>]",
		description: "Return legally executable work.",
	},
	{
		name: "logs",
		usage: "awf logs <id>",
		description: "Return immutable workflow logs.",
	},
	{
		name: "reconcile",
		usage: "awf reconcile <id> [--apply]",
		description:
			"Diagnose workflow projection/log drift and apply safe repairs.",
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
		usage: "awf succeed <id> --run <run> --input <file|->",
		description: "Mark a run as succeeded.",
	},
	{
		name: "fail",
		usage: "awf fail <id> --run <run> --input <file|->",
		description: "Mark a run as failed.",
	},
	{
		name: "escalate",
		usage: "awf escalate <id> --input <file|->",
		description: "Move work to need-human/none with a human-readable reason.",
	},
	{
		name: "resume",
		usage: "awf resume <id> --action <action>",
		description: "Resume need-human work at a valid ready action.",
	},
];

export type ExecuteOptions = {
	tracker?: Tracker;
	manifest?: WorkflowManifest;
	stdin?: string;
};

export async function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): Promise<Envelope> {
	const manifest = options.manifest ?? defaultManifest;
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return success({
			name: "awf",
			description: "Agent workflow CLI.",
			commands: helpCommands(manifest),
			readiness: helpReadiness(manifest),
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
	const manifestIssues = validateManifest(manifest);
	if (manifestIssues.length > 0) {
		return failure(
			"MANIFEST_VALIDATION_FAILED",
			"Workflow manifest validation failed.",
			{ issues: manifestIssues },
		);
	}

	if (args[0] === "get") {
		return getIssueCommand(args[1], tracker);
	}
	if (args[0] === "logs") {
		return logsCommand(args[1], tracker);
	}
	if (args[0] === "reconcile") {
		return reconcileCommand(args[1], args.includes("--apply"), tracker);
	}
	if (args[0] === "ready") {
		return readyCommand(parseReadyOptions(args), tracker, manifest);
	}
	if (args[0] === "create" || args[0] === "apply") {
		return manifestCommand(args, tracker, manifest, options.stdin);
	}
	if (args[0] === "start") {
		return startCommand(args[1], tracker, manifest);
	}
	if (args[0] === "succeed" || args[0] === "fail") {
		return terminalCommand(
			args[0],
			args[1],
			readOption(args, "--run"),
			readOption(args, "--input"),
			tracker,
			manifest,
			options.stdin,
		);
	}
	if (args[0] === "escalate") {
		return escalateCommand(
			args[1],
			readOption(args, "--input"),
			tracker,
			manifest,
			options.stdin,
		);
	}
	if (args[0] === "resume") {
		return resumeCommand(
			args[1],
			readOption(args, "--action"),
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

async function manifestCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
): Promise<Envelope> {
	const verb = args[0] as "create" | "apply";
	const target = args[1];
	const command = workflowCommandByCli(manifest, verb, target);
	if (command === undefined) {
		return failure(
			"UNKNOWN_COMMAND_TARGET",
			"Workflow command target is not declared by the manifest.",
			{
				command: `${verb} ${target}`,
			},
		);
	}
	if (command.id === "spec-create") {
		return createSpecCommand(
			readOption(args, "--input"),
			tracker,
			manifest,
			stdin,
			command,
		);
	}
	if (command.id === "handoff-create") {
		return createHandoffCommand(
			readOption(args, "--source"),
			readOption(args, "--input"),
			tracker,
			manifest,
			stdin,
			command,
		);
	}
	if (command.id === "plan-apply") {
		return applyPlanCommand(
			args[2],
			readOption(args, "--input"),
			tracker,
			manifest,
			stdin,
			command,
		);
	}
	if (verb === "create") {
		return createGenericWorkflowIssueCommand(
			readOption(args, "--input"),
			tracker,
			manifest,
			stdin,
			command,
		);
	}
	return applyGenericWorkflowCommand(
		args[2],
		readOption(args, "--input"),
		tracker,
		stdin,
		command,
	);
}

function helpCommands(manifest: WorkflowManifest): Array<CommandSpec> {
	return [
		...runtimeCommands,
		...manifest.commands.flatMap((command) => {
			if (command.cli === undefined) {
				return [];
			}
			return [
				{
					name: `${command.cli.verb} ${command.cli.target}`,
					usage: manifestCommandUsage(command),
					description: `Run manifest command '${command.id}'.`,
				},
			];
		}),
	];
}

function manifestCommandUsage(command: ManifestCommand): string {
	if (command.cli?.verb === "apply") {
		return `awf apply ${command.cli.target} <issue> --input <file|->`;
	}
	if (command.id === "handoff-create") {
		return `awf create ${command.cli?.target ?? "handoff"} --source <issue> --input <file|->`;
	}
	return `awf create ${command.cli?.target ?? "target"} --input <file|->`;
}

function helpReadiness(manifest: WorkflowManifest): {
	filters: Array<HelpReadinessFilterSpec>;
	namedFilters: Array<HelpNamedReadinessFilterSpec>;
} {
	return {
		filters: readinessFilters(manifest).map((filter) => ({ ...filter })),
		namedFilters: (manifest.readiness?.namedFilters ?? []).map((filter) => ({
			...filter,
			usage: `awf ready --filter ${filter.name}=<${filter.kind}>`,
		})),
	};
}

function validateKnownCommand(args: Array<string>): Envelope | undefined {
	const [command, subcommand] = args;

	switch (command) {
		case "get":
		case "logs":
		case "start":
			return requirePositionalCount(args, 1, `awf ${command} <id>`);
		case "reconcile":
			return validateReconcile(args);
		case "ready":
			return validateReady(args);
		case "succeed":
		case "fail":
			return validateTerminalArguments(args, command);
		case "escalate":
			return requirePositionalAndOption(
				args,
				"awf escalate <id> --input <file|->",
				"--input",
				1,
			);
		case "resume":
			return requirePositionalAndOption(
				args,
				"awf resume <id> --action <action>",
				"--action",
				1,
			);
		case "create":
			return validateManifestCommandArguments(args, "create");
		case "apply":
			return validateManifestCommandArguments(args, "apply");
		case "manifest":
			if (subcommand !== "validate") {
				return unknownCommand(args);
			}
			return requirePositionalCount(args, 1, "awf manifest validate <file>", 2);
		default:
			return unknownCommand(args);
	}
}

function validateReady(args: Array<string>): Envelope | undefined {
	const options = parseReadyOptions(args);
	if (
		options.error === undefined &&
		options.limit !== undefined &&
		(!Number.isInteger(options.limit) || options.limit < 1)
	) {
		return invalidReadyArguments();
	}
	return options.error === undefined ? undefined : invalidReadyArguments();
}

function validateManifestCommandArguments(
	args: Array<string>,
	verb: "create" | "apply",
): Envelope | undefined {
	const target = args[1];
	if (target === undefined || target === "" || target.startsWith("-")) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf ${verb} <target> ...`,
		});
	}
	if (verb === "create") {
		if (args.includes("--source")) {
			const usage = `awf create ${target} --source <issue> --input <file|->`;
			const source = readOption(args, "--source");
			const input = readOption(args, "--input");
			const allowed = new Set([
				"create",
				target,
				"--source",
				"--input",
				...(source === undefined ? [] : [source]),
				...(input === undefined ? [] : [input]),
			]);
			if (
				source !== undefined &&
				source !== "" &&
				!source.startsWith("-") &&
				input !== undefined &&
				input !== "" &&
				args.length === createHandoffArgumentCount &&
				args.every((arg) => allowed.has(arg))
			) {
				return undefined;
			}
			return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage,
			});
		}
		return requirePositionalAndOption(
			args,
			`awf create ${target} --input <file|->`,
			"--input",
			1,
		);
	}
	return requirePositionalAndOption(
		args,
		`awf apply ${target} <issue> --input <file|->`,
		"--input",
		2,
	);
}

function validateReconcile(args: Array<string>): Envelope | undefined {
	const usage = "awf reconcile <id> [--apply]";
	if (args[1] === undefined || args[1] === "" || args[1].startsWith("-")) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	const allowed = new Set(["reconcile", args[1], "--apply"]);
	if (
		args.length > maxReconcileArgumentCount ||
		args.some((arg) => !allowed.has(arg))
	) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	return undefined;
}

function invalidReadyArguments(): Envelope {
	return failure("INVALID_ARGUMENTS", "Invalid arguments for ready.", {
		usage: "awf ready [--filter <name=value>] [--limit <n>]",
	});
}

function validateTerminalArguments(
	args: Array<string>,
	command: string,
): Envelope | undefined {
	const minimumTerminalArgumentCount = 4;
	const terminalArgumentCountWithInput = 6;
	const usage = `awf ${command} <id> --run <run> --input <file|->`;
	if (args[1] === undefined || args[1] === "" || args[1].startsWith("-")) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	const run = readOption(args, "--run");
	const input = readOption(args, "--input");
	const allowed = new Set([command, args[1], "--run", run, "--input", input]);
	if (
		run === undefined ||
		run === "" ||
		(input !== undefined && input === "") ||
		(input === undefined && args.length !== minimumTerminalArgumentCount) ||
		(input !== undefined && args.length !== terminalArgumentCountWithInput) ||
		args.some((arg) => !allowed.has(arg))
	) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	return undefined;
}

type ReadyOptions = {
	filters: Array<{ name: string; value: string }>;
	limit?: number;
	error?: true;
};

function parseReadyOptions(args: Array<string>): ReadyOptions {
	const options: ReadyOptions = { filters: [] };
	for (let index = 1; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (value === undefined || value === "") {
			return { filters: [], error: true };
		}
		if (option === "--filter") {
			const parsed = parseNamedFilter(value);
			if (parsed === undefined) {
				return { filters: [], error: true };
			}
			options.filters.push(parsed);
		} else if (option === "--limit" && options.limit === undefined) {
			options.limit = Number(value);
		} else {
			return { filters: [], error: true };
		}
	}
	return options;
}

function parseNamedFilter(
	value: string,
): { name: string; value: string } | undefined {
	const separator = value.indexOf("=");
	if (separator <= 0 || separator === value.length - 1) {
		return undefined;
	}
	return {
		name: value.slice(0, separator),
		value: value.slice(separator + 1),
	};
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

async function createGenericWorkflowIssueCommand(
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	command: ManifestCommand,
): Promise<Envelope> {
	if (inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf create ${command.cli?.target ?? command.target.kind} --input <file|->`,
		});
	}
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === command.target.kind,
	);
	if (kind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest command kind is unknown.",
			{
				command: command.id,
				kind: command.target.kind,
			},
		);
	}
	const raw = await readInput(inputPath, stdin);
	const parsed = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsed.ok) {
		return parsed;
	}
	const inputValidation = validateWorkflowCommandInput(command, parsed.data);
	if (inputValidation !== undefined) {
		return inputValidation;
	}
	try {
		const { issue, log } = await tracker.createWorkflowIssue({
			title: genericIssueTitle(parsed.data, command.cli?.target ?? kind.id),
			body: genericIssueBody(parsed.data, raw),
			workflow: { kind: kind.id, ...initialWorkflowTarget(kind.initial) },
			initialLog: {
				type: `${command.id}_created`,
				payload: { input: parsed.data },
			},
		});
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		const data = { issue, log };
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		return lifecycleError("new", error);
	}
}

async function applyGenericWorkflowCommand(
	issueId: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	stdin: string | undefined,
	command: ManifestCommand,
): Promise<Envelope> {
	if (issueId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf apply ${command.cli?.target ?? command.target.action} <issue> --input <file|->`,
		});
	}
	const raw = await readInput(inputPath, stdin);
	const parsed = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsed.ok) {
		return parsed;
	}
	const inputValidation = validateWorkflowCommandInput(command, parsed.data);
	if (inputValidation !== undefined) {
		return inputValidation;
	}
	try {
		const issue = await tracker.getIssue(issueId);
		if (
			issue.workflow.kind !== command.target.kind ||
			issue.workflow.action !== command.target.action
		) {
			return invalidTransition(issueId, command.id);
		}
		const log = await tracker.appendLog(issueId, {
			type: `${command.id}_applied`,
			payload: { input: parsed.data },
		});
		const data = { issue, log, outcome: "APPLIED" };
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		return lifecycleError(issueId, error);
	}
}

async function createSpecCommand(
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	commandOverride?: ManifestCommand,
): Promise<Envelope> {
	if (inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf create spec --input <file|->",
		});
	}
	const kind = manifest.kinds.find((candidate) => candidate.id === "spec");
	if (kind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define spec kind.",
		);
	}
	const raw = await readInput(inputPath, stdin);
	const command = commandOverride ?? workflowCommand(manifest, "spec-create");
	const inputValidation = validateWorkflowCommandInput(command, { spec: raw });
	if (inputValidation !== undefined) {
		return inputValidation;
	}
	const spec = parseSpecInput(raw);
	if (spec.content.trim() === "") {
		return failure("INVALID_SPEC", "Spec content must be non-empty.");
	}
	try {
		const { issue, log } = await tracker.createWorkflowIssue({
			title: spec.title,
			body: spec.content,
			workflow: { kind: "spec", ...initialWorkflowTarget(kind.initial) },
			initialLog: {
				type: "spec_created",
				payload: { input: inputPath },
			},
		});
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		const data = { issue, log };
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		return lifecycleError("new", error);
	}
}

async function createHandoffCommand(
	sourceId: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	commandOverride?: ManifestCommand,
): Promise<Envelope> {
	if (sourceId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf create handoff --source <issue> --input <handoff.json>",
		});
	}
	const raw = await readInput(inputPath, stdin);
	const parsed = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsed.ok) {
		return parsed;
	}
	const command =
		commandOverride ?? workflowCommand(manifest, "handoff-create");
	const payload = parsePayloadValue(parsed.data, command?.input, "$input");
	if (payload.issues.length > 0) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
			{
				...(command === undefined ? {} : { command: command.id }),
				issues: payload.issues,
			},
		);
	}
	if (!isRecord(payload.value) || typeof payload.value.handoff !== "string") {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
			{ issues: [{ path: "$.handoff", message: "Value is required." }] },
		);
	}

	try {
		await tracker.getIssue(sourceId);
		const artifactInput = {
			kind: "handoff" as const,
			uri: payload.value.handoff,
			name: "Handoff",
		};
		const { artifacts, log } = await tracker.recordArtifacts(sourceId, {
			artifacts: [artifactInput],
			log: {
				type: "handoff_created",
				payload: {
					input: payload.value as JsonValue,
					artifact: artifactInput,
				},
			},
		});
		const artifact = artifacts[0];
		if (artifact === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: handoff artifact was not recorded.",
			);
		}
		const data = { source: sourceId, artifact, log };
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		return lifecycleError(sourceId, error);
	}
}

async function applyPlanCommand(
	specId: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	commandOverride?: ManifestCommand,
): Promise<Envelope> {
	if (specId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf apply plan <spec> --input <file|->",
		});
	}
	const raw = await readInput(inputPath, stdin);
	const parsedInput = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsedInput.ok) {
		return parsedInput;
	}
	const command = commandOverride ?? workflowCommand(manifest, "plan-apply");
	const inputValidation = validateWorkflowCommandInput(
		command,
		parsedInput.data,
	);
	if (inputValidation !== undefined) {
		return inputValidation;
	}

	let spec: Awaited<ReturnType<Tracker["getIssue"]>>;
	try {
		spec = await tracker.getIssue(specId);
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id: specId });
		}
		throw error;
	}
	if (spec.workflow.kind !== "spec" || spec.workflow.action !== "plan") {
		return invalidTransition(specId, "apply-plan");
	}
	const plan = parsePlanInput(raw);
	const validationIssues = validatePlan(plan);
	if (validationIssues.length > 0) {
		return failure("INVALID_PLAN", "Plan bundle is invalid.", {
			issues: validationIssues as JsonValue,
		});
	}

	const created: Array<{ key: string; id: string }> = [];
	const children: Array<string> = [];
	const dependencies: Array<{ issueId: string; blockedById: string }> = [];
	try {
		const ticketKind = manifest.kinds.find((kind) => kind.id === "ticket");
		if (ticketKind === undefined) {
			throw new Error("Manifest does not define ticket kind.");
		}
		for (const ticket of plan.tickets) {
			const issue = await tracker.createIssue({
				title: ticket.title,
				body: ticket.content,
				workflow: {
					kind: "ticket",
					...initialWorkflowTarget(ticketKind.initial),
				},
			});
			created.push({ key: ticket.key, id: issue.id });
			await tracker.addChild(specId, issue.id);
			children.push(issue.id);
		}
		const idsByKey = new Map(created.map((ticket) => [ticket.key, ticket.id]));
		for (const ticket of plan.tickets) {
			for (const dependencyKey of ticket.dependsOn ?? []) {
				const issueId = idsByKey.get(ticket.key);
				const blockedById = idsByKey.get(dependencyKey as string);
				if (issueId === undefined || blockedById === undefined) {
					throw new Error(
						"Plan dependency resolution failed after validation.",
					);
				}
				await tracker.addDependency(issueId, blockedById);
				dependencies.push({ issueId, blockedById });
			}
		}
		const target = planApplicationTarget(manifest, spec.workflow);
		if (target === undefined) {
			throw new Error("Spec has no success transition for plan application.");
		}
		const updated = await tracker.updateIssue(specId, {
			expect: { version: spec.workflow.version, hash: spec.workflow.hash },
			workflow: { ...workflowTarget(target), activeRunId: undefined },
		});
		const log = await tracker.appendLog(specId, {
			type: "plan_applied",
			payload: { input: inputPath, tickets: created },
		});
		const data = {
			outcome: "SUCCESS",
			spec: updated,
			tickets: created,
			log,
		};
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		const rollbackErrors = await rollbackPlanApplication(
			tracker,
			specId,
			spec.workflow,
			dependencies,
			children,
			created.map((ticket) => ticket.id),
		);
		if (rollbackErrors.length === 0) {
			return failure(
				"PLAN_APPLY_FAILED",
				"Plan application failed and was rolled back.",
				{
					outcome: "ROLLED_BACK",
					message: error instanceof Error ? error.message : String(error),
				},
			);
		}
		await escalatePartialRollback(tracker, specId);
		return failure(
			"PLAN_APPLY_FAILED",
			"Plan application failed and rollback was partial.",
			{
				outcome: "PARTIAL_ROLLBACK",
				message: error instanceof Error ? error.message : String(error),
				rollbackErrors,
			},
		);
	}
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

async function readyCommand(
	options: ReadyOptions,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	const namedFilterDeclarationValidation =
		validateNamedReadinessFilterDeclarations(options.filters, manifest);
	if (namedFilterDeclarationValidation !== undefined) {
		return namedFilterDeclarationValidation;
	}
	const issues = await tracker.listIssues();
	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	const activeIssues = issues.filter(
		(issue) => issue.workflow.activeRunId !== undefined,
	);
	const filters = readinessFilters(manifest);
	const namedFilterValidation = validateNamedReadinessFilterValues(
		options.filters,
		manifest,
		byId,
	);
	if (namedFilterValidation !== undefined) {
		return namedFilterValidation;
	}
	const readyLike = issues
		.filter((issue) => matchesReadinessFilters(issue.workflow, filters))
		.filter((issue) => issue.workflow.activeRunId === undefined)
		.filter((issue) => specPostTicketGateIsOpen(issue, byId))
		.filter((issue) =>
			matchesNamedReadinessFilters(issue, options.filters, manifest),
		);
	const readiness = readyLike.map((issue) => ({
		issue,
		blocking: readinessBlocking(issue, byId, manifest, activeIssues),
	}));
	const candidates = readiness
		.filter((item) => item.blocking.length === 0)
		.map((item) => item.issue)
		.sort(compareReadyIssues)
		.slice(0, options.limit);
	const blocked = readiness
		.filter((item) => item.blocking.length > 0)
		.sort((left, right) => compareReadyIssues(left.issue, right.issue));

	return success({
		items: candidates.map(readyItem),
		...(blocked.length === 0
			? {}
			: {
					blocked: blocked.map(({ issue, blocking }) => ({
						id: issue.id,
						title: issue.title,
						workflow: cleanWorkflowFields(issue.workflow),
						blocking,
					})),
				}),
	});
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

type ReconciliationDiagnostic = {
	code: string;
	severity: "drift" | "corruption";
	message: string;
	repair: "safe" | "need-human" | "none";
	runId?: string;
	applied?: boolean;
};

async function reconcileCommand(
	id: string | undefined,
	apply: boolean,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf reconcile <id> [--apply]",
		});
	}

	try {
		const inspection = await inspectWorkflowIssue(tracker, id);
		const diagnostics = diagnoseReconciliation(inspection);
		const hasCorruption = diagnostics.some(
			(diagnostic) => diagnostic.severity === "corruption",
		);
		const safeRepair = hasCorruption
			? undefined
			: diagnostics.find((diagnostic) => diagnostic.repair === "safe");
		let repairedIssue = inspection.issue;
		if (apply && safeRepair !== undefined && inspection.issue !== undefined) {
			const workflow = safeRepairWorkflow(safeRepair);
			if (workflow !== undefined) {
				repairedIssue = await tracker.updateIssue(id, {
					expect: {
						version: inspection.issue.workflow.version,
						hash: inspection.issue.workflow.hash,
					},
					workflow,
				});
				safeRepair.applied = true;
			}
		}
		return success({
			id,
			mode: apply ? "apply" : "check",
			status: diagnostics.length === 0 ? "clean" : "diagnosed",
			diagnostics,
			...(repairedIssue === undefined ? {} : { issue: repairedIssue }),
		});
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		throw error;
	}
}

async function inspectWorkflowIssue(
	tracker: Tracker,
	id: string,
): Promise<{
	issue?: Awaited<ReturnType<Tracker["getIssue"]>>;
	logs: Array<unknown>;
	labels?: Array<string>;
	projectionError?: string;
}> {
	if (tracker.inspectIssue !== undefined) {
		return tracker.inspectIssue(id);
	}
	return {
		issue: await tracker.getIssue(id),
		logs: await tracker.readLogs(id),
	};
}

function diagnoseReconciliation(inspection: {
	issue?: Awaited<ReturnType<Tracker["getIssue"]>>;
	logs: Array<unknown>;
	labels?: Array<string>;
	projectionError?: string;
}): Array<ReconciliationDiagnostic> {
	const diagnostics: Array<ReconciliationDiagnostic> = [];
	if (inspection.projectionError !== undefined) {
		diagnostics.push({
			code: projectionErrorCode(inspection.projectionError, inspection.labels),
			severity: "corruption",
			message: inspection.projectionError,
			repair: "none",
		});
	}
	for (const [index, log] of inspection.logs.entries()) {
		if (!isWorkflowLogShape(log, index + 1)) {
			diagnostics.push({
				code: "MALFORMED_WORKFLOW_LOG",
				severity: "corruption",
				message: `Workflow log at sequence ${index + 1} is malformed.`,
				repair: "none",
			});
		}
	}
	if (inspection.issue === undefined) {
		return diagnostics;
	}
	const validLogs = inspection.logs.filter(
		(
			log,
		): log is {
			sequence: number;
			issueId: string;
			type: string;
			runId?: string;
		} => isWorkflowLogShape(log),
	);
	const runStates = deriveRuns(
		inspection.issue.workflow.activeRunId,
		validLogs,
	);
	const openRuns = runStates.attempts.filter(
		(attempt) => attempt.status === "running",
	);
	if (
		inspection.issue.workflow.activeRunId === undefined &&
		openRuns.length === 1
	) {
		diagnostics.push({
			code: "MISSING_ACTIVE_RUN",
			severity: "drift",
			message: `Current fields are missing active run '${openRuns[0]?.runId}'.`,
			repair: "safe",
			runId: openRuns[0]?.runId,
		});
	}
	if (
		inspection.issue.workflow.activeRunId === undefined &&
		openRuns.length > 1
	) {
		diagnostics.push({
			code: "AMBIGUOUS_ACTIVE_RUN",
			severity: "drift",
			message: "Multiple log-derived runs could be active.",
			repair: "need-human",
		});
	}
	const active = inspection.issue.workflow.activeRunId;
	if (active !== undefined) {
		const terminal = validLogs.find(
			(log) => log.runId === active && isTerminalLog(log.type),
		);
		if (terminal !== undefined) {
			diagnostics.push({
				code: "TERMINAL_RUN_STILL_ACTIVE",
				severity: "drift",
				message: `Active run '${active}' already has a terminal log.`,
				repair:
					inspection.issue.workflow.state === "running" ? "need-human" : "safe",
			});
		}
	}
	return diagnostics;
}

function projectionErrorCode(
	_message: string,
	labels: Array<string> | undefined,
): string {
	if (labels !== undefined) {
		for (const prefix of ["type", "state", "action", "reason"]) {
			const count = labels.filter((label) =>
				label.startsWith(`${prefix}:`),
			).length;
			if (count > 1) {
				return "DUPLICATE_CURRENT_FIELDS";
			}
		}
	}
	return "MISSING_CURRENT_METADATA";
}

function isWorkflowLogShape(
	log: unknown,
	expectedSequence?: number,
): log is { sequence: number; issueId: string; type: string; runId?: string } {
	return (
		isRecord(log) &&
		typeof log.sequence === "number" &&
		Number.isInteger(log.sequence) &&
		(expectedSequence === undefined || log.sequence === expectedSequence) &&
		typeof log.issueId === "string" &&
		log.issueId !== "" &&
		typeof log.type === "string" &&
		log.type !== "" &&
		(log.runId === undefined ||
			(typeof log.runId === "string" && log.runId !== ""))
	);
}

function safeRepairWorkflow(
	diagnostic: ReconciliationDiagnostic,
): { activeRunId?: string } | undefined {
	if (diagnostic.code === "TERMINAL_RUN_STILL_ACTIVE") {
		return { activeRunId: undefined };
	}
	if (
		diagnostic.code === "MISSING_ACTIVE_RUN" &&
		diagnostic.runId !== undefined
	) {
		return { activeRunId: diagnostic.runId };
	}
	return undefined;
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
		const { issue: updated, log } = await tracker.startRun(id, {
			expect: {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			},
			runId,
			workflow: workflowTarget(transition.to),
			log: {
				type: "action_started",
				runId,
				payload: { event: "start", to: cleanTransitionTarget(transition.to) },
			},
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
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
): Promise<Envelope> {
	if (id === undefined || runId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf ${event} <id> --run <run> --input <file|->`,
		});
	}

	try {
		const parsedInput =
			inputPath === undefined
				? undefined
				: parseJsonInput(
						await readInput(inputPath, stdin),
						"INVALID_ACTION_INPUT",
					);
		if (parsedInput?.ok === false) {
			return parsedInput;
		}
		const logs = await tracker.readLogs(id);
		const existing = logs.find(
			(log) => log.runId === runId && isTerminalLog(log.type),
		);
		const logType = terminalLogType(event);
		if (existing !== undefined) {
			if (
				existing.type === logType &&
				(parsedInput === undefined ||
					terminalLogInputMatches(existing.payload, parsedInput.data))
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
		const retryTarget =
			event === "fail" && transition === undefined
				? defaultRetryTarget(issue.workflow)
				: undefined;
		if (transition === undefined && retryTarget === undefined) {
			return invalidTransition(id, event);
		}
		if (
			retryTarget !== undefined &&
			!retryPolicyAllows(manifest, issue.workflow)
		) {
			return policyViolation(id, "retry", issue.workflow.action);
		}
		if (transition?.input !== undefined && parsedInput === undefined) {
			return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage: `awf ${event} <id> --run <run> --input <file|->`,
			});
		}
		const payload = parsePayloadValue(
			parsedInput?.data ?? {},
			transition?.input,
			"$",
		);
		const validationIssues = [...payload.issues];
		const terminalInput = payload.value as JsonValue;
		const semanticIssue = validateBundledTerminalInput(
			issue,
			event,
			terminalInput,
		);
		if (semanticIssue !== undefined) {
			validationIssues.push(semanticIssue);
		}
		if (validationIssues.length > 0) {
			return failure(
				"INVALID_ACTION_INPUT",
				"Action completion input is invalid.",
				{ issues: validationIssues },
			);
		}
		const target =
			retryTarget ??
			(transition === undefined ? undefined : workflowTarget(transition.to));
		if (target === undefined) {
			return invalidTransition(id, event);
		}
		const result = await tracker.completeRun(id, {
			expect: {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			},
			runId,
			workflow: target,
			artifacts: bundledArtifactInputs(issue.workflow, terminalInput),
			log: {
				type: logType,
				runId,
				payload: {
					event,
					...(parsedInput === undefined ? {} : { input: terminalInput }),
					to: target,
				},
			},
		});
		await progressParentSpecAfterTicketDone(tracker, issue, result.issue);
		return success({
			issue: result.issue,
			run: { id: runId, status: event },
			log: result.log,
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function escalateCommand(
	id: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
): Promise<Envelope> {
	if (id === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf escalate <id> --input <file|->",
		});
	}
	try {
		const parsedInput = parseJsonInput(
			await readInput(inputPath, stdin),
			"INVALID_ACTION_INPUT",
		);
		if (parsedInput.ok === false) {
			return parsedInput;
		}
		if (
			!isRecord(parsedInput.data) ||
			typeof parsedInput.data.reason !== "string" ||
			parsedInput.data.reason.trim() === ""
		) {
			return failure("INVALID_ACTION_INPUT", "Escalation input is invalid.", {
				issues: [
					{
						path: "$.reason",
						message: "Escalation reason must be a non-empty string.",
					},
				],
			});
		}
		const issue = await tracker.getIssue(id);
		if (!escalationPolicyAllows(manifest, issue.workflow)) {
			return policyViolation(id, "escalation", issue.workflow.action);
		}
		const from = cleanCurrentTarget(issue.workflow);
		const to = { state: "need-human", action: "none" };
		const { issue: updated, log } = await tracker.escalateWorkflow(id, {
			expect: { version: issue.workflow.version, hash: issue.workflow.hash },
			workflow: {
				state: "need-human",
				action: "none",
				reason: undefined,
				activeRunId: undefined,
			},
			log: {
				type: "human_intervention_needed",
				payload: {
					event: "escalate",
					input: parsedInput.data as JsonValue,
					from,
					to,
				},
			},
		});
		return success({ issue: updated, log });
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function resumeCommand(
	id: string | undefined,
	action: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	if (id === undefined || action === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf resume <id> --action <action>",
		});
	}
	try {
		const issue = await tracker.getIssue(id);
		if (
			issue.workflow.state !== "need-human" ||
			issue.workflow.action !== "none"
		) {
			return invalidTransition(id, "resume");
		}
		if (
			!isReadyAction(manifest, issue.workflow.kind, action) ||
			!resumePolicyAllows(manifest, issue.workflow.kind, action)
		) {
			return policyViolation(id, "resume", action);
		}
		const { issue: updated, log } = await tracker.resumeWorkflow(id, {
			expect: { version: issue.workflow.version, hash: issue.workflow.hash },
			workflow: {
				state: "ready",
				action,
				reason: undefined,
				activeRunId: undefined,
			},
			log: {
				type: "action_resumed",
				payload: { event: "resume", to: { state: "ready", action } },
			},
		});
		return success({ issue: updated, log });
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

function workflowCommand(
	manifest: WorkflowManifest,
	id: string,
): ManifestCommand | undefined {
	return manifest.commands.find((command) => command.id === id);
}

function workflowCommandByCli(
	manifest: WorkflowManifest,
	verb: "create" | "apply",
	target: string | undefined,
): ManifestCommand | undefined {
	return manifest.commands.find(
		(command) => command.cli?.verb === verb && command.cli.target === target,
	);
}

function validateWorkflowCommandInput(
	command: ManifestCommand | undefined,
	value: JsonValue,
): Envelope | undefined {
	const result = parsePayloadValue(value, command?.input, "$input");
	if (result.issues.length === 0) {
		return undefined;
	}
	return failure(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
		"Workflow command input is invalid.",
		{
			...(command === undefined ? {} : { command: command.id }),
			issues: result.issues,
		},
	);
}

function validateWorkflowCommandOutput(
	command: ManifestCommand | undefined,
	value: JsonValue,
): Envelope | undefined {
	const result = parsePayloadValue(value, command?.output, "$output");
	if (result.issues.length === 0) {
		return undefined;
	}
	return failure(
		"WORKFLOW_COMMAND_OUTPUT_VALIDATION_FAILED",
		"Workflow command output is invalid.",
		{
			...(command === undefined ? {} : { command: command.id }),
			issues: result.issues,
		},
	);
}

async function readInput(
	path: string,
	stdin: string | undefined,
): Promise<string> {
	if (path === "-") {
		return stdin ?? "";
	}
	return readFile(path, "utf8");
}

type SpecInput = { title: string; content: string };
type PlanBundle = { tickets: Array<PlanTicket> };
type PlanTicket = {
	key: string;
	title: string;
	content: string;
	dependsOn?: Array<unknown>;
};

function parseSpecInput(raw: string): SpecInput {
	const parsed = parseJsonObject(raw);
	if (parsed !== undefined) {
		const contentValue = parsed.content ?? parsed.body ?? parsed.markdown;
		const content = typeof contentValue === "string" ? contentValue : raw;
		return {
			title:
				typeof parsed.title === "string" && parsed.title.trim() !== ""
					? parsed.title
					: titleFromMarkdown(content),
			content,
		};
	}
	return { title: titleFromMarkdown(raw), content: raw };
}

function parsePlanInput(raw: string): PlanBundle {
	const parsed = parseJsonObject(raw);
	const tickets = Array.isArray(parsed?.tickets) ? parsed.tickets : [];
	return {
		tickets: tickets.map((ticket): PlanTicket => {
			const record = isRecord(ticket) ? ticket : {};
			return {
				key: typeof record.key === "string" ? record.key : "",
				title: typeof record.title === "string" ? record.title : "",
				content: readTicketContent(record),
				...(Array.isArray(record.dependsOn)
					? { dependsOn: record.dependsOn }
					: {}),
			};
		}),
	};
}

function readTicketContent(record: Record<string, unknown>): string {
	if (typeof record.content === "string") {
		return record.content;
	}
	if (typeof record.body === "string") {
		return record.body;
	}
	return "";
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function genericIssueTitle(input: JsonValue, fallback: string): string {
	if (
		isRecord(input) &&
		typeof input.title === "string" &&
		input.title.trim() !== ""
	) {
		return input.title;
	}
	return fallback;
}

function genericIssueBody(input: JsonValue, raw: string): string {
	if (isRecord(input)) {
		if (typeof input.body === "string") {
			return input.body;
		}
		if (typeof input.content === "string") {
			return input.content;
		}
	}
	return raw;
}

function parseJsonInput(
	raw: string,
	code: string,
): Envelope & ({ ok: true; data: JsonValue } | { ok: false }) {
	try {
		return success(JSON.parse(raw) as JsonValue) as Envelope & {
			ok: true;
			data: JsonValue;
		};
	} catch (error) {
		return failure(code, "Input must be valid JSON.", {
			message: error instanceof Error ? error.message : String(error),
		}) as Envelope & { ok: false };
	}
}

type RuntimeValidationIssue = { path: string; message: string };

type ParsedPayload = {
	value: unknown;
	issues: Array<RuntimeValidationIssue>;
};

function parsePayloadValue(
	value: unknown,
	schema: PayloadZodSchema | undefined,
	path: string,
): ParsedPayload {
	if (schema === undefined) {
		return { value, issues: [] };
	}
	const result = schema.safeParse(value);
	if (result.success) {
		return { value: result.data, issues: [] };
	}
	return {
		value,
		issues: result.error.issues.map((issue) => ({
			path: formatPayloadPath(path, issue.path),
			message: issue.message,
		})),
	};
}

function formatPayloadPath(
	root: string,
	path: ReadonlyArray<PropertyKey>,
): string {
	let formatted = root;
	for (const part of path) {
		formatted =
			typeof part === "number"
				? `${formatted}[${part}]`
				: `${formatted}.${String(part)}`;
	}
	return formatted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function titleFromMarkdown(markdown: string): string {
	const heading = markdown
		.split(/\r?\n/u)
		.map((line) => line.match(/^#\s+(.+)$/u)?.[1]?.trim())
		.find((title) => title !== undefined && title !== "");
	return heading ?? "Spec";
}

function validateBundledTerminalInput(
	issue: Awaited<ReturnType<Tracker["getIssue"]>>,
	event: "succeed" | "fail",
	input: JsonValue,
): RuntimeValidationIssue | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	if (
		issue.workflow.kind === "ticket" &&
		issue.workflow.action === "implement" &&
		event === "succeed" &&
		issue.artifacts.some((artifact) => artifact.kind === "pull-request")
	) {
		return {
			path: "$.implementationPr",
			message: "Ticket already has an implementation pull request artifact.",
		};
	}
	if (
		issue.workflow.kind === "ticket" &&
		issue.workflow.action === "review" &&
		input.verdict !== (event === "succeed" ? "approved" : "changes-requested")
	) {
		return {
			path: "$.verdict",
			message: "Review verdict does not match the terminal event.",
		};
	}
	if (
		issue.workflow.kind === "spec" &&
		issue.workflow.action === "integration-test" &&
		input.verdict !== (event === "succeed" ? "passed" : "changes-needed")
	) {
		return {
			path: "$.verdict",
			message: "Integration verdict does not match the terminal event.",
		};
	}
	return undefined;
}

function bundledArtifactInputs(
	workflow: WorkflowFields,
	input: JsonValue,
): Array<{ kind: "pull-request"; uri: string; name: string }> {
	if (!isRecord(input)) {
		return [];
	}
	const artifacts: Array<{ kind: "pull-request"; uri: string; name: string }> =
		[];
	if (
		workflow.kind === "ticket" &&
		workflow.action === "implement" &&
		typeof input.implementationPr === "string"
	) {
		artifacts.push({
			kind: "pull-request",
			uri: input.implementationPr,
			name: "Implementation PR",
		});
	}
	if (
		workflow.kind === "spec" &&
		workflow.action === "integration-test" &&
		typeof input.specPr === "string"
	) {
		artifacts.push({
			kind: "pull-request",
			uri: input.specPr,
			name: "Spec PR",
		});
	}
	return artifacts;
}

function validatePlan(
	plan: PlanBundle,
): Array<{ path: string; message: string }> {
	const issues: Array<{ path: string; message: string }> = [];
	if (plan.tickets.length === 0) {
		issues.push({
			path: "$.tickets",
			message: "Plan must include at least one ticket.",
		});
	}
	const keys = new Set<string>();
	for (const [index, ticket] of plan.tickets.entries()) {
		const path = `$.tickets[${index}]`;
		if (ticket.key.trim() === "") {
			issues.push({
				path: `${path}.key`,
				message: "Ticket key must be non-empty.",
			});
		} else if (keys.has(ticket.key)) {
			issues.push({
				path: `${path}.key`,
				message: "Ticket key must be unique.",
			});
		} else {
			keys.add(ticket.key);
		}
		if (ticket.title.trim() === "") {
			issues.push({
				path: `${path}.title`,
				message: "Ticket title must be non-empty.",
			});
		}
		if (ticket.content.trim() === "") {
			issues.push({
				path: `${path}.content`,
				message: "Ticket content must be non-empty.",
			});
		}
	}
	for (const [index, ticket] of plan.tickets.entries()) {
		for (const dependency of ticket.dependsOn ?? []) {
			if (typeof dependency !== "string" || dependency.trim() === "") {
				issues.push({
					path: `$.tickets[${index}].dependsOn`,
					message: "Dependency references must be non-empty strings.",
				});
			} else if (!keys.has(dependency)) {
				issues.push({
					path: `$.tickets[${index}].dependsOn`,
					message: `Unknown dependency '${dependency}'.`,
				});
			}
		}
	}
	const cycle = findDependencyCycle(plan);
	if (cycle !== undefined) {
		issues.push({
			path: "$.tickets",
			message: `Dependency graph must be acyclic (${cycle.join(" -> ")}).`,
		});
	}
	return issues;
}

function findDependencyCycle(plan: PlanBundle): Array<string> | undefined {
	const byKey = new Map(plan.tickets.map((ticket) => [ticket.key, ticket]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: Array<string> = [];
	function visit(key: string): Array<string> | undefined {
		if (visiting.has(key)) {
			return [...stack.slice(stack.indexOf(key)), key];
		}
		if (visited.has(key)) {
			return undefined;
		}
		visiting.add(key);
		stack.push(key);
		for (const dependency of byKey.get(key)?.dependsOn ?? []) {
			if (typeof dependency !== "string" || !byKey.has(dependency)) {
				continue;
			}
			const cycle = visit(dependency);
			if (cycle !== undefined) {
				return cycle;
			}
		}
		stack.pop();
		visiting.delete(key);
		visited.add(key);
		return undefined;
	}
	for (const key of byKey.keys()) {
		const cycle = visit(key);
		if (cycle !== undefined) {
			return cycle;
		}
	}
	return undefined;
}

async function rollbackPlanApplication(
	tracker: Tracker,
	specId: string,
	specWorkflow: WorkflowFields,
	dependencies: Array<{ issueId: string; blockedById: string }>,
	children: Array<string>,
	createdIssueIds: Array<string>,
): Promise<Array<string>> {
	const errors: Array<string> = [];
	for (const dependency of [...dependencies].reverse()) {
		try {
			await tracker.removeDependency(
				dependency.issueId,
				dependency.blockedById,
			);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const childId of [...children].reverse()) {
		try {
			await tracker.removeChild(specId, childId);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const issueId of [...createdIssueIds].reverse()) {
		try {
			await tracker.deleteIssue(issueId);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		await tracker.updateIssue(specId, {
			workflow: {
				state: specWorkflow.state,
				action: specWorkflow.action,
				reason: specWorkflow.reason,
				activeRunId: specWorkflow.activeRunId,
			},
		});
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}

async function escalatePartialRollback(
	tracker: Tracker,
	specId: string,
): Promise<void> {
	try {
		await tracker.updateIssue(specId, {
			workflow: { state: "need-human", action: "none", activeRunId: undefined },
		});
	} catch {
		// Best-effort escalation: the original partial rollback error remains the outcome.
	}
}

async function progressParentSpecAfterTicketDone(
	tracker: Tracker,
	previous: Awaited<ReturnType<Tracker["getIssue"]>>,
	updated: Awaited<ReturnType<Tracker["getIssue"]>>,
): Promise<void> {
	const parentId = previous.relationships.parent;
	if (
		previous.workflow.kind !== "ticket" ||
		updated.workflow.state !== "done" ||
		updated.workflow.action !== "none" ||
		parentId === undefined
	) {
		return;
	}
	const parent = await tracker.getIssue(parentId);
	if (
		parent.workflow.kind !== "spec" ||
		parent.workflow.state !== "ready" ||
		parent.workflow.action !== "none" ||
		parent.relationships.children.length === 0
	) {
		return;
	}
	const children = await Promise.all(
		parent.relationships.children.map((childId) => tracker.getIssue(childId)),
	);
	if (!children.every((child) => isDone(child))) {
		return;
	}
	await tracker.updateIssue(parentId, {
		expect: { version: parent.workflow.version, hash: parent.workflow.hash },
		workflow: { state: "ready", action: "integration-test" },
	});
}

function readinessFilters(
	manifest: WorkflowManifest,
): Array<{ kind?: string; state?: string; action?: string; reason?: string }> {
	if (manifest.readiness !== undefined) {
		return manifest.readiness.filters;
	}
	return manifest.kinds.flatMap((kind) =>
		kind.transitions
			.filter((transition) => transition.event === "start")
			.map((transition) => ({
				kind: kind.id,
				state: transition.from.state,
				action: transition.from.action,
				...(transition.from.reason === undefined ||
				transition.from.reason === null
					? {}
					: { reason: transition.from.reason }),
			})),
	);
}

function matchesReadinessFilters(
	workflow: WorkflowFields,
	filters: Array<{
		kind?: string;
		state?: string;
		action?: string;
		reason?: string;
	}>,
): boolean {
	return filters.some(
		(filter) =>
			fieldMatches(filter.kind, workflow.kind) &&
			fieldMatches(filter.state, workflow.state) &&
			fieldMatches(filter.action, workflow.action) &&
			fieldMatches(filter.reason, workflow.reason),
	);
}

function fieldMatches(
	expected: string | undefined,
	actual: string | undefined,
): boolean {
	return expected === undefined || expected === actual;
}

function validateNamedReadinessFilterDeclarations(
	filters: Array<{ name: string; value: string }>,
	manifest: WorkflowManifest,
): Envelope | undefined {
	for (const filter of filters) {
		if (namedReadinessFilter(manifest, filter.name) === undefined) {
			return failure(
				"INVALID_READY_FILTER",
				"Readiness filter is not declared by the manifest.",
				{
					filter: filter.name,
				},
			);
		}
	}
	return undefined;
}

function validateNamedReadinessFilterValues(
	filters: Array<{ name: string; value: string }>,
	manifest: WorkflowManifest,
	byId: Map<string, { workflow: WorkflowFields }>,
): Envelope | undefined {
	for (const filter of filters) {
		const declaration = namedReadinessFilter(manifest, filter.name);
		if (declaration === undefined) {
			continue;
		}
		const issue = byId.get(filter.value);
		if (issue === undefined) {
			return failure(
				"INVALID_READY_FILTER",
				"Readiness filter value does not resolve to a workflow issue.",
				{
					filter: filter.name,
					value: filter.value,
				},
			);
		}
		if (issue.workflow.kind !== declaration.kind) {
			return failure(
				"INVALID_READY_FILTER",
				"Readiness filter value has the wrong workflow kind.",
				{
					filter: filter.name,
					value: filter.value,
					expectedKind: declaration.kind,
					actualKind: issue.workflow.kind,
				},
			);
		}
	}
	return undefined;
}

function matchesNamedReadinessFilters(
	issue: { relationships: { parent?: string } },
	filters: Array<{ name: string; value: string }>,
	manifest: WorkflowManifest,
): boolean {
	return filters.every((filter) => {
		const declaration = namedReadinessFilter(manifest, filter.name);
		return (
			declaration !== undefined &&
			declaration.relationship === "parent" &&
			issue.relationships.parent === filter.value
		);
	});
}

function namedReadinessFilter(
	manifest: WorkflowManifest,
	name: string,
): ManifestNamedReadinessFilter | undefined {
	return manifest.readiness?.namedFilters?.find(
		(filter) => filter.name === name,
	);
}

function readyItem(issue: {
	id: string;
	title: string;
	workflow: WorkflowFields;
}) {
	return {
		id: issue.id,
		title: issue.title,
		workflow: cleanWorkflowFields(issue.workflow),
		suggestedCommand: {
			argv: ["start", issue.id],
			display: `awf start ${issue.id}`,
		},
	};
}

function readinessBlocking(
	issue: {
		workflow: WorkflowFields;
		relationships: { dependencies: Array<string> };
	},
	byId: Map<string, { id: string; title: string; workflow: WorkflowFields }>,
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	return [
		...dependencyBlocking(issue, byId),
		...concurrencyBlocking(issue.workflow.kind, manifest, activeIssues),
	];
}

function dependencyBlocking(
	issue: { relationships: { dependencies: Array<string> } },
	byId: Map<string, { id: string; title: string; workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	const blockedBy: Array<Record<string, JsonValue>> = [];
	for (const id of issue.relationships.dependencies) {
		const dependency = byId.get(id);
		if (isDone(dependency)) {
			continue;
		}
		blockedBy.push(
			dependency === undefined
				? { id, missing: true }
				: {
						id: dependency.id,
						title: dependency.title,
						workflow: cleanWorkflowFields(dependency.workflow),
					},
		);
	}
	return blockedBy.length === 0 ? [] : [{ gate: "dependency", blockedBy }];
}

function concurrencyBlocking(
	kind: string,
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	const blocking: Array<Record<string, JsonValue>> = [];
	const workflowLimit = manifest.concurrency.perWorkflow;
	if (workflowLimit !== undefined && activeIssues.length >= workflowLimit) {
		blocking.push({
			gate: "concurrency",
			scope: "workflow",
			limit: workflowLimit,
			active: activeIssues.length,
		});
	}
	const kindLimit = manifest.concurrency.perKind?.[kind];
	const activeForKind = activeIssues.filter(
		(issue) => issue.workflow.kind === kind,
	).length;
	if (kindLimit !== undefined && activeForKind >= kindLimit) {
		blocking.push({
			gate: "concurrency",
			scope: "kind",
			kind,
			limit: kindLimit,
			active: activeForKind,
		});
	}
	return blocking;
}

function isDone(issue: { workflow: WorkflowFields } | undefined): boolean {
	return issue?.workflow.state === "done";
}

function specPostTicketGateIsOpen(
	issue: {
		workflow: WorkflowFields;
		relationships: { children: Array<string> };
	},
	byId: Map<string, { workflow: WorkflowFields }>,
): boolean {
	if (
		issue.workflow.kind !== "spec" ||
		issue.workflow.action !== "integration-test"
	) {
		return true;
	}
	return (
		issue.relationships.children.length > 0 &&
		issue.relationships.children.every((id) => isDone(byId.get(id)))
	);
}

function compareReadyIssues(
	left: { id: string; title: string },
	right: { id: string; title: string },
): number {
	return (
		left.id.localeCompare(right.id, undefined, { numeric: true }) ||
		left.title.localeCompare(right.title) ||
		left.id.localeCompare(right.id)
	);
}

function cleanWorkflowFields(workflow: WorkflowFields): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			kind: workflow.kind,
			state: workflow.state,
			action: workflow.action,
			reason: workflow.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
}

function planApplicationTarget(
	manifest: WorkflowManifest,
	workflow: WorkflowFields,
): ManifestTransition["to"] | undefined {
	const direct = findTransition(manifest, workflow, "succeed");
	if (direct !== undefined) {
		return direct.to;
	}
	const started = findTransition(manifest, workflow, "start");
	if (started === undefined) {
		return undefined;
	}
	return findTransition(
		manifest,
		{ ...workflow, ...workflowTarget(started.to) },
		"succeed",
	)?.to;
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
	if (
		error instanceof NeedReconciliationError ||
		error instanceof ProjectionConflictError ||
		(error instanceof CorruptWorkflowProjectionError &&
			error.message.includes("NEED_RECONCILIATION"))
	) {
		return failure("NEED_RECONCILIATION", error.message, { id });
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

function terminalLogInputMatches(
	payload: JsonValue | undefined,
	input: JsonValue,
): boolean {
	if (!isRecord(payload) || payload.input === undefined) {
		return true;
	}
	return stableStringify(payload.input) === stableStringify(input);
}

function initialWorkflowTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): { state: string; action: string; reason?: string } {
	return { ...workflowTarget(target), action: target.action ?? "none" };
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

function cleanCurrentTarget(target: {
	state: string;
	action: string;
	reason?: string;
}): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			state: target.state,
			action: target.action,
			reason: target.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
}

function defaultRetryTarget(workflow: {
	state: string;
	action: string;
}): { state: string; action: string } | undefined {
	if (workflow.state !== "running" || workflow.action === "none") {
		return undefined;
	}
	return { state: "ready", action: workflow.action };
}

function retryPolicyAllows(
	manifest: WorkflowManifest,
	workflow: { kind: string; action: string },
): boolean {
	return targetPolicyAllows(
		manifest.lifecycle?.retry?.allow,
		workflow.kind,
		workflow.action,
	);
}

function escalationPolicyAllows(
	manifest: WorkflowManifest,
	workflow: { kind: string; action: string },
): boolean {
	return targetPolicyAllows(
		manifest.lifecycle?.escalation?.allow,
		workflow.kind,
		workflow.action,
	);
}

function targetPolicyAllows(
	allow: Array<{ kind: string; action: string }> | undefined,
	kind: string,
	action: string,
): boolean {
	return (
		allow === undefined ||
		allow.some((target) => target.kind === kind && target.action === action)
	);
}

function resumePolicyAllows(
	manifest: WorkflowManifest,
	kind: string,
	action: string,
): boolean {
	const allow = manifest.lifecycle?.resume?.allow;
	return (
		allow === undefined ||
		allow.some(
			(target) => target.kind === kind && target.actions.includes(action),
		)
	);
}

function isReadyAction(
	manifest: WorkflowManifest,
	kind: string,
	action: string,
): boolean {
	return manifest.kinds.some(
		(manifestKind) =>
			manifestKind.id === kind &&
			manifestKind.transitions.some(
				(transition) =>
					transition.from.state === "ready" &&
					transition.from.action === action,
			),
	);
}

function policyViolation(id: string, policy: string, action: string): Envelope {
	return failure(
		"LIFECYCLE_POLICY_VIOLATION",
		"Lifecycle policy does not allow this transition.",
		{ id, policy, action },
	);
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
