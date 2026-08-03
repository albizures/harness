import { randomUUID } from "node:crypto";
import type { JsonValue } from "type-fest";
import { failure, success, type Envelope } from "../envelope.ts";
import type { WorkflowManifest } from "../manifest.ts";
import type { Tracker } from "../tracker.ts";
import {
	bundledArtifactInputs,
	cleanCurrentTarget,
	cleanTransitionTarget,
	defaultRetryTarget,
	escalationPolicyAllows,
	findTransition,
	invalidTransition,
	isReadyAction,
	isRecord,
	isTerminalLog,
	lifecycleError,
	parseJsonInput,
	parsePayloadValue,
	policyViolation,
	progressParentSpecAfterTicketDone,
	readInput,
	resumePolicyAllows,
	retryPolicyAllows,
	terminalLogInputMatches,
	terminalLogType,
	validateBundledTerminalInput,
	workflowTarget,
} from "./shared.ts";

export async function startCommand(
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

export async function terminalCommand(
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

export async function escalateCommand(
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

export async function resumeCommand(
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
