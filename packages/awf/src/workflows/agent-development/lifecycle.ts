import {
	isRecord,
	parseStructuredArtifactInput,
	type RuntimeValidationIssue,
	type StructuredArtifactInput,
} from "../../commands/shared.ts";
import { failure } from "../../envelope.ts";
import {
	lifecycleTransitionHandlerKey,
	type LifecycleTransitionHandlers,
} from "../../lifecycle-handlers.ts";
import type { WorkflowIssue } from "../../workflow/issue.ts";

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
	const bundledArtifacts = parseBundledArtifactInputs(issue.workflow, input);
	validationIssues.push(...bundledArtifacts.issues);
	if (validationIssues.length > 0) {
		return failure(
			"INVALID_ACTION_INPUT",
			"Action completion input is invalid.",
			{
				issues: validationIssues,
			},
		);
	}
	return { artifacts: bundledArtifacts.artifacts };
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

function parseBundledArtifactInputs(
	workflow: WorkflowIssue["workflow"],
	input: unknown,
): {
	artifacts: Array<StructuredArtifactInput>;
	issues: Array<RuntimeValidationIssue>;
} {
	if (!isRecord(input)) {
		return { artifacts: [], issues: [] };
	}
	const artifacts: Array<StructuredArtifactInput> = [];
	const issues: Array<RuntimeValidationIssue> = [];
	if (workflow.kind === "ticket" && workflow.action === "implement") {
		const artifact = parseStructuredArtifactInput(
			input.implementationPr,
			"pull-request",
			"Implementation PR",
			"$.implementationPr",
		);
		if (artifact.issue !== undefined) {
			issues.push(artifact.issue);
		}
		if (artifact.value !== undefined) {
			artifacts.push(artifact.value);
		}
	}
	if (workflow.kind === "spec" && workflow.action === "integration-test") {
		const artifact = parseStructuredArtifactInput(
			input.specPr,
			"pull-request",
			"Spec PR",
			"$.specPr",
		);
		if (artifact.issue !== undefined) {
			issues.push(artifact.issue);
		}
		if (artifact.value !== undefined) {
			artifacts.push(artifact.value);
		}
	}
	return { artifacts, issues };
}
