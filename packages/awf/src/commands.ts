import type { CommandHandlers } from "./command-handlers.ts";
import type { LifecycleTransitionHandlers } from "./lifecycle-handlers.ts";
import {
	agentDevelopmentCommandHandlers,
	agentDevelopmentLifecycleHandlers,
	agentDevelopmentManifest,
} from "./workflows/agent-development/index.ts";
import {
	agentWorkflowCommandHandlers,
	agentWorkflowLifecycleHandlers,
	agentWorkflowManifest,
} from "./workflows/agent-workflow/index.ts";
import { type Envelope, failure, success } from "./envelope.ts";
import { describeWorkflow } from "./manifest/description.ts";
import { validateManifest } from "./manifest/definition.ts";
import type { WorkflowManifest } from "./manifest/manifest.ts";
import type { Tracker } from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";
import { parseReadyOptions, validateKnownCommand } from "./commands/args.ts";
import { manifestCommand } from "./commands/create-apply.ts";
import { getIssueCommand } from "./commands/get.ts";
import { helpCommands, helpReadiness } from "./commands/help.ts";
import { logsCommand } from "./commands/logs.ts";
import { validateManifestCommand } from "./commands/manifest-validate.ts";
import { readyCommand } from "./commands/ready.ts";
import { reconcileCommand } from "./commands/reconcile.ts";
import { workflowCommandByCli } from "./commands/shared.ts";

export type { CommandHandlers } from "./command-handlers.ts";

export type ExecuteOptions = {
	tracker?: Tracker;
	manifest?: WorkflowManifest;
	commandHandlers?: CommandHandlers;
	lifecycleHandlers?: LifecycleTransitionHandlers;
	stdin?: string;
};

function defaultCommandHandlers(manifest: WorkflowManifest): CommandHandlers {
	if (manifest.workflow.id === agentDevelopmentManifest.workflow.id) {
		return agentDevelopmentCommandHandlers;
	}
	if (manifest.workflow.id === agentWorkflowManifest.workflow.id) {
		return agentWorkflowCommandHandlers;
	}
	return {};
}

function lifecycleHandlersFor(
	manifest: WorkflowManifest,
	options: ExecuteOptions,
): LifecycleTransitionHandlers | undefined {
	let bundled: LifecycleTransitionHandlers | undefined;
	if (manifest.workflow.id === agentDevelopmentManifest.workflow.id) {
		bundled = agentDevelopmentLifecycleHandlers;
	} else if (manifest.workflow.id === agentWorkflowManifest.workflow.id) {
		bundled = agentWorkflowLifecycleHandlers;
	}
	if (bundled === undefined) {
		return options.lifecycleHandlers;
	}
	return { ...bundled, ...options.lifecycleHandlers };
}

export async function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): Promise<Envelope> {
	const manifest = options.manifest;
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		if (manifest === undefined) {
			return failure(
				"MANIFEST_REQUIRED",
				"AWF requires an explicit workflow manifest for this command.",
			);
		}
		return success({
			name: "awf",
			description: "Agent workflow CLI.",
			commands: helpCommands(manifest),
			readiness: helpReadiness(manifest),
		});
	}

	if (args[0] === "--version" || args[0] === "-v") {
		return success({ name: "@albizures/awf", version: "0.0.0" });
	}

	if (args[0] === "manifest" && args[1] === "validate") {
		const parseError = validateKnownCommand(args);
		if (parseError !== undefined) {
			return parseError;
		}
		return validateManifestCommand(args[2]);
	}

	const tracker = options.tracker ?? createInMemoryTracker();
	if (args[0] === "get" || args[0] === "logs" || args[0] === "reconcile") {
		const parseError = validateKnownCommand(args);
		if (parseError !== undefined) {
			return parseError;
		}
		if (args[0] === "get") {
			return getIssueCommand(args[1], tracker);
		}
		if (args[0] === "logs") {
			return logsCommand(args[1], tracker);
		}
		return reconcileCommand(args[1], args.includes("--apply"), tracker);
	}

	if (manifest === undefined) {
		return failure(
			"MANIFEST_REQUIRED",
			"AWF requires an explicit workflow manifest for this command.",
		);
	}

	const manifestIssues = validateManifest(manifest);
	if (manifestIssues.length > 0) {
		return failure(
			"MANIFEST_VALIDATION_FAILED",
			"Workflow manifest validation failed.",
			{ issues: manifestIssues },
		);
	}

	const parseError = validateKnownCommand(args, manifest);
	if (parseError !== undefined) {
		return parseError;
	}
	if (args[0] === "workflow" && args[1] === "describe") {
		return success(describeWorkflow(manifest));
	}
	if (args[0] === "ready") {
		return readyCommand(parseReadyOptions(args), tracker, manifest);
	}
	if (
		args[0] === "create" ||
		args[0] === "apply" ||
		args[0] === "run-command" ||
		workflowCommandByCli(manifest, args[0] ?? "", args[1]) !== undefined
	) {
		return manifestCommand(
			args,
			tracker,
			manifest,
			options.stdin,
			{
				...defaultCommandHandlers(manifest),
				...options.commandHandlers,
			},
			lifecycleHandlersFor(manifest, options),
		);
	}

	return failure("UNKNOWN_COMMAND", "Unknown command.", {
		command: args.join(" "),
	});
}
