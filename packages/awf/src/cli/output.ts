import type { JsonValue } from "type-fest";
import type { Envelope } from "../runtime/envelope.ts";
import { serializeEnvelope } from "../runtime/envelope.ts";

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
		if (isWorkflowDescription(data)) {
			return formatWorkflowDescription(data);
		}
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

function formatWorkflowDescription(data: Record<string, JsonValue>): string {
	const lines = [
		`# Workflow ${String((data.workflow as Record<string, JsonValue>).id)}`,
		"",
		`- Manifest schema: ${String(data.version)}`,
		`- Workflow version: ${String(isRecord(data.workflow) ? data.workflow.version : "unknown")}`,
		"",
		"## Vocabulary",
		"",
	];
	const vocabulary = data.vocabulary as Record<string, JsonValue>;
	lines.push(`- States: ${formatList(vocabulary.states)}`);
	lines.push(`- Actions: ${formatList(vocabulary.actions)}`);
	lines.push(`- Events: ${formatList(vocabulary.events)}`);

	lines.push("", "## Concurrency", "");
	const concurrency = data.concurrency as Record<string, JsonValue>;
	lines.push(`- Per issue: ${String(concurrency.perIssue)}`);
	if (typeof concurrency.perWorkflow === "number") {
		lines.push(`- Per workflow: ${concurrency.perWorkflow}`);
	}
	if (isRecord(concurrency.perKind)) {
		for (const [kind, limit] of Object.entries(concurrency.perKind)) {
			lines.push(`- Per kind ${kind}: ${String(limit)}`);
		}
	}
	if (isRecord(concurrency.perSubkind)) {
		for (const [kind, limits] of Object.entries(concurrency.perSubkind)) {
			if (!isRecord(limits)) {
				continue;
			}
			for (const [subkind, limit] of Object.entries(limits)) {
				lines.push(`- Per subkind ${kind}/${subkind}: ${String(limit)}`);
			}
		}
	}

	lines.push("", "## Kinds", "");
	for (const kind of data.kinds as Array<JsonValue>) {
		if (!isRecord(kind)) {
			continue;
		}
		lines.push(`- ${String(kind.id)} (${String(kind.label)})`);
		if (Array.isArray(kind.subkinds)) {
			lines.push(`  - Subkinds: ${formatList(kind.subkinds)}`);
		}
		if (isRecord(kind.initial)) {
			lines.push(`  - Initial: ${formatStateRef(kind.initial)}`);
		}
		lines.push("  - Transitions:");
		const transitions = Array.isArray(kind.transitions) ? kind.transitions : [];
		if (transitions.length === 0) {
			lines.push("    - None declared.");
		}
		for (const transition of transitions) {
			if (
				!isRecord(transition) ||
				!isRecord(transition.from) ||
				!isRecord(transition.to)
			) {
				continue;
			}
			lines.push(
				`    - ${formatStateRef(transition.from)} --${String(transition.event)}--> ${formatStateRef(transition.to)}`,
			);
		}
	}

	lines.push("", "## Commands", "");
	for (const command of data.commands as Array<JsonValue>) {
		if (!isRecord(command)) {
			continue;
		}
		lines.push(`- ${String(command.id)}`);
		if (isRecord(command.cli) && typeof command.cli.usage === "string") {
			lines.push(`  - Usage: ${command.cli.usage}`);
		}
		if (isRecord(command.target)) {
			lines.push(`  - Target: ${formatCommandTarget(command.target)}`);
		}
		lines.push(
			`  - Input: ${isRecord(command.input) && command.input.required === true ? "required" : "not required"}`,
		);
	}

	lines.push("", "## Readiness", "");
	formatReadinessDescription(lines, data.readiness);

	lines.push("", "## Lifecycle policies", "");
	formatLifecycleDescription(lines, data.lifecycle);

	lines.push("", "## Relationships", "");
	formatRelationshipsDescription(lines, data.relationships);

	lines.push("", "## Scope notes", "");
	for (const note of Array.isArray(data.scopeNotes) ? data.scopeNotes : []) {
		lines.push(`- ${String(note)}`);
	}
	return lines.join("\n");
}

