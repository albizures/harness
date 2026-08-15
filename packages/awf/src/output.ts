import type { JsonValue } from "type-fest";
import type { Envelope } from "./envelope.ts";
import { serializeEnvelope } from "./envelope.ts";

export type OutputFormat = "text" | "json";

export function parseOutputFormat(args: Array<string>): {
	args: Array<string>;
	format: OutputFormat;
} {
	return {
		args: args.filter((arg) => arg !== "--json"),
		format: args.includes("--json") ? "json" : "text",
	};
}

export function serializeCliOutput(
	envelope: Envelope,
	format: OutputFormat,
): string {
	if (format === "json") {
		return serializeEnvelope(envelope);
	}
	return serializeTextEnvelope(envelope);
}

function serializeTextEnvelope(envelope: Envelope): string {
	if (!envelope.ok) {
		const details = envelope.error.details;
		const detailLines =
			details === undefined
				? []
				: Object.entries(details).map(
						([key, value]) => `${key}: ${formatValue(value)}`,
					);
		return [
			`Error ${envelope.error.code}: ${envelope.error.message}`,
			...detailLines,
		]
			.join("\n")
			.concat("\n");
	}
	return `${formatData(envelope.data)}\n`;
}

function formatData(data: JsonValue): string {
	if (isRecord(data)) {
		if (Array.isArray(data.commands)) {
			return formatHelp(data);
		}
		if (Array.isArray(data.items)) {
			return formatReady(data);
		}
		if (isRecord(data.issue)) {
			return formatIssueResult(data);
		}
		if (Array.isArray(data.logs)) {
			return formatLogs(data.logs);
		}
		if (typeof data.manifest === "string") {
			return `Manifest ${data.manifest} ${typeof data.version === "string" ? data.version : ""}`.trim();
		}
	}
	return formatValue(data);
}

function formatHelp(data: Record<string, JsonValue>): string {
	const lines = [
		`${String(data.name ?? "awf")} - ${String(data.description ?? "Agent workflow CLI.")}`,
		"",
		"Commands:",
	];
	for (const command of data.commands as Array<JsonValue>) {
		if (!isRecord(command)) {
			continue;
		}
		lines.push(
			`  ${String(command.usage ?? command.name ?? "")}  ${String(command.description ?? "")}`.trimEnd(),
		);
	}
	lines.push("", "Use --json for machine-readable output.");
	return lines.join("\n");
}

function formatReady(data: Record<string, JsonValue>): string {
	const items = data.items as Array<JsonValue>;
	if (items.length === 0) {
		return "No ready work.";
	}
	return items
		.map((item) => {
			if (!isRecord(item)) {
				return formatValue(item);
			}
			const workflow = isRecord(item.workflow)
				? ` [${formatWorkflow(item.workflow)}]`
				: "";
			const command =
				isRecord(item.suggestedCommand) &&
				typeof item.suggestedCommand.display === "string"
					? ` — ${item.suggestedCommand.display}`
					: "";
			return `${String(item.id ?? "")} ${String(item.title ?? "")}${workflow}${command}`.trim();
		})
		.join("\n");
}

function formatIssueResult(data: Record<string, JsonValue>): string {
	const lines = [formatIssue(data.issue as Record<string, JsonValue>)];
	if (isRecord(data.run) && typeof data.run.id === "string") {
		lines.push(
			`Run: ${data.run.id}${typeof data.run.status === "string" ? ` (${data.run.status})` : ""}`,
		);
	}
	if (Array.isArray(data.tickets)) {
		lines.push("Tickets:");
		for (const ticket of data.tickets) {
			if (isRecord(ticket)) {
				lines.push(
					`  ${String(ticket.id ?? "")} ${String(ticket.title ?? "")}`.trimEnd(),
				);
			}
		}
	}
	return lines.join("\n");
}

function formatIssue(issue: Record<string, JsonValue>): string {
	const workflow = isRecord(issue.workflow)
		? ` [${formatWorkflow(issue.workflow)}]`
		: "";
	return `${String(issue.id ?? "")} ${String(issue.title ?? "")}${workflow}`.trim();
}

function formatLogs(logs: Array<JsonValue>): string {
	if (logs.length === 0) {
		return "No logs.";
	}
	return logs
		.map((log) => {
			if (!isRecord(log)) {
				return formatValue(log);
			}
			return `${String(log.sequence ?? "")} ${String(log.type ?? "")}${typeof log.runId === "string" ? ` (${log.runId})` : ""}`.trim();
		})
		.join("\n");
}

function formatWorkflow(workflow: Record<string, JsonValue>): string {
	return [workflow.kind, workflow.state, workflow.action, workflow.reason]
		.filter((value) => typeof value === "string" && value !== "none")
		.join("/");
}

function formatValue(value: JsonValue): string {
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value, undefined, 2);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
