import type { FailureDefinition, FailureDetails } from "../runtime/envelope.ts";

const invalidArgumentsMessage = "Invalid command arguments.";

export type CliConfigLoadFailureInput = {
	path: string;
	message: string;
	details?: FailureDetails;
};

export type CliInvalidArgumentsFailureInput = {
	usage: string;
};

export const cliFailures = {
	configLoadFailed(
		input: CliConfigLoadFailureInput,
	): FailureDefinition<"CONFIG_LOAD_FAILED"> {
		return {
			code: "CONFIG_LOAD_FAILED",
			message: input.message,
			details: { path: input.path, ...input.details },
		};
	},
	invalidArguments(
		input: CliInvalidArgumentsFailureInput,
	): FailureDefinition<"INVALID_ARGUMENTS"> {
		return {
			code: "INVALID_ARGUMENTS",
			message: invalidArgumentsMessage,
			details: { usage: input.usage },
		};
	},
} as const;
