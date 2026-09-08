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
	const envelope = commandDoesNotNeedConfig(output.args)
		? await execute(output.args)
		: await executeBoundCommand(output.args);

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

async function executeBoundCommand(args: Array<string>) {
	const binding = await bindCliExecution(args, process.cwd());
	return "ok" in binding
		? binding
		: execute(binding.args, {
				manifest: binding.manifest,
				tracker: binding.tracker,
				commandHandlers: binding.commandHandlers,
				lifecycleHandlers: binding.lifecycleHandlers,
				stdin: readStdinForDashInput(binding.args),
			});
}

function commandDoesNotNeedConfig(args: Array<string>): boolean {
	const commandArgs = argsWithoutConfigOption(args);
	const command = commandArgs[0];

	return (
		command === "--version" ||
		command === "-v" ||
		(command === "manifest" && commandArgs[1] === "validate")
	);
}

function argsWithoutConfigOption(args: Array<string>): Array<string> {
	const index = args.indexOf("--config");
	if (index === -1) {
		return args;
	}
	return args.filter(
		(_, argIndex) => argIndex !== index && argIndex !== index + 1,
	);
}

function readStdinForDashInput(args: Array<string>): string | undefined {
	const inputIndex = args.indexOf("--input");
	if (inputIndex === -1 || args[inputIndex + 1] !== "-") {
		return undefined;
	}
	return readFileSync(0, "utf8");
}
