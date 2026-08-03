import { failure, type Envelope } from "../envelope.ts";
import { readOption, unknownCommand } from "./shared.ts";

const maxReconcileArgumentCount = 3;
const createHandoffArgumentCount = 6;
export function validateKnownCommand(
	args: Array<string>,
): Envelope | undefined {
	const [command, subcommand] = args;

	switch (command) {
		case "get":
		case "logs":
		case "start":
			return requirePositionalCount(args, 1, `awf ${command} <id>`);
		case "reconcile":
			return validateReconcile(args);
		case "ready":
			return validateReady(args);
		case "succeed":
		case "fail":
			return validateTerminalArguments(args, command);
		case "escalate":
			return requirePositionalAndOption(
				args,
				"awf escalate <id> --input <file|->",
				"--input",
				1,
			);
		case "resume":
			return requirePositionalAndOption(
				args,
				"awf resume <id> --action <action>",
				"--action",
				1,
			);
		case "create":
			return validateManifestCommandArguments(args, "create");
		case "apply":
			return validateManifestCommandArguments(args, "apply");
		case "manifest":
			if (subcommand !== "validate") {
				return unknownCommand(args);
			}
			return requirePositionalCount(args, 1, "awf manifest validate <file>", 2);
		default:
			return unknownCommand(args);
	}
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
	verb: "create" | "apply",
): Envelope | undefined {
	const target = args[1];
	if (target === undefined || target === "" || target.startsWith("-")) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf ${verb} <target> ...`,
		});
	}
	if (verb === "create") {
		if (args.includes("--source")) {
			const usage = `awf create ${target} --source <issue> --input <file|->`;
			const source = readOption(args, "--source");
			const input = readOption(args, "--input");
			const allowed = new Set([
				"create",
				target,
				"--source",
				"--input",
				...(source === undefined ? [] : [source]),
				...(input === undefined ? [] : [input]),
			]);
			if (
				source !== undefined &&
				source !== "" &&
				!source.startsWith("-") &&
				input !== undefined &&
				input !== "" &&
				args.length === createHandoffArgumentCount &&
				args.every((arg) => allowed.has(arg))
			) {
				return undefined;
			}
			return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
				usage,
			});
		}
		return requirePositionalAndOption(
			args,
			`awf create ${target} --input <file|->`,
			"--input",
			1,
		);
	}
	return requirePositionalAndOption(
		args,
		`awf apply ${target} <issue> --input <file|->`,
		"--input",
		2,
	);
}

function validateReconcile(args: Array<string>): Envelope | undefined {
	const usage = "awf reconcile <id> [--apply]";
	if (args[1] === undefined || args[1] === "" || args[1].startsWith("-")) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	const allowed = new Set(["reconcile", args[1], "--apply"]);
	if (
		args.length > maxReconcileArgumentCount ||
		args.some((arg) => !allowed.has(arg))
	) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	return undefined;
}

function invalidReadyArguments(): Envelope {
	return failure("INVALID_ARGUMENTS", "Invalid arguments for ready.", {
		usage: "awf ready [--filter <name=value>] [--limit <n>]",
	});
}

function validateTerminalArguments(
	args: Array<string>,
	command: string,
): Envelope | undefined {
	const minimumTerminalArgumentCount = 4;
	const terminalArgumentCountWithInput = 6;
	const usage = `awf ${command} <id> --run <run> --input <file|->`;
	if (args[1] === undefined || args[1] === "" || args[1].startsWith("-")) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	const run = readOption(args, "--run");
	const input = readOption(args, "--input");
	const allowed = new Set([command, args[1], "--run", run, "--input", input]);
	if (
		run === undefined ||
		run === "" ||
		(input !== undefined && input === "") ||
		(input === undefined && args.length !== minimumTerminalArgumentCount) ||
		(input !== undefined && args.length !== terminalArgumentCountWithInput) ||
		args.some((arg) => !allowed.has(arg))
	) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage,
		});
	}
	return undefined;
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

	return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
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

	return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}
