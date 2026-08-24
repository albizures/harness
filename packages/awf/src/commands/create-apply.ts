import type { JsonValue } from "type-fest";
import type { CommandHandlers } from "../command-handlers.ts";
import { failure, success, type Envelope } from "../envelope.ts";
import type {
	ManifestCommand,
	WorkflowManifest,
} from "../manifest/manifest.ts";
import { NeedReconciliationError, type Tracker } from "../tracker.ts";
import {
	genericIssueBody,
	genericIssueTitle,
	initialWorkflowTarget,
	invalidTransition,
	isRecord,
	lifecycleError,
	parseJsonInput,
	parseWorkflowCommandInput,
	readInput,
	validateWorkflowCommandOutput,
	workflowCommandByCli,
	readOption,
} from "./shared.ts";

export async function manifestCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	commandHandlers: CommandHandlers = {},
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
	const handler = commandHandlers[command.id];
	if (handler !== undefined) {
		return handledManifestCommand(
			args,
			tracker,
			manifest,
			stdin,
			command,
			handler,
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

async function handledManifestCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	command: ManifestCommand,
	handler: NonNullable<CommandHandlers[string]>,
): Promise<Envelope> {
	if (handler.rawInput === true) {
		const result = await handler({
			command,
			manifest,
			tracker,
			input: null,
			args,
			...(stdin === undefined ? {} : { stdin }),
		});
		if (isEnvelope(result)) {
			return result.ok ? validateHandlerSuccess(command, result.data) : result;
		}
		return validateHandlerSuccess(command, result);
	}
	const verb = args[0] as "create" | "apply";
	const issueId = verb === "apply" ? args[2] : undefined;
	const inputPath = readOption(args, "--input");
	if (inputPath === undefined || (verb === "apply" && issueId === undefined)) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage:
				verb === "create"
					? `awf create ${command.cli?.target ?? command.target.kind} --input <file|->`
					: `awf apply ${command.cli?.target ?? command.target.action} <issue> --input <file|->`,
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
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	const result = await handler({
		command,
		manifest,
		tracker,
		input: payload.data,
		...(issueId === undefined ? {} : { issueId }),
	});
	if (isEnvelope(result)) {
		if (!result.ok) {
			return result;
		}
		return validateHandlerSuccess(command, result.data);
	}
	return validateHandlerSuccess(command, result);
}

function validateHandlerSuccess(
	command: ManifestCommand,
	data: JsonValue,
): Envelope {
	const outputValidation = validateWorkflowCommandOutput(command, data);
	if (outputValidation !== undefined) {
		return outputValidation;
	}
	return success(data);
}

function isEnvelope(value: unknown): value is Envelope {
	return isRecord(value) && typeof value.ok === "boolean";
}

export async function createGenericWorkflowIssueCommand(
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
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	try {
		const { issue, log } = await tracker.createWorkflowIssue({
			title: genericIssueTitle(payload.data, command.cli?.target ?? kind.id),
			body: genericIssueBody(payload.data, raw),
			workflow: { kind: kind.id, ...initialWorkflowTarget(kind.initial) },
			initialLog: {
				type: `${command.id}_created`,
				payload: { input: payload.data },
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

export async function applyGenericWorkflowCommand(
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
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	try {
		const issue = await tracker.getIssue(issueId);
		if (
			issue.workflow.kind !== command.target.kind ||
			issue.workflow.action !== command.target.action
		) {
			return invalidTransition(issueId, command.id);
		}
		const result = await tracker.recordCommand(issueId, {
			log: {
				type: `${command.id}_applied`,
				payload: { input: payload.data },
			},
		});
		const data = { issue: result.issue, log: result.log, outcome: "APPLIED" };
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		return lifecycleError(issueId, error);
	}
}
