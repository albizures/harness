#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { bindCliExecution } from "./cli-config.ts";
import { execute } from "./commands.ts";
import { parseOutputFormat, serializeCliOutput } from "./output.ts";
import { CorruptWorkflowProjectionError } from "./workflow/projection.ts";

declare const process: {
	argv: Array<string>;
	stdout: { write: (chunk: string) => void };
	cwd: () => string;
	exitCode?: number;
};

try {
	const rawArgs = process.argv.slice(2);
	const output = parseOutputFormat(rawArgs);
	const binding = await bindCliExecution(output.args, process.cwd());
	const envelope =
		"ok" in binding
			? binding
			: await execute(binding.args, {
					manifest: binding.manifest,
					tracker: binding.tracker,
					commandHandlers: binding.commandHandlers,
					lifecycleHandlers: binding.lifecycleHandlers,
					stdin: readStdinForDashInput(binding.args),
				});

	process.stdout.write(serializeCliOutput(envelope, output.format));
	process.exitCode = envelope.ok ? 0 : 1;
} catch (error) {
	if (
		error instanceof CorruptWorkflowProjectionError ||
		error instanceof SyntaxError
	) {
		const output = parseOutputFormat(process.argv.slice(2));
		process.stdout.write(
			serializeCliOutput(
				{
					ok: false,
					error: {
						code: "CORRUPT_WORKFLOW_PROJECTION",
						message: error.message,
					},
				},
				output.format,
			),
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
