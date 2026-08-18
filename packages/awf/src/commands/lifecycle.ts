import { randomUUID } from "node:crypto";
import type { JsonValue } from "type-fest";
import { z } from "zod";
import { failure, success, type Envelope } from "../envelope.ts";
import { parseJsonValue } from "../json.ts";
import type { LifecycleTransitionHandlers } from "../lifecycle-handlers.ts";
import { runLifecycleTransitionHandler } from "../lifecycle-handlers.ts";
import type { WorkflowManifest } from "../manifest.ts";
import type { Tracker, TrackerLog } from "../tracker.ts";
import type { WorkflowArtifactInput } from "../workflow/artifact.ts";
import type { WorkflowChange } from "../workflow/change.ts";
import {
	parseBundledArtifactInputs,
	cleanCurrentTarget,
	cleanTransitionTarget,
	defaultRetryTarget,
	escalationPolicyAllows,
	findTransition,
	invalidTransition,
	isReadyAction,
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

const escalationInputSchema = z.strictObject({
	reason: z.string().refine((value) => value.trim() !== "", {
		message: "Escalation reason must be a non-empty string.",
	}),
});

export async function startCommand(
	id: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	lifecycleHandlers?: LifecycleTransitionHandlers,
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
		if (lifecycleHandlers === undefined) {
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
					payload: {
						event: "start",
						to: cleanTransitionTarget(transition.to),
					},
				},
			});
			return success({ issue: updated, run: { id: runId }, log });
		}
		const handler = await runLifecycleTransitionHandler(lifecycleHandlers, {
			manifest,
			transition,
			issue,
			event: "start",
			input: {},
			runId,
		});
		if (handler.ok !== true) {
			return handler;
		}
		const target = workflowTarget(transition.to);
		const log: TrackerLog = {
			type: "action_started",
			runId,
			payload: {
				...handler.contribution.log,
				event: "start",
				to: cleanTransitionTarget(transition.to),
			},
		};
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: { ...target, activeRunId: runId },
				},
				recordLifecycleLogEffect(
					id,
					log,
					handler.contribution.artifacts,
					handler.contribution.changes,
				),
				...handler.contribution.effects,
			],
		});
		return success({
			issue: result.issues[id] ?? (await tracker.getIssue(id)),
			run: { id: runId },
			log: result.logs[0],
		});
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
	lifecycleHandlers?: LifecycleTransitionHandlers,
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
		const parsedInputJson =
			parsedInput === undefined
				? undefined
				: parsePayloadValue(parsedInput.data, undefined, "$");
		if (parsedInputJson?.issues.length) {
			return failure(
				"INVALID_ACTION_INPUT",
				"Action completion input is invalid.",
				{
					issues: parsedInputJson.issues,
				},
			);
		}
		const logs = await tracker.readLogs(id);
		const existing = logs.find(
			(log) => log.runId === runId && isTerminalLog(log.type),
		);
		const logType = terminalLogType(event);
		if (existing !== undefined) {
			if (
				existing.type === logType &&
				(parsedInputJson === undefined ||
					terminalLogInputMatches(
						existing.payload,
						parseJsonValue(parsedInputJson.value),
					))
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
		if (validationIssues.length > 0) {
			return failure(
				"INVALID_ACTION_INPUT",
				"Action completion input is invalid.",
				{ issues: validationIssues },
			);
		}
		const terminalInput = parseJsonValue(payload.value);
		const semanticIssue = validateBundledTerminalInput(
			issue,
			event,
			terminalInput,
		);
		if (semanticIssue !== undefined) {
			validationIssues.push(semanticIssue);
		}
		const bundledArtifacts = parseBundledArtifactInputs(
			issue.workflow,
			terminalInput,
		);
		validationIssues.push(...bundledArtifacts.issues);
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
		if (lifecycleHandlers === undefined) {
			const result = await tracker.completeRun(id, {
				expect: {
					version: issue.workflow.version,
					hash: issue.workflow.hash,
				},
				runId,
				workflow: target,
				artifacts: bundledArtifacts.artifacts,
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
		}
		const handler =
			transition === undefined
				? { ok: true as const, contribution: emptyLifecycleContribution() }
				: await runLifecycleTransitionHandler(lifecycleHandlers, {
						manifest,
						transition,
						issue,
						event,
						input: terminalInput,
						runId,
					});
		if (handler.ok !== true) {
			return handler;
		}
		const log: TrackerLog = {
			type: logType,
			runId,
			payload: {
				...handler.contribution.log,
				event,
				...(parsedInput === undefined ? {} : { input: terminalInput }),
				to: target,
			},
		};
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: { ...target, activeRunId: undefined },
				},
				recordLifecycleLogEffect(
					id,
					log,
					[...bundledArtifacts.artifacts, ...handler.contribution.artifacts],
					handler.contribution.changes,
				),
				...handler.contribution.effects,
			],
		});
		const updated = result.issues[id] ?? (await tracker.getIssue(id));
		await progressParentSpecAfterTicketDone(tracker, issue, updated);
		return success({
			issue: updated,
			run: { id: runId, status: event },
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}

function emptyLifecycleContribution(): {
	log: Record<string, JsonValue>;
	artifacts: Array<WorkflowArtifactInput>;
	changes: Array<Omit<WorkflowChange, "id">>;
	effects: [];
} {
	return { log: {}, artifacts: [], changes: [], effects: [] };
}

function recordLifecycleLogEffect(
	id: string,
	log: TrackerLog,
	artifacts: Array<WorkflowArtifactInput>,
	changes: Array<Omit<WorkflowChange, "id">>,
): {
	type: "record-artifacts";
	issue: { id: string };
	artifacts?: Array<WorkflowArtifactInput>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: TrackerLog;
} {
	return {
		type: "record-artifacts",
		issue: { id },
		...(artifacts.length === 0 ? {} : { artifacts }),
		...(changes.length === 0 ? {} : { changes }),
		log,
	};
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
		const payload = parsePayloadValue(
			parsedInput.data,
			manifest.lifecycle?.escalation?.input ?? escalationInputSchema,
			"$",
		);
		if (payload.issues.length > 0) {
			return failure("INVALID_ACTION_INPUT", "Escalation input is invalid.", {
				issues: payload.issues,
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
					input: parseJsonValue(payload.value),
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
