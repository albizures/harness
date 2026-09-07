import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonValue } from "type-fest";
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
import { failure, type Envelope } from "./envelope.ts";
import {
	ManifestValidationError,
	type WorkflowManifest,
} from "./manifest/manifest.ts";
import {
	WorkflowModuleLoadError,
	loadWorkflowModule,
} from "./workflow-module.ts";
import type { Tracker } from "./tracker.ts";
import { createFileSystemTracker } from "./trackers/filesystem.ts";

export type CliBinding = {
	args: Array<string>;
	manifest: WorkflowManifest;
	tracker: Tracker;
	commandHandlers: CommandHandlers;
	lifecycleHandlers?: LifecycleTransitionHandlers;
};

export async function bindCliExecution(
	args: Array<string>,
	cwd: string,
): Promise<CliBinding | Envelope> {
	const parsed = parseConfigOption(args, cwd);
	if ("error" in parsed) {
		return parsed.error;
	}

	const defaultTracker = () =>
		createFileSystemTracker({ path: resolve(cwd, ".awf", "tracker.json") });

	const configPath = parsed.configPath ?? discoverDefaultConfig(cwd);
	if (configPath === undefined) {
		return {
			args: parsed.args,
			manifest: agentWorkflowManifest,
			tracker: defaultTracker(),
			commandHandlers: agentWorkflowCommandHandlers,
			lifecycleHandlers: agentWorkflowLifecycleHandlers,
		};
	}

	if (parsed.explicit && !existsSync(configPath)) {
		return configFailure(configPath, "Config file does not exist.");
	}

	try {
		const workflowModule = await loadWorkflowModule(configPath);
		const bundledHandlers = bundledCommandHandlers(workflowModule.manifest);
		const bundledLifecycleHandlers = bundledLifecycleHandlersFor(
			workflowModule.manifest,
		);
		return {
			args: parsed.args,
			manifest: workflowModule.manifest,
			tracker: workflowModule.tracker ?? defaultTracker(),
			commandHandlers: {
				...bundledHandlers,
				...workflowModule.commandHandlers,
			},
			lifecycleHandlers: {
				...bundledLifecycleHandlers,
				...workflowModule.lifecycleHandlers,
			},
		};
	} catch (error) {
		return configFailure(
			configPath,
			formatConfigError(error),
			errorDetails(error),
		);
	}
}

type ParsedConfigOption =
	| { args: Array<string>; configPath?: string; explicit: boolean }
	| { error: Envelope };

function parseConfigOption(
	args: Array<string>,
	cwd: string,
): ParsedConfigOption {
	const configIndexes = args
		.map((arg, index) => (arg === "--config" ? index : -1))
		.filter((index) => index !== -1);
	if (configIndexes.length === 0) {
		return { args, explicit: false };
	}
	if (configIndexes.length > 1) {
		return {
			error: failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage: "awf [--config <path>] <command> ...",
			}),
		};
	}
	const configIndex = configIndexes[0];
	const value = args[configIndex + 1];
	if (value === undefined || value === "" || value.startsWith("-")) {
		return {
			error: failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage: "awf [--config <path>] <command> ...",
			}),
		};
	}
	return {
		args: args.filter(
			(_, index) => index !== configIndex && index !== configIndex + 1,
		),
		configPath: resolve(cwd, value),
		explicit: true,
	};
}

function discoverDefaultConfig(cwd: string): string | undefined {
	const configPath = resolve(cwd, "awf.config.ts");
	return existsSync(configPath) ? configPath : undefined;
}

function configFailure(
	path: string,
	message: string,
	details: Record<string, JsonValue> = {},
): Envelope {
	return failure("CONFIG_LOAD_FAILED", message, { path, ...details });
}

function bundledCommandHandlers(manifest: WorkflowManifest): CommandHandlers {
	if (manifest.workflow.id === agentDevelopmentManifest.workflow.id) {
		return agentDevelopmentCommandHandlers;
	}
	if (manifest.workflow.id === agentWorkflowManifest.workflow.id) {
		return agentWorkflowCommandHandlers;
	}
	return {};
}

function bundledLifecycleHandlersFor(
	manifest: WorkflowManifest,
): LifecycleTransitionHandlers {
	if (manifest.workflow.id === agentDevelopmentManifest.workflow.id) {
		return agentDevelopmentLifecycleHandlers;
	}
	if (manifest.workflow.id === agentWorkflowManifest.workflow.id) {
		return agentWorkflowLifecycleHandlers;
	}
	return {};
}

function formatConfigError(error: unknown): string {
	if (
		error instanceof WorkflowModuleLoadError ||
		error instanceof ManifestValidationError
	) {
		return error.message;
	}
	return `Could not load workflow config: ${error instanceof Error ? error.message : String(error)}`;
}

function errorDetails(error: unknown): Record<string, JsonValue> {
	if (error instanceof ManifestValidationError) {
		return { issues: error.issues };
	}
	if (error instanceof Error && error.name !== "Error") {
		return { cause: error.name };
	}
	return {};
}
