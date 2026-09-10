import type { CommandHandlers } from "../runtime/command-handlers.ts";
import type { LifecycleTransitionHandlers } from "../runtime/lifecycle-handlers.ts";
import type { WorkflowManifest } from "../domain/manifest/schema.ts";
import {
	agentWorkflowCommandHandlers,
	agentWorkflowLifecycleHandlers,
	agentWorkflowManifest,
} from "./agent-workflow/index.ts";

export type BundledWorkflowHandlers = {
	commandHandlers: CommandHandlers;
	lifecycleHandlers?: LifecycleTransitionHandlers;
};

export function bundledWorkflowHandlers(
	manifest: WorkflowManifest,
): BundledWorkflowHandlers {
	return {
		commandHandlers: bundledCommandHandlers(manifest),
		lifecycleHandlers: bundledLifecycleHandlers(manifest),
	};
}

export function withBundledWorkflowHandlers(
	manifest: WorkflowManifest | undefined,
	handlers: {
		commandHandlers?: CommandHandlers;
		lifecycleHandlers?: LifecycleTransitionHandlers;
	},
): {
	commandHandlers?: CommandHandlers;
	lifecycleHandlers?: LifecycleTransitionHandlers;
} {
	if (manifest === undefined) {
		return handlers;
	}
	const bundled = bundledWorkflowHandlers(manifest);
	return {
		commandHandlers: {
			...bundled.commandHandlers,
			...handlers.commandHandlers,
		},
		lifecycleHandlers:
			bundled.lifecycleHandlers === undefined
				? handlers.lifecycleHandlers
				: {
						...bundled.lifecycleHandlers,
						...handlers.lifecycleHandlers,
					},
	};
}

function bundledCommandHandlers(manifest: WorkflowManifest): CommandHandlers {
	if (manifest.workflow.id === agentWorkflowManifest.workflow.id) {
		return agentWorkflowCommandHandlers;
	}
	return {};
}

function bundledLifecycleHandlers(
	manifest: WorkflowManifest,
): LifecycleTransitionHandlers | undefined {
	if (manifest.workflow.id === agentWorkflowManifest.workflow.id) {
		return agentWorkflowLifecycleHandlers;
	}
	return undefined;
}
