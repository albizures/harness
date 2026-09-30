import type { JsonValue } from "type-fest";
import { z } from "zod";
import {
	readInput,
	type CommandHandler,
	type CommandHandlerContext,
	type CommandHandlers,
} from "../runtime/command-handlers.ts";
import { failure, success, type Envelope } from "../runtime/envelope.ts";
import { parseJsonValue } from "../shared/json.ts";
import { shouldLogStateChange } from "../domain/manifest/logging.ts";
import type { TrackerLog } from "../ports/tracker.ts";
import {
	invalidTransition,
	isReadyAction,
	lifecycleError,
	parseJsonInput,
	parsePayloadValue,
	policyViolation,
	proseLogMessage,
	readOption,
} from "../runtime/commands/shared.ts";

const nonEmptyString = z.string().refine((value) => value.trim() !== "", {
	message: "Value must be a non-empty string.",
});

const pauseInputSchema = z.strictObject({
	reason: nonEmptyString,
});

type Issue = Awaited<ReturnType<CommandHandlerContext["tracker"]["getIssue"]>>;
type HumanHandoffCommandConfig = {
	usage: string;
	inputSchema?: Parameters<typeof parsePayloadValue>[1];
	invalidInputMessage: string;
	event: string;
	toState: "waiting-human" | "need-human";
	logType: TrackerLog["type"];
	validate: (
		context: CommandHandlerContext,
		issue: Issue,
		id: string,
	) => Envelope | undefined;
};

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

const pauseCommand = humanHandoffCommand({
	usage: "awf run-command pause <id> --input <file|->",
	inputSchema: pauseInputSchema,
	invalidInputMessage: "Pause input is invalid.",
	event: "pause",
	toState: "waiting-human",
	logType: "human_input_needed",
	validate: (_context, issue, id) => {
		if (
			issue.workflow.state !== "running" ||
			issue.workflow.action === "none"
		) {
			return invalidTransition(id, "pause");
		}
		return undefined;
	},
});

const escalateCommand = humanHandoffCommand({
	usage: "awf run-command escalate <id> --input <file|->",
	invalidInputMessage: "Escalation input is invalid.",
	event: "escalate",
	toState: "need-human",
	logType: "human_intervention_needed",
	validate: (_context, _issue, _id) => undefined,
});

function humanHandoffCommand(
	config: HumanHandoffCommandConfig,
): CommandHandler {
	return async (context) => {
		const id = context.args?.[2];
		if (
			id === undefined ||
			readOption(context.args ?? [], "--input") === undefined
		) {
			return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage: config.usage,
			});
		}

		try {
			const input = await readPayloadInput(
				context,
				config.inputSchema,
				config.invalidInputMessage,
			);
			if (input.ok === false) {
				return input;
			}

			const issue = await context.tracker.getIssue(id);
			const validationFailure = config.validate(context, issue, id);
			if (validationFailure !== undefined) {
				return validationFailure;
			}

			const log: TrackerLog = {
				type: config.logType,
				message: proseLogMessage(config.event, input.data),
			};

			return applyWorkflowTransition(context, id, issue, {
				workflow: { state: config.toState, action: "none" },
				log,
			});
		} catch (error) {
			return lifecycleError(id, error);
		}
	};
}

async function readPayloadInput(
	context: CommandHandlerContext,
	schema: Parameters<typeof parsePayloadValue>[1],
	invalidInputMessage: string,
): Promise<Envelope<JsonValue>> {
	const [, raw] = await readInput(context);
	const parsedInput = parseJsonInput(raw, "INVALID_ACTION_INPUT");
	if (parsedInput.ok === false) {
		return parsedInput;
	}
	const payload = parsePayloadValue(parsedInput.data, schema, "$");
	if (payload.issues.length > 0) {
		return failure("INVALID_ACTION_INPUT", invalidInputMessage, {
			issues: payload.issues,
		});
	}
	return success(parseJsonValue(payload.value));
}

async function applyWorkflowTransition(
	context: CommandHandlerContext,
	id: string,
	issue: Issue,
	transition: {
		workflow: { state: string; action: string };
		log: TrackerLog;
	},
): Promise<Envelope> {
	const result = await context.tracker.applyWorkflowEffects({
		effects: [
			{
				type: "update-workflow",
				issue: { id },
				expect: {
					version: issue.workflow.version,
					hash: issue.workflow.hash,
				},
				workflow: transition.workflow,
			},
			...(shouldLogStateChange(context.manifest, context.command)
				? [
						{
							type: "record-command" as const,
							issue: { id },
							log: transition.log,
						},
					]
				: []),
		],
	});
	return success({
		issue: result.issues[id] ?? (await context.tracker.getIssue(id)),
		...(result.logs[0] === undefined ? {} : { log: result.logs[0] }),
	});
}

async function resumeCommand(
	context: Parameters<CommandHandler>[0],
): Promise<Envelope> {
	const id = context.args?.[2];
	const action = readOption(context.args ?? [], "--action");
	if (id === undefined || action === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf run-command resume <id> --action <action>",
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
		if (!isReadyAction(context.manifest, issue.workflow.kind, action)) {
			return policyViolation(id, "resume", action);
		}
		const log: TrackerLog = {
			type: "action_resumed",
			message: proseLogMessage("resume"),
		};
		return applyWorkflowTransition(context, id, issue, {
			workflow: { state: "ready", action },
			log,
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}
