import {
	execute as executeRuntime,
	type ExecuteOptions,
} from "./runtime/execute.ts";
import type { Envelope } from "./runtime/envelope.ts";
import { withBundledWorkflowHandlers } from "./workflows/bundled-defaults.ts";

export type { CommandHandlers } from "./runtime/command-handlers.ts";
export type { ExecuteOptions } from "./runtime/execute.ts";

/**
 * Public compatibility seam for programmatic AWF execution.
 *
 * Runtime dispatch lives in ./runtime/execute.ts; this adapter composes the
 * bundled workflow handler defaults that older callers received implicitly.
 */
export async function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): Promise<Envelope> {
	const handlers = withBundledWorkflowHandlers(options.manifest, options);
	return executeRuntime(args, {
		...options,
		commandHandlers: handlers.commandHandlers,
		lifecycleHandlers: handlers.lifecycleHandlers,
	});
}
