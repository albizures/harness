import type {
	ManifestCommand,
	ManifestLoggingCategoryPolicy,
	WorkflowManifest,
} from "./schema.ts";

type StateChangeSelector =
	| ManifestCommand
	| {
			commandId?: string;
			event?: string;
	  };

export function shouldLogCreation(
	manifest: WorkflowManifest,
	command: ManifestCommand | string,
): boolean {
	const commandId = typeof command === "string" ? command : command.id;
	return resolveLoggingPolicy(manifest, manifest.logging?.creation, {
		commandId,
	});
}

export function shouldLogStateChange(
	manifest: WorkflowManifest,
	selector: StateChangeSelector,
): boolean {
	const commandId = "id" in selector ? selector.id : selector.commandId;
	const event = "id" in selector ? selector.transition?.event : selector.event;
	return resolveLoggingPolicy(manifest, manifest.logging?.stateChanges, {
		commandId,
		event,
	});
}

function resolveLoggingPolicy(
	manifest: WorkflowManifest,
	category: ManifestLoggingCategoryPolicy | undefined,
	selector: { commandId?: string; event?: string },
): boolean {
	let enabled = manifest.logging?.enabled ?? true;
	enabled = category?.enabled ?? enabled;
	if (
		selector.event !== undefined &&
		category?.events?.[selector.event] !== undefined
	) {
		enabled = category.events[selector.event];
	}
	if (
		selector.commandId !== undefined &&
		category?.commands?.[selector.commandId] !== undefined
	) {
		enabled = category.commands[selector.commandId];
	}
	return enabled;
}
