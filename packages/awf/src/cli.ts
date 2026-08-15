#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { bindCliExecution } from "./cli-config.ts";
import { execute } from "./commands.ts";
import { serializeEnvelope } from "./envelope.ts";
import { CorruptWorkflowProjectionError } from "./tracker.ts";

declare const process: {
	argv: Array<string>;
	stdout: { write: (chunk: string) => void };
	cwd: () => string;
	exitCode?: number;
};

try {
	const rawArgs = process.argv.slice(2);
	const binding = await bindCliExecution(rawArgs, process.cwd());
	const envelope =
		"ok" in binding
			? binding
			: await execute(binding.args, {
					manifest: binding.manifest,
					tracker: binding.tracker,
					stdin: readStdinForDashInput(binding.args),
				});
	process.stdout.write(serializeEnvelope(envelope));
	process.exitCode = envelope.ok ? 0 : 1;
} catch (error) {
	if (
		error instanceof CorruptWorkflowProjectionError ||
		error instanceof SyntaxError
	) {
		process.stdout.write(
			serializeEnvelope({
				ok: false,
				error: { code: "CORRUPT_WORKFLOW_PROJECTION", message: error.message },
			}),
		);
		process.exitCode = 1;
	} else {
		throw error;
	}
}

function readStdinForDashInput(args: Array<string>): string | undefined {
	const inputIndex = args.indexOf("--input");
	if (inputIndex === -1 || args[inputIndex + 1] !== "-") {
		return undefined;
	}
	return readFileSync(0, "utf8");
}
