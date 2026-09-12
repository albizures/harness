import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { CommandHandler, CommandHandlers } from "./command-handlers.ts";
import {
	lifecycleTransitionHandlerKey,
	type LifecycleTransitionHandler,
	type LifecycleTransitionHandlers,
} from "./lifecycle-handlers.ts";
import {
	normalizeManifest,
	validateManifest,
} from "../domain/manifest/define.ts";
import {
	ManifestValidationError,
	type WorkflowManifest,
	type WorkflowManifestDefinition,
} from "../domain/manifest/schema.ts";
import type { Tracker } from "../ports/tracker.ts";

export class WorkflowModuleLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowModuleLoadError";
	}
}

export type WorkflowModule = {
	manifest: WorkflowManifest;
	tracker?: Tracker;
	commandHandlers?: CommandHandlers;
	lifecycleHandlers?: LifecycleTransitionHandlers;
};

export async function loadManifest(
	modulePath: string,
): Promise<WorkflowManifest> {
	return loadAndValidateManifest(await importWorkflowModule(modulePath));
}

export async function loadWorkflowModule(
	modulePath: string,
): Promise<WorkflowModule> {
	const loaded = await importWorkflowModule(modulePath);
	const manifest = loadAndValidateManifest(loaded);
	return {
		manifest,
		tracker: extractTracker(loaded),
		commandHandlers: extractCommandHandlers(loaded, manifest),
		lifecycleHandlers: extractLifecycleHandlers(loaded, manifest),
	};
}

async function importWorkflowModule(modulePath: string): Promise<unknown> {
	const absolutePath = resolve(modulePath);
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
	});
	return jiti.import<unknown>(pathToFileURL(absolutePath).href, {
		default: true,
	});
}

function loadAndValidateManifest(loaded: unknown): WorkflowManifest {
	const manifest = extractManifest(loaded);
	const issues = validateManifest(manifest);
	if (issues.length > 0) {
		throw new ManifestValidationError(issues);
	}
	return normalizeManifest(manifest);
}

function extractManifest(loaded: unknown): WorkflowManifestDefinition {
	if (isRecord(loaded) && "manifest" in loaded) {
		return loaded.manifest as WorkflowManifestDefinition;
	}
	throw new WorkflowModuleLoadError("Workflow module must export 'manifest'.");
}

function extractTracker(loaded: unknown): Tracker | undefined {
	if (!isRecord(loaded) || !("tracker" in loaded)) {
		return undefined;
	}
	if (loaded.tracker === undefined) {
		return undefined;
	}
	if (!isTracker(loaded.tracker)) {
		throw new WorkflowModuleLoadError(
			"Workflow module export 'tracker' must be a concrete Tracker instance.",
		);
	}
	return loaded.tracker;
}

function extractCommandHandlers(
	loaded: unknown,
	manifest: WorkflowManifest,
): CommandHandlers | undefined {
	if (!isRecord(loaded) || !("commandHandlers" in loaded)) {
		return undefined;
	}
	if (loaded.commandHandlers === undefined) {
		return undefined;
	}
	if (!isRecord(loaded.commandHandlers)) {
		throw new WorkflowModuleLoadError(
			"Workflow module export 'commandHandlers' must be an object of functions keyed by manifest command id.",
		);
	}
	const commandIds = new Set(manifest.commands.map((command) => command.id));
	const handlers: CommandHandlers = {};
	for (const [id, handler] of Object.entries(loaded.commandHandlers)) {
		if (!commandIds.has(id)) {
			throw new WorkflowModuleLoadError(
				`Workflow module command handler '${id}' does not match a manifest command id.`,
			);
		}
		if (typeof handler !== "function") {
			throw new WorkflowModuleLoadError(
				`Workflow module command handler '${id}' must be a function.`,
			);
		}
		handlers[id] = handler as CommandHandler;
	}
	return handlers;
}

function extractLifecycleHandlers(
	loaded: unknown,
	manifest: WorkflowManifest,
): LifecycleTransitionHandlers | undefined {
	if (!isRecord(loaded) || !("lifecycleHandlers" in loaded)) {
		return undefined;
	}
	if (loaded.lifecycleHandlers === undefined) {
		return undefined;
	}
	if (!isRecord(loaded.lifecycleHandlers)) {
		throw new WorkflowModuleLoadError(
			"Workflow module export 'lifecycleHandlers' must be an object of functions keyed by lifecycle transition.",
		);
	}
	const transitionKeys = new Set(
		manifest.kinds.flatMap((kind) =>
			kind.transitions.map((transition) =>
				lifecycleTransitionHandlerKey(
					kind.id,
					transition.from,
					transition.event,
				),
			),
		),
	);
	const handlers: LifecycleTransitionHandlers = {};
	for (const [key, handler] of Object.entries(loaded.lifecycleHandlers)) {
		if (!transitionKeys.has(key)) {
			throw new WorkflowModuleLoadError(
				`Workflow module lifecycle handler '${key}' does not match a manifest transition key.`,
			);
		}
		if (typeof handler !== "function") {
			throw new WorkflowModuleLoadError(
				`Workflow module lifecycle handler '${key}' must be a function.`,
			);
		}
		handlers[key] = handler as LifecycleTransitionHandler;
	}
	return handlers;
}

function isTracker(value: unknown): value is Tracker {
	if (!isRecord(value)) {
		return false;
	}
	return [
		"createWorkflowIssue",
		"recordCommand",
		"changeRelationship",
		"applyWorkflowEffects",
		"repairIssue",
		"getIssue",
		"listIssues",
		"readLogs",
	].every((method) => typeof value[method] === "function");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