function formatReadinessDescription(
	lines: Array<string>,
	readiness: JsonValue | undefined,
): void {
	if (!isRecord(readiness)) {
		lines.push("- No readiness policies declared.");
		return;
	}
	lines.push(
		"- Ready filters describe eligible workflow fields; they do not inspect current Tracker API state.",
	);
	for (const filter of Array.isArray(readiness.filters)
		? readiness.filters
		: []) {
		if (isRecord(filter)) {
			lines.push(`  - ${formatWorkflowFilter(filter)}`);
		}
	}
	if (Array.isArray(readiness.namedFilters)) {
		lines.push("- Named filters:");
		for (const filter of readiness.namedFilters) {
			if (isRecord(filter)) {
				lines.push(
					`  - ${String(filter.name)}: ${String(filter.relationship)} ${String(filter.kind)} (${String(filter.usage)})`,
				);
			}
		}
	}
	if (Array.isArray(readiness.relationshipPolicies)) {
		lines.push("- Relationship policies:");
		for (const policy of readiness.relationshipPolicies) {
			if (isRecord(policy)) {
				const where = isRecord(policy.where)
					? formatWorkflowFilter(policy.where)
					: "any";
				const children =
					isRecord(policy.children) && isRecord(policy.children.all)
						? formatWorkflowFilter(policy.children.all)
						: "any";
				const minimum =
					isRecord(policy.children) && typeof policy.children.min === "number"
						? `, min ${policy.children.min}`
						: "";
				const gate =
					typeof policy.gate === "string" ? `, gate ${policy.gate}` : "";
				lines.push(
					`  - ${String(policy.relationship)} where ${where}; children all ${children}${minimum}${gate}`,
				);
			}
		}
	}
}

function formatLifecycleDescription(
	lines: Array<string>,
	lifecycle: JsonValue | undefined,
): void {
	if (!isRecord(lifecycle)) {
		lines.push("- No lifecycle policies declared.");
		return;
	}
	if (Array.isArray(lifecycle.activeStates)) {
		lines.push(`- Active states: ${formatList(lifecycle.activeStates)}`);
	}
	if (Array.isArray(lifecycle.terminalStates)) {
		lines.push(`- Terminal states: ${formatList(lifecycle.terminalStates)}`);
	}
	if (isRecord(lifecycle.retry)) {
		lines.push("- Retry:");
		formatPolicyTargets(lines, lifecycle.retry.allow);
	}
	if (isRecord(lifecycle.escalation)) {
		lines.push("- Escalation:");
		formatPolicyTargets(lines, lifecycle.escalation.allow);
	}
	if (isRecord(lifecycle.resume)) {
		lines.push("- Resume:");
		for (const target of Array.isArray(lifecycle.resume.allow)
			? lifecycle.resume.allow
			: []) {
			if (isRecord(target)) {
				lines.push(
					`  - ${String(target.kind)} actions: ${formatList(target.actions)}`,
				);
			}
		}
	}
	if (Array.isArray(lifecycle.relationshipPolicies)) {
		lines.push("- Relationship policies:");
		for (const policy of lifecycle.relationshipPolicies) {
			if (isRecord(policy)) {
				lines.push(
					`  - ${String(policy.relationship)} child ${isRecord(policy.child) ? formatWorkflowFilter(policy.child) : "any"}; parent ${isRecord(policy.parent) ? formatWorkflowFilter(policy.parent) : "any"}; siblings all ${isRecord(policy.siblings) && isRecord(policy.siblings.all) ? formatWorkflowFilter(policy.siblings.all) : "any"}; to ${isRecord(policy.to) ? formatStateRef(policy.to) : "unknown"}`,
				);
			}
		}
	}
}

