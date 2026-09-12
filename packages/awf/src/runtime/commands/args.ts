import { failure, type Envelope } from "../envelope.ts";
import type { WorkflowManifest } from "../../domain/manifest/schema.ts";
import { unknownCommand, workflowCommandByCli } from "./shared.ts";
import { runtimeFailures } from "../failures.ts";

const maxReconcileArgumentCount = 3;
export function validateKnownCommand(
	args: Array<string>,
	manifest?: WorkflowManifest,
): Envelope | undefined {
	const [command, subcommand] = args;

	switch (command) {
		case "get":
		case "logs":
			return requirePositionalCount(args, 1, `awf ${command} <id>`);
		case "reconcile":
			return validateReconcile(args);
		case "ready":
			return validateReady(args);
		case "create":
			return validateManifestCommandArguments(args, "create");
		case "run-command":
			return validateRunCommandArguments(args);
		case "manifest":
			if (subcommand !== "validate") {
				return unknownCommand(args);
			}
			return requirePositionalCount(args, 1, "awf manifest validate <file>", 2);
		case "workflow":
			return validateWorkflowArguments(args);
		default:
			return validateManifestCliArguments(args, manifest);
	}
}

function validateWorkflowArguments(args: Array<string>): Envelope | undefined {
	if (args.length === 2 && args[1] === "describe") {
		return undefined;
	}
	return failure(
		runtimeFailures.invalidArguments({ usage: "awf workflow describe" }),
	);
}

function validateManifestCliArguments(
	args: Array<string>,
	manifest: WorkflowManifest | undefined,
): Envelope | undefined {
	if (manifest === undefined) {
		return unknownCommand(args);
	}
	const command = workflowCommandByCli(manifest, args[0] ?? "", args[1]);
	if (command === undefined) {
		return unknownCommand(args);
	}
	return undefined;
}

function validateRunCommandArguments(
	args: Array<string>,
): Envelope | undefined {
	if (args[1] === undefined || args[1] === "" || args[1].startsWith("-")) {
		return failure(
			runtimeFailures.invalidArguments({
				usage: "awf run-command <command-id> ...",
			}),
		);
	}
	return undefined;
}

function validateReady(args: Array<string>): Envelope | undefined {
	const options = parseReadyOptions(args);
	if (
		options.error === undefined &&
		options.limit !== undefined &&
		(!Number.isInteger(options.limit) || options.limit < 1)
	) {
		return invalidReadyArguments();
	}
	return options.error === undefined ? undefined : invalidReadyArguments();
}

function validateManifestCommandArguments(
	args: Array<string>,
	verb: "create",
): Envelope | undefined {
	const target = args[1];
	if (target === undefined || target === "" || target.startsWith("-")) {
		return failure(
			runtimeFailures.invalidArguments({ usage: `awf ${verb} <target> ...` }),
		);
	}
	return requirePositionalAndOption(
		args,
		`awf create ${target} --input <file|->`,
		"--input",
		1,
	);
}

function validateReconcile(args: Array<string>): Envelope | undefined {
	const usage = "awf reconcile <id> [--apply]";
	if (args[1] === undefined || args[1] === "" || args[1].startsWith("-")) {
		return failure(runtimeFailures.invalidArguments({ usage }));
	}
	const allowed = new Set(["reconcile", args[1], "--apply"]);
	if (
		args.length > maxReconcileArgumentCount ||
		args.some((arg) => !allowed.has(arg))
	) {
		return failure(runtimeFailures.invalidArguments({ usage }));
	}
	return undefined;
}

function invalidReadyArguments(): Envelope {
	return failure(
		runtimeFailures.invalidArguments({
			message: "Invalid arguments for ready.",
			usage: "awf ready [--filter <name=value>] [--limit <n>]",
		}),
	);
}

export type ReadyOptions = {
	filters: Array<{ name: string; value: string }>;
	limit?: number;
	error?: true;
};

export function parseReadyOptions(args: Array<string>): ReadyOptions {
	const options: ReadyOptions = { filters: [] };
	for (let index = 1; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (value === undefined || value === "") {
			return { filters: [], error: true };
		}
		if (option === "--filter") {
			const parsed = parseNamedFilter(value);
			if (parsed === undefined) {
				return { filters: [], error: true };
			}
			options.filters.push(parsed);
		} else if (option === "--limit" && options.limit === undefined) {
			options.limit = Number(value);
		} else {
			return { filters: [], error: true };
		}
	}
	return options;
}

function parseNamedFilter(
	value: string,
): { name: string; value: string } | undefined {
	const separator = value.indexOf("=");
	if (separator <= 0 || separator === value.length - 1) {
		return undefined;
	}
	return {
		name: value.slice(0, separator),
		value: value.slice(separator + 1),
	};
}

function requirePositionalCount(
	args: Array<string>,
	count: number,
	usage: string,
	offset = 1,
): Envelope | undefined {
	const positionals = args.slice(offset).filter((arg) => !arg.startsWith("-"));
	if (positionals.length === count && args.length === offset + count) {
		return undefined;
	}

	return failure(runtimeFailures.invalidArguments({ usage }));
}

function requirePositionalAndOption(
	args: Array<string>,
	usage: string,
	optionName: string,
	prefixPositionals = 1,
): Envelope | undefined {
	const prefix = args.slice(1, 1 + prefixPositionals);
	const optionIndex = args.indexOf(optionName);
	if (
		prefix.every(
			(arg) => arg !== undefined && arg !== "" && !arg.startsWith("-"),
		) &&
		optionIndex === 1 + prefixPositionals &&
		args[optionIndex + 1] !== undefined &&
		args[optionIndex + 1] !== "" &&
		args.length === optionIndex + 2
	) {
		return undefined;
	}

	return failure(runtimeFailures.invalidArguments({ usage }));
}
