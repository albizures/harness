import { isAbsolute, relative } from "node:path";
import type { JsonValue } from "type-fest";
import type { CommandHandlers } from "../command-handlers.ts";
import { failure, success, type Envelope } from "../envelope.ts";
import type { ManifestCommand, WorkflowManifest } from "../manifest.ts";
import { NeedReconciliationError, type Tracker } from "../tracker.ts";
import {
	genericIssueBody,
	genericIssueTitle,
	initialWorkflowTarget,
	invalidTransition,
	isRecord,
	lifecycleError,
	parseJsonInput,
	parsePlanInput,
	parseSpecInput,
	parseWorkflowCommandInput,
	planApplicationTarget,
	readInput,
	parseStructuredArtifactInput,
	validatePlanPayload,
	validateWorkflowCommandInput,
	validateWorkflowCommandOutput,
	workflowCommand,
	workflowCommandByCli,
	readOption,
	workflowTarget,
} from "./shared.ts";
import { IssueNotFoundError } from "../workflow/issue.ts";

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

async function handledManifestCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	command: ManifestCommand,
	handler: NonNullable<CommandHandlers[string]>,
): Promise<Envelope> {
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

export async function createSpecCommand(
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
	const inputValidation = validateWorkflowCommandInput(command, {
		spec: { type: "markdown", ref: raw },
	});
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

export async function createHandoffCommand(
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
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	if (!isRecord(payload.data)) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
			{ issues: [{ path: "$.handoff", message: "Value is required." }] },
		);
	}
	const artifactInput = parseStructuredArtifactInput(
		payload.data.handoff,
		"handoff",
		"Handoff",
		"$.handoff",
	);
	if (artifactInput.issue !== undefined || artifactInput.value === undefined) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
			{
				issues: [
					artifactInput.issue ?? {
						path: "$.handoff",
						message: "Value is required.",
					},
				],
			},
		);
	}

	try {
		await tracker.getIssue(sourceId);
		const { artifacts, log } = await tracker.recordArtifacts(sourceId, {
			artifacts: [artifactInput.value],
			log: {
				type: "handoff_created",
				payload: {
					input: payload.data,
					artifact: artifactInput.value,
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

export async function applyPlanCommand(
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
	const validationIssues = validatePlanPayload(parsedInput.data);
	if (validationIssues.length > 0) {
		return failure("INVALID_PLAN", "Plan bundle is invalid.", {
			issues: validationIssues,
		});
	}
	const plan = parsePlanInput(raw);

	const ticketKind = manifest.kinds.find((kind) => kind.id === "ticket");
	if (ticketKind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define ticket kind.",
		);
	}
	const target = planApplicationTarget(manifest, spec.workflow);
	if (target === undefined) {
		return invalidTransition(specId, "apply-plan");
	}

	try {
		const effects = [
			...plan.tickets.flatMap((ticket) => [
				{
					type: "create-workflow-issue" as const,
					key: ticket.key,
					input: {
						title: ticket.title,
						body: ticket.content,
						workflow: {
							kind: "ticket",
							...initialWorkflowTarget(ticketKind.initial),
						},
					},
				},
				{
					type: "add-child" as const,
					parent: { id: specId },
					child: { key: ticket.key },
				},
			]),
			...plan.tickets.flatMap((ticket) =>
				(ticket.dependsOn ?? []).map((dependencyKey) => ({
					type: "add-dependency" as const,
					issue: { key: ticket.key },
					blockedBy: { key: dependencyKey },
				})),
			),
			{
				type: "update-workflow" as const,
				issue: { id: specId },
				expect: { version: spec.workflow.version, hash: spec.workflow.hash },
				workflow: { ...workflowTarget(target), activeRunId: undefined },
			},
			{
				type: "record-artifacts" as const,
				issue: { id: specId },
				artifacts: [planBundleArtifactInput(inputPath, plan.tickets.length)],
				log: {
					type: "plan_applied",
					payload: {
						input: planBundleArtifactReference(inputPath, plan.tickets.length),
					},
				},
			},
		];
		const applied = await tracker.applyWorkflowEffects({ effects });
		const tickets = plan.tickets.map((ticket) => {
			const created = applied.createdIssues.find(
				(issue) => issue.key === ticket.key,
			);
			if (created === undefined) {
				throw new NeedReconciliationError(
					"NEED_RECONCILIATION: workflow issue creation could not be verified.",
				);
			}
			return { key: ticket.key, id: created.id };
		});
		const artifact = applied.artifacts[0]?.artifact;
		if (artifact === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: plan bundle artifact was not recorded.",
			);
		}
		const log = applied.logs.at(-1);
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow log addition could not be verified.",
			);
		}
		const data = {
			outcome: "SUCCESS",
			spec: applied.issues[specId] ?? (await tracker.getIssue(specId)),
			tickets,
			artifact,
			log,
		};
		const outputValidation = validateWorkflowCommandOutput(command, data);
		if (outputValidation !== undefined) {
			return outputValidation;
		}
		return success(data);
	} catch (error) {
		return lifecycleError(specId, error);
	}
}

type PlanBundleArtifactReference =
	| {
			type: "inline";
			ref: string;
			title: string;
			metadata: { ticketCount: number };
	  }
	| {
			type: "file";
			path: string;
			title: string;
			metadata: { ticketCount: number };
	  };

function planBundleArtifactInput(inputPath: string, ticketCount: number) {
	const reference = planBundleArtifactReference(inputPath, ticketCount);
	return {
		...reference,
		kind: reference.type,
		uri: reference.type === "file" ? reference.path : reference.ref,
		name: "Plan bundle",
	};
}

function planBundleArtifactReference(
	inputPath: string,
	ticketCount: number,
): PlanBundleArtifactReference {
	if (inputPath === "-") {
		return {
			type: "inline" as const,
			ref: "submitted-plan-bundle",
			title: "Submitted plan bundle",
			metadata: { ticketCount },
		};
	}
	return {
		type: "file" as const,
		path: workflowArtifactFilePath(inputPath),
		title: "Submitted plan bundle",
		metadata: { ticketCount },
	};
}

function workflowArtifactFilePath(path: string): string {
	return isAbsolute(path) ? relative(process.cwd(), path) : path;
}
