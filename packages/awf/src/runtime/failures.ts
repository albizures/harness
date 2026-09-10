import type { FailureDefinition, FailureDetails } from "./envelope.ts";

const invalidArgumentsMessage = "Invalid command arguments.";
const unknownCommandMessage = "Unknown command.";

export type RuntimeFailureInput = {
	details?: FailureDetails;
	message?: string;
};

export const runtimeFailures = {
	COMMAND_HANDLER_REQUIRED: {
		code: "COMMAND_HANDLER_REQUIRED",
		message: "Manifest command requires a command handler.",
	},
	INVALID_ACTION_INPUT: {
		code: "INVALID_ACTION_INPUT",
		message: "Action completion input is invalid.",
	},
	LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED: {
		code: "LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED",
		message: "Lifecycle transition handler output is invalid.",
	},
	LIFECYCLE_POLICY_VIOLATION: {
		code: "LIFECYCLE_POLICY_VIOLATION",
		message: "Lifecycle policy does not allow this transition.",
	},
	MANIFEST_LOAD_FAILED: {
		code: "MANIFEST_LOAD_FAILED",
		message: "Workflow manifest could not be loaded.",
	},
	MANIFEST_REQUIRED: {
		code: "MANIFEST_REQUIRED",
		message: "AWF requires an explicit workflow manifest for this command.",
	},
	MANIFEST_UNSUPPORTED: {
		code: "MANIFEST_UNSUPPORTED",
		message: "Manifest command kind is unknown.",
	},
	MANIFEST_VALIDATION_FAILED: {
		code: "MANIFEST_VALIDATION_FAILED",
		message: "Workflow manifest validation failed.",
	},
	UNAVAILABLE_COMMAND: {
		code: "UNAVAILABLE_COMMAND",
		message:
			"Workflow command target does not match the issue's current workflow fields.",
	},
	UNKNOWN_COMMAND: {
		code: "UNKNOWN_COMMAND",
		message: unknownCommandMessage,
	},
	UNKNOWN_COMMAND_TARGET: {
		code: "UNKNOWN_COMMAND_TARGET",
		message: "Workflow command target is not declared by the manifest.",
	},
	WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED: {
		code: "WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
		message: "Workflow command input is invalid.",
	},
	commandHandlerRequired(input: {
		command: string;
	}): FailureDefinition<"COMMAND_HANDLER_REQUIRED"> {
		return {
			...this.COMMAND_HANDLER_REQUIRED,
			details: { command: input.command },
		};
	},
	corruptWorkflowProjection(
		input: RuntimeFailureInput,
	): FailureDefinition<"CORRUPT_WORKFLOW_PROJECTION"> {
		return {
			code: "CORRUPT_WORKFLOW_PROJECTION",
			message: input.message ?? "Corrupt workflow projection.",
			...(input.details === undefined ? {} : { details: input.details }),
		};
	},
	inputMustBeValidJson<
		TCode extends
			| "INVALID_ACTION_INPUT"
			| "WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	>(
		definition: FailureDefinition<TCode>,
		input: { message: string },
	): FailureDefinition<TCode> {
		return {
			code: definition.code,
			message: "Input must be valid JSON.",
			details: { message: input.message },
		};
	},
	invalidActionInput(input: {
		issues: FailureDetails["issues"];
	}): FailureDefinition<"INVALID_ACTION_INPUT"> {
		return {
			...this.INVALID_ACTION_INPUT,
			details: { issues: input.issues },
		};
	},
	invalidArguments(input: {
		usage: string;
		message?: string;
	}): FailureDefinition<"INVALID_ARGUMENTS"> {
		return {
			code: "INVALID_ARGUMENTS",
			message: input.message ?? invalidArgumentsMessage,
			details: { usage: input.usage },
		};
	},
	invalidReadyFilter(input: {
		message: string;
		details: FailureDetails;
	}): FailureDefinition<"INVALID_READY_FILTER"> {
		return {
			code: "INVALID_READY_FILTER",
			message: input.message,
			details: input.details,
		};
	},
	invalidTransition(input: {
		message: string;
		id: string;
		event: string;
	}): FailureDefinition<"INVALID_TRANSITION"> {
		return {
			code: "INVALID_TRANSITION",
			message: input.message,
			details: { id: input.id, event: input.event },
		};
	},
	lifecycleHandlerFailed(input: {
		key: string;
		message: string;
	}): FailureDefinition<"LIFECYCLE_HANDLER_FAILED"> {
		return {
			code: "LIFECYCLE_HANDLER_FAILED",
			message: "Lifecycle transition handler failed.",
			details: { key: input.key, message: input.message },
		};
	},
	lifecycleHandlerOutputValidationFailed(input: {
		issues: FailureDetails["issues"];
	}): FailureDefinition<"LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED"> {
		return {
			...this.LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED,
			details: { issues: input.issues },
		};
	},
	lifecyclePolicyViolation(input: {
		id: string;
		policy: string;
		action: string;
	}): FailureDefinition<"LIFECYCLE_POLICY_VIOLATION"> {
		return {
			...this.LIFECYCLE_POLICY_VIOLATION,
			details: {
				id: input.id,
				policy: input.policy,
				action: input.action,
			},
		};
	},
	manifestLoadFailed(input: {
		message: string;
	}): FailureDefinition<"MANIFEST_LOAD_FAILED"> {
		return {
			...this.MANIFEST_LOAD_FAILED,
			details: { message: input.message },
		};
	},
	manifestUnsupported(input: {
		command: string;
		kind: string;
	}): FailureDefinition<"MANIFEST_UNSUPPORTED"> {
		return {
			...this.MANIFEST_UNSUPPORTED,
			details: { command: input.command, kind: input.kind },
		};
	},
	manifestValidationFailed(input: {
		issues: FailureDetails["issues"];
	}): FailureDefinition<"MANIFEST_VALIDATION_FAILED"> {
		return {
			...this.MANIFEST_VALIDATION_FAILED,
			details: { issues: input.issues },
		};
	},
	needReconciliation(
		input: RuntimeFailureInput,
	): FailureDefinition<"NEED_RECONCILIATION"> {
		return {
			code: "NEED_RECONCILIATION",
			message: input.message ?? "Need reconciliation.",
			...(input.details === undefined ? {} : { details: input.details }),
		};
	},
	notFound(input: {
		message: string;
		id: string;
	}): FailureDefinition<"NOT_FOUND"> {
		return {
			code: "NOT_FOUND",
			message: input.message,
			details: { id: input.id },
		};
	},
	unavailableCommand(input: {
		id: string;
		command: string;
	}): FailureDefinition<"UNAVAILABLE_COMMAND"> {
		return {
			...this.UNAVAILABLE_COMMAND,
			details: { id: input.id, command: input.command },
		};
	},
	unknownCommand(input: {
		command: string;
	}): FailureDefinition<"UNKNOWN_COMMAND"> {
		return {
			code: "UNKNOWN_COMMAND",
			message: unknownCommandMessage,
			details: { command: input.command },
		};
	},
	unknownCommandTarget(input: {
		command: string;
	}): FailureDefinition<"UNKNOWN_COMMAND_TARGET"> {
		return {
			code: "UNKNOWN_COMMAND_TARGET",
			message: "Workflow command target is not declared by the manifest.",
			details: { command: input.command },
		};
	},
	workflowCommandInputValidationFailed(input: {
		command?: string;
		issues: FailureDetails["issues"];
	}): FailureDefinition<"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED"> {
		return {
			...this.WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED,
			details: {
				...(input.command === undefined ? {} : { command: input.command }),
				issues: input.issues,
			},
		};
	},
} as const;
