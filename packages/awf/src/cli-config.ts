import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonValue } from "type-fest";
import { defaultManifest } from "./default-manifest.ts";
import { failure, type Envelope } from "./envelope.ts";
import {
	ManifestValidationError,
	WorkflowModuleLoadError,
	loadWorkflowModule,
	type WorkflowManifest,
} from "./manifest.ts";
import type { Tracker } from "./tracker.ts";
import { createFileSystemTracker } from "./trackers/filesystem.ts";

export type CliBinding = {
	args: Array<string>;
	manifest: WorkflowManifest;
	tracker: Tracker;
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
			manifest: defaultManifest,
			tracker: defaultTracker(),
		};
	}

	if (parsed.explicit && !existsSync(configPath)) {
		return configFailure(configPath, "Config file does not exist.");
	}

	try {
		const workflowModule = await loadWorkflowModule(configPath);
		return {
			args: parsed.args,
			manifest: workflowModule.manifest,
			tracker: workflowModule.tracker ?? defaultTracker(),
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
