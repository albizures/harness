import { defaultManifest } from "./default-manifest.ts";
import { type Envelope, failure, success } from "./envelope.ts";
import { validateManifest, type WorkflowManifest } from "./manifest.ts";
import type { Tracker } from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";
import {
	parseReadyOptions,
	validateKnownCommand,
} from "./commands/args.ts";
import { manifestCommand } from "./commands/create-apply.ts";
import { getIssueCommand } from "./commands/get.ts";
import { helpCommands, helpReadiness } from "./commands/help.ts";
import {
	escalateCommand,
	resumeCommand,
	startCommand,
	terminalCommand,
} from "./commands/lifecycle.ts";
import { logsCommand } from "./commands/logs.ts";
import { validateManifestCommand } from "./commands/manifest-validate.ts";
import { readyCommand } from "./commands/ready.ts";
import { reconcileCommand } from "./commands/reconcile.ts";
import { readOption } from "./commands/shared.ts";

export type ExecuteOptions = {
	tracker?: Tracker;
	manifest?: WorkflowManifest;
	stdin?: string;
};

export async function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): Promise<Envelope> {
	const manifest = options.manifest ?? defaultManifest;
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return success({
			name: "awf",
			description: "Agent workflow CLI.",
			commands: helpCommands(manifest),
			readiness: helpReadiness(manifest),
		});
	}

	if (args[0] === "--version" || args[0] === "-v") {
		return success({ name: "@albizures/awf", version: "0.0.0" });
	}

	const parseError = validateKnownCommand(args);
	if (parseError !== undefined) {
		return parseError;
	}

	if (args[0] === "manifest" && args[1] === "validate") {
		return validateManifestCommand(args[2]);
	}

	const tracker = options.tracker ?? createInMemoryTracker();
	const manifestIssues = validateManifest(manifest);
	if (manifestIssues.length > 0) {
		return failure(
			"MANIFEST_VALIDATION_FAILED",
			"Workflow manifest validation failed.",
			{ issues: manifestIssues },
		);
	}

	if (args[0] === "get") {
		return getIssueCommand(args[1], tracker);
	}
	if (args[0] === "logs") {
		return logsCommand(args[1], tracker);
	}
	if (args[0] === "reconcile") {
		return reconcileCommand(args[1], args.includes("--apply"), tracker);
	}
	if (args[0] === "ready") {
		return readyCommand(parseReadyOptions(args), tracker, manifest);
	}
	if (args[0] === "create" || args[0] === "apply") {
		return manifestCommand(args, tracker, manifest, options.stdin);
	}
	if (args[0] === "start") {
		return startCommand(args[1], tracker, manifest);
	}
	if (args[0] === "succeed" || args[0] === "fail") {
		return terminalCommand(
			args[0],
			args[1],
			readOption(args, "--run"),
			readOption(args, "--input"),
			tracker,
			manifest,
			options.stdin,
		);
	}
	if (args[0] === "escalate") {
		return escalateCommand(
			args[1],
			readOption(args, "--input"),
			tracker,
			manifest,
			options.stdin,
		);
	}
	if (args[0] === "resume") {
		return resumeCommand(
			args[1],
			readOption(args, "--action"),
			tracker,
			manifest,
		);
	}

	return failure(
		"NOT_IMPLEMENTED",
		"This workflow command is not implemented yet.",
		{
			command: args.join(" "),
		},
	);
}
