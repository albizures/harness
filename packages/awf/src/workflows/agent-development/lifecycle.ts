import {
	isRecord,
	type RuntimeValidationIssue,
} from "../../commands/shared.ts";
import { failure } from "../../envelope.ts";
import {
	lifecycleTransitionHandlerKey,
	type LifecycleTransitionHandlers,
} from "../../lifecycle-handlers.ts";
import type { WorkflowIssue } from "../../domain/workflow/issue.ts";

export const agentDevelopmentLifecycleHandlers: LifecycleTransitionHandlers = {
	[lifecycleTransitionHandlerKey(
		"ticket",
		{ state: "running", action: "implement" },
		"succeed",
	)]: bundledTerminalHandler,
	[lifecycleTransitionHandlerKey(
		"ticket",
		{ state: "running", action: "review" },
		"succeed",
	)]: bundledTerminalHandler,
	[lifecycleTransitionHandlerKey(
		"ticket",
		{ state: "running", action: "review" },
		"fail",
	)]: bundledTerminalHandler,
	[lifecycleTransitionHandlerKey(
		"spec",
		{ state: "running", action: "integration-test" },
		"succeed",
	)]: bundledTerminalHandler,
	[lifecycleTransitionHandlerKey(
		"spec",
		{ state: "running", action: "integration-test" },
		"fail",
	)]: bundledTerminalHandler,
};

function bundledTerminalHandler({
	issue,
	event,
	input,
}: Parameters<LifecycleTransitionHandlers[string]>[0]) {
	const validationIssues: Array<RuntimeValidationIssue> = [];
	const semanticIssue = validateBundledTerminalInput(
		issue,
		event === "fail" ? "fail" : "succeed",
		input,
	);
	if (semanticIssue !== undefined) {
		validationIssues.push(semanticIssue);
	}
	if (validationIssues.length > 0) {
		return failure(
			"INVALID_ACTION_INPUT",
			"Action completion input is invalid.",
			{
				issues: validationIssues,
			},
		);
	}
	return undefined;
}

function validateBundledTerminalInput(
	issue: WorkflowIssue,
	event: "succeed" | "fail",
	input: unknown,
): RuntimeValidationIssue | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	if (
		issue.workflow.kind === "ticket" &&
		issue.workflow.action === "review" &&
		input.verdict !== (event === "succeed" ? "approved" : "changes-requested")
	) {
		return {
			path: "$.verdict",
			message: "Review verdict does not match the terminal event.",
		};
	}
	if (
		issue.workflow.kind === "spec" &&
		issue.workflow.action === "integration-test" &&
		input.verdict !== (event === "succeed" ? "passed" : "changes-needed")
	) {
		return {
			path: "$.verdict",
			message: "Integration verdict does not match the terminal event.",
		};
	}
	return undefined;
}
