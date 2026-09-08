import type {
	ManifestCommand,
	WorkflowManifest,
} from "../manifest/manifest.ts";
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
		name: "workflow describe",
		usage: "awf workflow describe",
		description: "Describe the loaded workflow manifest.",
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
	].sort((a, b) => a.name.localeCompare(b.name));
}

function manifestCommandUsage(command: ManifestCommand): string {
	if (command.cli?.verb === "create") {
		if (command.cli.source === true) {
			return `awf create ${command.cli.target} --source <issue> --input <file|->`;
		}
		return `awf create ${command.cli.target} --input <file|->`;
	}
	return `awf ${command.cli?.verb ?? "run-command"} ${command.cli?.target ?? command.id} <issue> --input <file|->`;
}

export function helpReadiness(manifest: WorkflowManifest): {
	filters: Array<HelpReadinessFilterSpec>;
	namedFilters: Array<HelpNamedReadinessFilterSpec>;
	subkinds: Array<{ kind: string; values: Array<string> }>;
} {
	return {
		filters: readinessFilters(manifest).map((filter) => ({ ...filter })),
		namedFilters: (manifest.readiness?.namedFilters ?? []).map((filter) => ({
			...filter,
			usage: `awf ready --filter ${filter.name}=<${filter.kind}>`,
		})),
		subkinds: manifest.kinds.flatMap((kind) =>
			kind.subkinds === undefined
				? []
				: [{ kind: kind.id, values: [...kind.subkinds] }],
		),
	};
}
