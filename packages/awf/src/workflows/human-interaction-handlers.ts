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
	isRecord,
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

const respondInputSchema = z.strictObject({
	response: nonEmptyString,
	sufficient: z.boolean(),
	resumeAction: nonEmptyString.optional(),
});

export function humanInteractionCommandHandlers(): CommandHandlers {
	return {
		pause: rawCommandHandler(pauseCommand),
		respond: rawCommandHandler(respondCommand),
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

async function respondCommand(
	context: Parameters<CommandHandler>[0],
): Promise<Envelope> {
	const id = context.args?.[2];
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf run-command respond <id> --input <file|->"
		});
	}
	try {
		const [, raw] = await readInput(context);
		const parsedInput = parseJsonInput(raw, "INVALID_ACTION_INPUT");
		if (parsedInput.ok === false) {
			return parsedInput;
		}
		const payload = parsePayloadValue(
			parsedInput.data,
			respondInputSchema,
			"$",
		);
		if (payload.issues.length > 0) {
			return failure("INVALID_ACTION_INPUT", "Response input is invalid.", {
				issues: payload.issues,
			});
		}
		const issue = await context.tracker.getIssue(id);
		if (
			issue.workflow.state !== "waiting-human" ||
			issue.workflow.action !== "none"
		) {
			return invalidTransition(id, "respond");
		}
		const input = payload.value as {
			response: string;
			sufficient: boolean;
			resumeAction?: string;
		};
		const pause = latestHumanPause(await context.tracker.readLogs(id));
		const resumeAction = input.resumeAction ?? pause?.resumeAction;
		const from = cleanCurrentTarget(issue.workflow);
		if (!input.sufficient) {
			const log: TrackerLog = {
				type: "human_response_received",
				message: stableStringify({
					event: "respond",
					input: parseJsonValue(payload.value),
					from,
					to: from,
					response: input.response,
					sufficient: false,
					...(resumeAction === undefined ? {} : { resumeAction }),
				}),
			};
			const result = await context.tracker.applyWorkflowEffects({
				effects: [{ type: "record-command", issue: { id }, log }],
			});
			return success({
				issue: result.issues[id] ?? (await context.tracker.getIssue(id)),
				log: result.logs[0],
			});
		}
		if (
			resumeAction === undefined ||
			!isReadyAction(context.manifest, issue.workflow.kind, resumeAction) ||
			!resumePolicyAllows(context.manifest, issue.workflow.kind, resumeAction)
		) {
			return failure(
				"COMMAND_UNAVAILABLE",
				"Workflow response cannot determine a manifest-declared resume action.",
				{
					id,
					command: "respond",
					...(resumeAction === undefined ? {} : { resumeAction }),
				},
			);
		}
		const to = { state: "ready", action: resumeAction };
		const result = await context.tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: { state: "ready", action: resumeAction, reason: undefined },
				},
				{
					type: "record-command",
					issue: { id },
					log: {
						type: "human_response_received",
						message: stableStringify({
							event: "respond",
							input: parseJsonValue(payload.value),
							from,
							to,
							response: input.response,
							sufficient: true,
							resumeAction,
							...(pause?.reason === undefined ? {} : { reason: pause.reason }),
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

function latestHumanPause(
	logs: Array<TrackerLog>,
): { reason?: string; resumeAction?: string } | undefined {
	for (const log of [...logs].reverse()) {
		if (log.type !== "human_input_needed" || log.message === undefined) {
			continue;
		}
		let data: unknown;
		try {
			data = JSON.parse(log.message);
		} catch {
			continue;
		}
		if (!isRecord(data)) {
			continue;
		}
		let resumeAction: string | undefined;
		if (typeof data.resumeAction === "string") {
			resumeAction = data.resumeAction;
		} else if (typeof data.pausedAction === "string") {
			resumeAction = data.pausedAction;
		}
		return {
			...(typeof data.reason === "string" ? { reason: data.reason } : {}),
			...(resumeAction === undefined ? {} : { resumeAction }),
		};
	}
	return undefined;
}
