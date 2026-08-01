import type { JsonValue } from "type-fest";
import { failure, success, type Envelope } from "../envelope.ts";
import type { ManifestCommand, WorkflowManifest } from "../manifest.ts";
import { IssueNotFoundError, NeedReconciliationError, type Tracker } from "../tracker.ts";
import { escalatePartialRollback, genericIssueBody, genericIssueTitle, initialWorkflowTarget, invalidTransition, isRecord, lifecycleError, parseJsonInput, parsePlanInput, parseSpecInput, parsePayloadValue, planApplicationTarget, readInput, readTicketContent, rollbackPlanApplication, validatePlan, validateWorkflowCommandInput, validateWorkflowCommandOutput, workflowCommand, workflowCommandByCli, readOption, workflowTarget } from "./shared.ts";

export async function manifestCommand(
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