function formatRelationshipsDescription(
	lines: Array<string>,
	relationships: JsonValue | undefined,
): void {
	if (!Array.isArray(relationships) || relationships.length === 0) {
		lines.push("- No relationships declared.");
		return;
	}
	for (const relationship of relationships) {
		if (!isRecord(relationship) || !isRecord(relationship.projection)) {
			continue;
		}
		lines.push(
			`- ${String(relationship.id)}: ${String(relationship.from)} -> ${String(relationship.to)} (${String(relationship.projection.type)})`,
		);
	}
}

function formatPolicyTargets(
	lines: Array<string>,
	targets: JsonValue | undefined,
): void {
	const items = Array.isArray(targets) ? targets : [];
	if (items.length === 0) {
		lines.push("  - Any declared target.");
		return;
	}
	for (const target of items) {
		if (isRecord(target)) {
			lines.push(`  - ${formatCommandTarget(target)}`);
		}
	}
}

function formatList(values: JsonValue | undefined): string {
	return Array.isArray(values) ? values.map(String).join(", ") : "none";
}

function formatStateRef(value: Record<string, JsonValue>): string {
	const base =
		typeof value.action === "string"
			? `${String(value.state)}/${value.action}`
			: String(value.state);
	return base;
}

function formatCommandTarget(value: Record<string, JsonValue>): string {
	return `${String(value.kind)}/${String(value.action)}`;
}

function formatWorkflowFilter(value: Record<string, JsonValue>): string {
	return (
		[value.kind, value.state, value.action]
			.filter((part): part is string => typeof part === "string")
			.join("/") || "any"
	);
}

function isWorkflowDescription(data: Record<string, JsonValue>): boolean {
	return (
		data.version === "v1" &&
		isRecord(data.workflow) &&
		typeof data.workflow.id === "string" &&
		typeof data.workflow.version === "string" &&
		isRecord(data.vocabulary) &&
		isRecord(data.concurrency) &&
		Array.isArray(data.kinds) &&
		Array.isArray(data.commands) &&
		Array.isArray(data.scopeNotes)
	);
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
	const readiness = isRecord(data.readiness) ? data.readiness : undefined;
	if (readiness !== undefined && Array.isArray(readiness.subkinds)) {
		const subkinds = readiness.subkinds.filter(
			(item): item is Record<string, JsonValue> => isRecord(item),
		);
		if (subkinds.length > 0) {
			lines.push("", "Subkinds:");
			for (const item of subkinds) {
				lines.push(
					`  ${String(item.kind)}: ${formatList(item.values)} (${String(item.kind)} remains the kind)`,
				);
			}
		}
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
	for (const items of issueReferenceArrays(data)) {
		lines.push("Created issues:");
		for (const item of items) {
			lines.push(
				`  ${String(item.id ?? "")} ${String(item.title ?? "")}`.trimEnd(),
			);
		}
	}
	return lines.join("\n");
}

function issueReferenceArrays(
	data: Record<string, JsonValue>,
): Array<Array<Record<string, JsonValue>>> {
	return Object.entries(data).flatMap(([key, value]) => {
		if (key === "issue" || key === "run" || key === "log") {
			return [];
		}
		if (!Array.isArray(value)) {
			return [];
		}
		const items = value.filter(
			(item): item is Record<string, JsonValue> =>
				isRecord(item) && typeof item.id === "string",
		);
		return items.length === 0 ? [] : [items];
	});
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
			return `${String(log.sequence ?? "")} ${String(log.type ?? "")}`.trim();
		})
		.join("\n");
}

function formatWorkflow(workflow: Record<string, JsonValue>): string {
	const lifecycle = [workflow.kind, workflow.state, workflow.action]
		.filter((value) => typeof value === "string" && value !== "none")
		.join("/");
	const subkind = workflowSubkind(workflow);
	return subkind === undefined
		? lifecycle
		: `${lifecycle}; subkind: ${subkind}`;
}

function workflowSubkind(
	workflow: Record<string, JsonValue>,
): string | undefined {
	if (typeof workflow.subkind === "string") {
		return workflow.subkind;
	}
	return isRecord(workflow.data) && typeof workflow.data.subkind === "string"
		? workflow.data.subkind
		: undefined;
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
