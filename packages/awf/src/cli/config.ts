import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHandlers } from "../runtime/command-handlers.ts";
import type { LifecycleTransitionHandlers } from "../runtime/lifecycle-handlers.ts";
import { agentWorkflowManifest } from "../workflows/agent-workflow/index.ts";
import { bundledWorkflowHandlers } from "../workflows/bundled-defaults.ts";
import {
	failure,
	type Envelope,
	type FailureDetails,
} from "../runtime/envelope.ts";
import { cliFailures } from "./failures.ts";
import {
	ManifestValidationError,
	type WorkflowManifest,
} from "../domain/manifest/schema.ts";
import {
	WorkflowModuleLoadError,
	loadWorkflowModule,
} from "../runtime/workflow-module.ts";
import type { Tracker } from "../ports/tracker.ts";
import { createFileSystemTracker } from "../adapters/trackers/filesystem.ts";

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
		const bundled = bundledWorkflowHandlers(agentWorkflowManifest);
		return {
			args: parsed.args,
			manifest: agentWorkflowManifest,
			tracker: defaultTracker(),
			commandHandlers: bundled.commandHandlers,
			lifecycleHandlers: bundled.lifecycleHandlers,
		};
	}

	if (parsed.explicit && !existsSync(configPath)) {
		return failure(
			cliFailures.configLoadFailed({
				path: configPath,
				message: "Config file does not exist.",
			}),
		);
	}

	try {
		const workflowModule = await loadWorkflowModule(configPath);
		const bundled = bundledWorkflowHandlers(workflowModule.manifest);
		return {
			args: parsed.args,
			manifest: workflowModule.manifest,
			tracker: workflowModule.tracker ?? defaultTracker(),
			commandHandlers: {
				...bundled.commandHandlers,
				...workflowModule.commandHandlers,
			},
			lifecycleHandlers:
				bundled.lifecycleHandlers === undefined
					? workflowModule.lifecycleHandlers
					: {
							...bundled.lifecycleHandlers,
							...workflowModule.lifecycleHandlers,
						},
		};
	} catch (error) {
		return failure(
			cliFailures.configLoadFailed({
				path: configPath,
				message: formatConfigError(error),
				details: errorDetails(error),
			}),
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
			error: failure(
				cliFailures.invalidArguments({
					usage: "awf [--config <path>] <command> ...",
				}),
			),
		};
	}
	const configIndex = configIndexes[0];
	const value = args[configIndex + 1];
	if (value === undefined || value === "" || value.startsWith("-")) {
		return {
			error: failure(
				cliFailures.invalidArguments({
					usage: "awf [--config <path>] <command> ...",
				}),
			),
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

function formatConfigError(error: unknown): string {
	if (
		error instanceof WorkflowModuleLoadError ||
		error instanceof ManifestValidationError
	) {
		return error.message;
	}
	return `Could not load workflow config: ${error instanceof Error ? error.message : String(error)}`;
}

function errorDetails(error: unknown): FailureDetails {
	if (error instanceof ManifestValidationError) {
		return { issues: error.issues };
	}
	if (error instanceof Error && error.name !== "Error") {
		return { cause: error.name };
	}
	return {};
}
