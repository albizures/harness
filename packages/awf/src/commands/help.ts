import type { ManifestCommand, WorkflowManifest } from "../manifest.ts";
import { readinessFilters } from "./shared.ts";

export type CommandSpec = {
	name: string;
	usage: string;
	description: string;
};

type HelpReadinessFilterSpec = {
	kind?: string;
	state?: string;
	action?: string;
	reason?: string;
};

type HelpNamedReadinessFilterSpec = {
	name: string;
	kind: string;
	relationship: "parent";
	usage: string;
};

const runtimeCommands: Array<CommandSpec> = [
	{
		name: "get",
		usage: "awf get <id>",
		description: "Return a workflow entity.",
	},
	{
		name: "ready",
		usage: "awf ready [--filter <name=value>] [--limit <n>]",
		description: "Return legally executable work.",
	},
	{
		name: "logs",
		usage: "awf logs <id>",
		description: "Return immutable workflow logs.",
	},
	{
		name: "reconcile",
		usage: "awf reconcile <id> [--apply]",
		description:
			"Diagnose workflow projection/log drift and apply safe repairs.",
	},
	{
		name: "manifest validate",
		usage: "awf manifest validate <file>",
		description: "Load and validate a workflow manifest.",
	},
	{
		name: "start",
		usage: "awf start <id>",
		description: "Start the current action.",
	},
	{
		name: "succeed",
		usage: "awf succeed <id> --run <run> --input <file|->",
		description: "Mark a run as succeeded.",
	},
	{
		name: "fail",
		usage: "awf fail <id> --run <run> --input <file|->",
		description: "Mark a run as failed.",
	},
	{
		name: "escalate",
		usage: "awf escalate <id> --input <file|->",
		description: "Move work to need-human/none with a human-readable reason.",
	},
	{
		name: "resume",
		usage: "awf resume <id> --action <action>",
		description: "Resume need-human work at a valid ready action.",
	},
];
export function helpCommands(manifest: WorkflowManifest): Array<CommandSpec> {
	return [
		...runtimeCommands,
		...manifest.commands.flatMap((command) => {
			if (command.cli === undefined) {
				return [];
			}
			return [
				{
					name: `${command.cli.verb} ${command.cli.target}`,
					usage: manifestCommandUsage(command),
					description: `Run manifest command '${command.id}'.`,
				},
			];
		}),
	];
}

function manifestCommandUsage(command: ManifestCommand): string {
	if (command.cli?.verb === "apply") {
		return `awf apply ${command.cli.target} <issue> --input <file|->`;
	}
	if (command.id === "handoff-create") {
		return `awf create ${command.cli?.target ?? "handoff"} --source <issue> --input <file|->`;
	}
	return `awf create ${command.cli?.target ?? "target"} --input <file|->`;
}

export function helpReadiness(manifest: WorkflowManifest): {
	filters: Array<HelpReadinessFilterSpec>;
	namedFilters: Array<HelpNamedReadinessFilterSpec>;
} {
	return {
		filters: readinessFilters(manifest).map((filter) => ({ ...filter })),
		namedFilters: (manifest.readiness?.namedFilters ?? []).map((filter) => ({
			...filter,
			usage: `awf ready --filter ${filter.name}=<${filter.kind}>`,
		})),
	};
}
