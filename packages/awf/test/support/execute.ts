import {
	execute as executeRuntime,
	type ExecuteOptions,
	type CommandHandlers,
} from "../../src/runtime/execute.ts";
import { withBundledWorkflowHandlers } from "../../src/workflows/bundled-defaults.ts";

export type { CommandHandlers, ExecuteOptions };

export function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): ReturnType<typeof executeRuntime> {
	const handlers = withBundledWorkflowHandlers(options.manifest, options);
	return executeRuntime(args, { ...options, ...handlers });
}
