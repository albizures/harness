#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execute } from "./commands.ts";
import { serializeEnvelope } from "./envelope.ts";
import {
	CorruptWorkflowProjectionError,
	createInMemoryTrackerFromEnvironment,
} from "./tracker.ts";

declare const process: {
	argv: Array<string>;
	env: Record<string, string | undefined>;
	stdout: { write: (chunk: string) => void };
	exitCode?: number;
};

try {
	const args = process.argv.slice(2);
	const tracker = createInMemoryTrackerFromEnvironment(process.env);
	const envelope = await execute(args, {
		tracker,
		stdin: readStdinForDashInput(args),
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
