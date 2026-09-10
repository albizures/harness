import { z } from "zod";
import {
	readInput,
	type CommandHandler,
	type CommandHandlers,
} from "../runtime/command-handlers.ts";
import { failure, success, type Envelope } from "../runtime/envelope.ts";
import { parseJsonValue } from "../shared/json.ts";
import type { TrackerLog } from "../ports/tracker.ts";
import {
	cleanCurrentTarget,
	invalidTransition,
	isReadyAction,
	lifecycleError,
	parseJsonInput,
	parsePayloadValue,
	policyViolation,
	readOption,
	resumePolicyAllows,
	escalationPolicyAllows,
	stableStringify,
} from "../runtime/commands/shared.ts";

const nonEmptyString = z.string().refine((value) => value.trim() !== "", {
	message: "Value must be a non-empty string.",
});

const pauseInputSchema = z.strictObject({
	reason: nonEmptyString,
	resumeAction: nonEmptyString.optional(),
});

export function humanInteractionCommandHandlers(): CommandHandlers {
	return {
		pause: rawCommandHandler(pauseCommand),
		escalate: rawCommandHandler(escalateCommand),
		resume: rawCommandHandler(resumeCommand),
	};
}

function rawCommandHandler(handler: CommandHandler): CommandHandler {
	handler.rawInput = true;
	return handler;
}

async function pauseCommand(
	context: Parameters<CommandHandler>[0],
): Promise<Envelope> {
	const id = context.args?.[2];
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf run-command pause <id> --input <file|->"
		});
	}
	try {
		const [, raw] = await readInput(context);
		const parsedInput = parseJsonInput(raw, "INVALID_ACTION_INPUT");
		if (parsedInput.ok === false) {
			return parsedInput;
		}
		const payload = parsePayloadValue(parsedInput.data, pauseInputSchema, "$");
		if (payload.issues.length > 0) {
			return failure("INVALID_ACTION_INPUT", "Pause input is invalid.", {
				issues: payload.issues,
			});
		}
		const issue = await context.tracker.getIssue(id);
		if (
			issue.workflow.state !== "running" ||
			issue.workflow.action === "none"
		) {
			return invalidTransition(id, "pause");
		}
		const input = payload.value as { reason: string; resumeAction?: string };
		const pausedAction = issue.workflow.action;
		const resumeAction = input.resumeAction ?? pausedAction;
		const from = cleanCurrentTarget(issue.workflow);
		const to = { state: "waiting-human", action: "none" };
		const result = await context.tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: {
						state: "waiting-human",
						action: "none",
						reason: undefined,
					},
				},
				{
					type: "record-command",
					issue: { id },
					log: {
						type: "human_input_needed",
						message: stableStringify({
							event: "pause",
							input: parseJsonValue(payload.value),
							from,
							to,
							pausedAction,
							resumeAction,
							reason: input.reason,
						}),
					},
				},
			],
		});
		return success({
			issue: result.issues[id] ?? (await context.tracker.getIssue(id)),
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function escalateCommand(
	context: Parameters<CommandHandler>[0],
): Promise<Envelope> {
	const id = context.args?.[2];
	if (
		id === undefined ||
		readOption(context.args ?? [], "--input") === undefined
	) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf run-command escalate <id> --input <file|->"
		});
	}
	try {
		const [, raw] = await readInput(context);
		const parsedInput = parseJsonInput(raw, "INVALID_ACTION_INPUT");
		if (parsedInput.ok === false) {
			return parsedInput;
		}
		const issue = await context.tracker.getIssue(id);
		if (!escalationPolicyAllows(context.manifest, issue.workflow)) {
			return policyViolation(id, "escalation", issue.workflow.action);
		}
		const from = cleanCurrentTarget(issue.workflow);
		const to = { state: "need-human", action: "none" };
		const log: TrackerLog = {
			type: "human_intervention_needed",
			message: stableStringify({
				event: "escalate",
				input: parseJsonValue(parsedInput.data),
				from,
				to,
			}),
		};
		const result = await context.tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: { state: "need-human", action: "none", reason: undefined },
				},
				{ type: "record-command", issue: { id }, log },
			],
		});
		return success({
			issue: result.issues[id] ?? (await context.tracker.getIssue(id)),
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function resumeCommand(
	context: Parameters<CommandHandler>[0],
): Promise<Envelope> {
	const id = context.args?.[2];
	const action = readOption(context.args ?? [], "--action");
	if (id === undefined || action === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf run-command resume <id> --action <action>"
		});
	}
	try {
		const issue = await context.tracker.getIssue(id);
		if (
			issue.workflow.state !== "need-human" ||
			issue.workflow.action !== "none"
		) {
			return invalidTransition(id, "resume");
		}
		if (
			!isReadyAction(context.manifest, issue.workflow.kind, action) ||
			!resumePolicyAllows(context.manifest, issue.workflow.kind, action)
		) {
			return policyViolation(id, "resume", action);
		}
		const log: TrackerLog = {
			type: "action_resumed",
			message: stableStringify({
				event: "resume",
				to: { state: "ready", action },
			}),
		};
		const result = await context.tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: { state: "ready", action, reason: undefined },
				},
				{ type: "record-command", issue: { id }, log },
			],
		});
		return success({
			issue: result.issues[id] ?? (await context.tracker.getIssue(id)),
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}
