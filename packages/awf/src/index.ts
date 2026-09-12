export type {
	CommandHandler,
	CommandHandlerContext,
	CommandHandlerResult,
	CommandHandlers,
} from "./runtime/command-handlers.ts";
import {
	execute as executeRuntime,
	type ExecuteOptions,
} from "./runtime/execute.ts";
import { withBundledWorkflowHandlers } from "./workflows/bundled-defaults.ts";
export type { ExecuteOptions } from "./runtime/execute.ts";
export {
	agentWorkflowCommandHandlers,
	agentWorkflowLifecycleHandlers,
	agentWorkflowManifest,
} from "./workflows/agent-workflow/index.ts";
export {
	failure,
	serializeEnvelope,
	success,
	type Envelope,
	type ErrorEnvelope,
	type FailureDefinition,
	type FailureDetails,
	type SuccessEnvelope,
} from "./runtime/envelope.ts";
export {
	isJsonRecord,
	isJsonValue,
	jsonRecordSchema,
	jsonValueSchema,
	parseJsonRecord,
	parseJsonValue,
} from "./shared/json.ts";
export {
	findLifecycleTransitionHandler,
	lifecycleTransitionHandlerKey,
	runLifecycleTransitionHandler,
	type LifecycleTransitionHandler,
	type LifecycleTransitionHandlerContext,
	type LifecycleTransitionHandlerContribution,
	type LifecycleTransitionHandlers,
} from "./runtime/lifecycle-handlers.ts";
export {
	ManifestValidationError,
	type ValidationIssue,
} from "./domain/manifest/schema.ts";
export {
	workflowDescriptionScopeNotes,
	type WorkflowDescriptionSchemaInputV1,
	type WorkflowDescriptionStateRefV1,
	type WorkflowDescriptionV1,
	type WorkflowDescriptionWorkflowFilterV1,
} from "./domain/manifest/describe.ts";
export {
	createGhCliGitHubTracker,
	createGitHubTracker,
	validateGitHubTrackerCapabilities,
	type GitHubTrackerApi,
	type GitHubTrackerCapabilities,
	type GitHubTrackerIssue,
} from "./adapters/trackers/github/index.ts";
export { NeedReconciliationError, type Tracker } from "./ports/tracker.ts";
export { WorkflowLog } from "./domain/workflow/log.ts";
export {
	CorruptWorkflowProjectionError,
	type WorkflowProjection,
} from "./domain/workflow/projection.ts";
export {
	IssueNotFoundError,
	IssueRelationships,
	UpdateIssueInput,
	WorkflowIssue,
	CreateIssueInput,
} from "./domain/workflow/issue.ts";
export {
	createFileSystemTracker,
	type FileSystemTrackerOptions,
} from "./adapters/trackers/filesystem.ts";
export {
	createInMemoryTracker,
	createInMemoryTrackerFromEnvironment,
} from "./adapters/trackers/memory.ts";

export function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): ReturnType<typeof executeRuntime> {
	const handlers = withBundledWorkflowHandlers(options.manifest, options);
	return executeRuntime(args, { ...options, ...handlers });
}
