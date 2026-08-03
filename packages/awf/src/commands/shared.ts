import { readFile } from "node:fs/promises";
import type { JsonValue } from "type-fest";
import { failure, success, type Envelope } from "../envelope.ts";
import type {
	ManifestCommand,
	PayloadZodSchema,
	ManifestNamedReadinessFilter,
	ManifestTransition,
	WorkflowManifest,
} from "../manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	NeedReconciliationError,
	ProjectionConflictError,
	type Tracker,
	type TrackerAdapter,
} from "../tracker.ts";
export type WorkflowFields = {
	kind: string;
	state: string;
	action?: string;
	reason?: string;
	activeRunId?: string;
};

export function readOption(
	args: Array<string>,
	name: string,
): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

export function workflowCommand(
	manifest: WorkflowManifest,
	id: string,
): ManifestCommand | undefined {
	return manifest.commands.find((command) => command.id === id);
}

export function workflowCommandByCli(
	manifest: WorkflowManifest,
	verb: "create" | "apply",
	target: string | undefined,
): ManifestCommand | undefined {
	return manifest.commands.find(
		(command) => command.cli?.verb === verb && command.cli.target === target,
	);
}

export function validateWorkflowCommandInput(
	command: ManifestCommand | undefined,
	value: JsonValue,
): Envelope | undefined {
	const result = parsePayloadValue(value, command?.input, "$input");
	if (result.issues.length === 0) {
		return undefined;
	}
	return failure(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
		"Workflow command input is invalid.",
		{
			...(command === undefined ? {} : { command: command.id }),
			issues: result.issues,
		},
	);
}

export function validateWorkflowCommandOutput(
	command: ManifestCommand | undefined,
	value: JsonValue,
): Envelope | undefined {
	const result = parsePayloadValue(value, command?.output, "$output");
	if (result.issues.length === 0) {
		return undefined;
	}
	return failure(
		"WORKFLOW_COMMAND_OUTPUT_VALIDATION_FAILED",
		"Workflow command output is invalid.",
		{
			...(command === undefined ? {} : { command: command.id }),
			issues: result.issues,
		},
	);
}

export async function readInput(
	path: string,
	stdin: string | undefined,
): Promise<string> {
	if (path === "-") {
		return stdin ?? "";
	}
	return readFile(path, "utf8");
}

export type SpecInput = { title: string; content: string };
export type PlanBundle = { tickets: Array<PlanTicket> };
export type PlanTicket = {
	key: string;
	title: string;
	content: string;
	dependsOn?: Array<unknown>;
};

export function parseSpecInput(raw: string): SpecInput {
	const parsed = parseJsonObject(raw);
	if (parsed !== undefined) {
		const contentValue = parsed.content ?? parsed.body ?? parsed.markdown;
		const content = typeof contentValue === "string" ? contentValue : raw;
		return {
			title:
				typeof parsed.title === "string" && parsed.title.trim() !== ""
					? parsed.title
					: titleFromMarkdown(content),
			content,
		};
	}
	return { title: titleFromMarkdown(raw), content: raw };
}

export function parsePlanInput(raw: string): PlanBundle {
	const parsed = parseJsonObject(raw);
	const tickets = Array.isArray(parsed?.tickets) ? parsed.tickets : [];
	return {
		tickets: tickets.map((ticket): PlanTicket => {
			const record = isRecord(ticket) ? ticket : {};
			return {
				key: typeof record.key === "string" ? record.key : "",
				title: typeof record.title === "string" ? record.title : "",
				content: readTicketContent(record),
				...(Array.isArray(record.dependsOn)
					? { dependsOn: record.dependsOn }
					: {}),
			};
		}),
	};
}

export function readTicketContent(record: Record<string, unknown>): string {
	if (typeof record.content === "string") {
		return record.content;
	}
	if (typeof record.body === "string") {
		return record.body;
	}
	return "";
}

export function parseJsonObject(
	raw: string,
): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function genericIssueTitle(input: JsonValue, fallback: string): string {
	if (
		isRecord(input) &&
		typeof input.title === "string" &&
		input.title.trim() !== ""
	) {
		return input.title;
	}
	return fallback;
}

export function genericIssueBody(input: JsonValue, raw: string): string {
	if (isRecord(input)) {
		if (typeof input.body === "string") {
			return input.body;
		}
		if (typeof input.content === "string") {
			return input.content;
		}
	}
	return raw;
}

export function parseJsonInput(raw: string, code: string): Envelope<JsonValue> {
	try {
		return success(JSON.parse(raw) as JsonValue);
	} catch (error) {
		return failure(code, "Input must be valid JSON.", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export type RuntimeValidationIssue = { path: string; message: string };

export type ParsedPayload = {
	value: unknown;
	issues: Array<RuntimeValidationIssue>;
};

export function parsePayloadValue(
	value: unknown,
	schema: PayloadZodSchema | undefined,
	path: string,
): ParsedPayload {
	if (schema === undefined) {
		return { value, issues: [] };
	}
	const result = schema.safeParse(value);
	if (result.success) {
		return { value: result.data, issues: [] };
	}
	return {
		value,
		issues: result.error.issues.map((issue) => ({
			path: formatPayloadPath(path, issue.path),
			message: issue.message,
		})),
	};
}

export function formatPayloadPath(
	root: string,
	path: ReadonlyArray<PropertyKey>,
): string {
	let formatted = root;
	for (const part of path) {
		formatted =
			typeof part === "number"
				? `${formatted}[${part}]`
				: `${formatted}.${String(part)}`;
	}
	return formatted;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function titleFromMarkdown(markdown: string): string {
	const heading = markdown
		.split(/\r?\n/u)
		.map((line) => line.match(/^#\s+(.+)$/u)?.[1]?.trim())
		.find((title) => title !== undefined && title !== "");
	return heading ?? "Spec";
}

export function validateBundledTerminalInput(
	issue: Awaited<ReturnType<Tracker["getIssue"]>>,
	event: "succeed" | "fail",
	input: JsonValue,
): RuntimeValidationIssue | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	if (
		issue.workflow.kind === "ticket" &&
		issue.workflow.action === "implement" &&
		event === "succeed" &&
		issue.artifacts.some((artifact) => artifact.kind === "pull-request")
	) {
		return {
			path: "$.implementationPr",
			message: "Ticket already has an implementation pull request artifact.",
		};
	}
	if (
		issue.workflow.kind === "ticket" &&
		issue.workflow.action === "review" &&
		input.verdict !== (event === "succeed" ? "approved" : "changes-requested")
	) {
		return {
			path: "$.verdict",
			message: "Review verdict does not match the terminal event.",
		};
	}
	if (
		issue.workflow.kind === "spec" &&
		issue.workflow.action === "integration-test" &&
		input.verdict !== (event === "succeed" ? "passed" : "changes-needed")
	) {
		return {
			path: "$.verdict",
			message: "Integration verdict does not match the terminal event.",
		};
	}
	return undefined;
}

type PullRequestArtifactInput = {
	kind: "pull-request";
	uri: string;
	name: string;
} & Record<string, JsonValue>;

export function bundledArtifactInputs(
	workflow: WorkflowFields,
	input: JsonValue,
): Array<PullRequestArtifactInput> {
	if (!isRecord(input)) {
		return [];
	}
	const artifacts: Array<PullRequestArtifactInput> = [];
	if (workflow.kind === "ticket" && workflow.action === "implement") {
		const artifact = pullRequestArtifactInput(
			input.implementationPr,
			"Implementation PR",
		);
		if (artifact !== undefined) {
			artifacts.push(artifact);
		}
	}
	if (workflow.kind === "spec" && workflow.action === "integration-test") {
		const artifact = pullRequestArtifactInput(input.specPr, "Spec PR");
		if (artifact !== undefined) {
			artifacts.push(artifact);
		}
	}
	return artifacts;
}

function pullRequestArtifactInput(
	value: JsonValue | undefined,
	name: string,
): PullRequestArtifactInput | undefined {
	if (typeof value === "string") {
		return { kind: "pull-request", uri: value, name };
	}
	if (!isRecord(value) || value.type !== "pull-request") {
		return undefined;
	}
	const uri = typeof value.url === "string" ? value.url : undefined;
	if (uri === undefined) {
		return undefined;
	}
	return {
		...value,
		kind: "pull-request",
		uri,
		name,
	} as PullRequestArtifactInput;
}

export function validatePlan(
	plan: PlanBundle,
): Array<{ path: string; message: string }> {
	const issues: Array<{ path: string; message: string }> = [];
	if (plan.tickets.length === 0) {
		issues.push({
			path: "$.tickets",
			message: "Plan must include at least one ticket.",
		});
	}
	const keys = new Set<string>();
	for (const [index, ticket] of plan.tickets.entries()) {
		const path = `$.tickets[${index}]`;
		if (ticket.key.trim() === "") {
			issues.push({
				path: `${path}.key`,
				message: "Ticket key must be non-empty.",
			});
		} else if (keys.has(ticket.key)) {
			issues.push({
				path: `${path}.key`,
				message: "Ticket key must be unique.",
			});
		} else {
			keys.add(ticket.key);
		}
		if (ticket.title.trim() === "") {
			issues.push({
				path: `${path}.title`,
				message: "Ticket title must be non-empty.",
			});
		}
		if (ticket.content.trim() === "") {
			issues.push({
				path: `${path}.content`,
				message: "Ticket content must be non-empty.",
			});
		}
	}
	for (const [index, ticket] of plan.tickets.entries()) {
		for (const dependency of ticket.dependsOn ?? []) {
			if (typeof dependency !== "string" || dependency.trim() === "") {
				issues.push({
					path: `$.tickets[${index}].dependsOn`,
					message: "Dependency references must be non-empty strings.",
				});
			} else if (!keys.has(dependency)) {
				issues.push({
					path: `$.tickets[${index}].dependsOn`,
					message: `Unknown dependency '${dependency}'.`,
				});
			}
		}
	}
	const cycle = findDependencyCycle(plan);
	if (cycle !== undefined) {
		issues.push({
			path: "$.tickets",
			message: `Dependency graph must be acyclic (${cycle.join(" -> ")}).`,
		});
	}
	return issues;
}

export function findDependencyCycle(
	plan: PlanBundle,
): Array<string> | undefined {
	const byKey = new Map(plan.tickets.map((ticket) => [ticket.key, ticket]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: Array<string> = [];
	function visit(key: string): Array<string> | undefined {
		if (visiting.has(key)) {
			return [...stack.slice(stack.indexOf(key)), key];
		}
		if (visited.has(key)) {
			return undefined;
		}
		visiting.add(key);
		stack.push(key);
		for (const dependency of byKey.get(key)?.dependsOn ?? []) {
			if (typeof dependency !== "string" || !byKey.has(dependency)) {
				continue;
			}
			const cycle = visit(dependency);
			if (cycle !== undefined) {
				return cycle;
			}
		}
		stack.pop();
		visiting.delete(key);
		visited.add(key);
		return undefined;
	}
	for (const key of byKey.keys()) {
		const cycle = visit(key);
		if (cycle !== undefined) {
			return cycle;
		}
	}
	return undefined;
}

export async function rollbackPlanApplication(
	tracker: TrackerAdapter,
	specId: string,
	specWorkflow: WorkflowFields,
	dependencies: Array<{ issueId: string; blockedById: string }>,
	children: Array<string>,
	createdIssueIds: Array<string>,
): Promise<Array<string>> {
	const errors: Array<string> = [];
	for (const dependency of [...dependencies].reverse()) {
		try {
			await tracker.removeDependency(
				dependency.issueId,
				dependency.blockedById,
			);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const childId of [...children].reverse()) {
		try {
			await tracker.removeChild(specId, childId);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const issueId of [...createdIssueIds].reverse()) {
		try {
			await tracker.deleteIssue(issueId);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		await tracker.updateIssue(specId, {
			workflow: {
				state: specWorkflow.state,
				action: specWorkflow.action,
				reason: specWorkflow.reason,
				activeRunId: specWorkflow.activeRunId,
			},
		});
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}

export async function escalatePartialRollback(
	tracker: TrackerAdapter,
	specId: string,
): Promise<void> {
	try {
		await tracker.updateIssue(specId, {
			workflow: { state: "need-human", action: "none", activeRunId: undefined },
		});
	} catch {
		// Best-effort escalation: the original partial rollback error remains the outcome.
	}
}

export async function progressParentSpecAfterTicketDone(
	tracker: Tracker,
	previous: Awaited<ReturnType<Tracker["getIssue"]>>,
	updated: Awaited<ReturnType<Tracker["getIssue"]>>,
): Promise<void> {
	const parentId = previous.relationships.parent;
	if (
		previous.workflow.kind !== "ticket" ||
		updated.workflow.state !== "done" ||
		updated.workflow.action !== "none" ||
		parentId === undefined
	) {
		return;
	}
	const parent = await tracker.getIssue(parentId);
	if (
		parent.workflow.kind !== "spec" ||
		parent.workflow.state !== "ready" ||
		parent.workflow.action !== "none" ||
		parent.relationships.children.length === 0
	) {
		return;
	}
	const children = await Promise.all(
		parent.relationships.children.map((childId) => tracker.getIssue(childId)),
	);
	if (!children.every((child) => isDone(child))) {
		return;
	}
	await tracker.advanceWorkflow(parentId, {
		expect: { version: parent.workflow.version, hash: parent.workflow.hash },
		workflow: { state: "ready", action: "integration-test" },
	});
}

export function readinessFilters(
	manifest: WorkflowManifest,
): Array<{ kind?: string; state?: string; action?: string; reason?: string }> {
	if (manifest.readiness !== undefined) {
		return manifest.readiness.filters;
	}
	return manifest.kinds.flatMap((kind) =>
		kind.transitions
			.filter((transition) => transition.event === "start")
			.map((transition) => ({
				kind: kind.id,
				state: transition.from.state,
				action: transition.from.action,
				...(transition.from.reason === undefined ||
				transition.from.reason === null
					? {}
					: { reason: transition.from.reason }),
			})),
	);
}

export function matchesReadinessFilters(
	workflow: WorkflowFields,
	filters: Array<{
		kind?: string;
		state?: string;
		action?: string;
		reason?: string;
	}>,
): boolean {
	return filters.some(
		(filter) =>
			fieldMatches(filter.kind, workflow.kind) &&
			fieldMatches(filter.state, workflow.state) &&
			fieldMatches(filter.action, workflow.action) &&
			fieldMatches(filter.reason, workflow.reason),
	);
}

export function fieldMatches(
	expected: string | undefined,
	actual: string | undefined,
): boolean {
	return expected === undefined || expected === actual;
}

export function validateNamedReadinessFilterDeclarations(
	filters: Array<{ name: string; value: string }>,
	manifest: WorkflowManifest,
): Envelope | undefined {
	for (const filter of filters) {
		if (namedReadinessFilter(manifest, filter.name) === undefined) {
			return failure(
				"INVALID_READY_FILTER",
				"Readiness filter is not declared by the manifest.",
				{
					filter: filter.name,
				},
			);
		}
	}
	return undefined;
}

export function validateNamedReadinessFilterValues(
	filters: Array<{ name: string; value: string }>,
	manifest: WorkflowManifest,
	byId: Map<string, { workflow: WorkflowFields }>,
): Envelope | undefined {
	for (const filter of filters) {
		const declaration = namedReadinessFilter(manifest, filter.name);
		if (declaration === undefined) {
			continue;
		}
		const issue = byId.get(filter.value);
		if (issue === undefined) {
			return failure(
				"INVALID_READY_FILTER",
				"Readiness filter value does not resolve to a workflow issue.",
				{
					filter: filter.name,
					value: filter.value,
				},
			);
		}
		if (issue.workflow.kind !== declaration.kind) {
			return failure(
				"INVALID_READY_FILTER",
				"Readiness filter value has the wrong workflow kind.",
				{
					filter: filter.name,
					value: filter.value,
					expectedKind: declaration.kind,
					actualKind: issue.workflow.kind,
				},
			);
		}
	}
	return undefined;
}

export function matchesNamedReadinessFilters(
	issue: { relationships: { parent?: string } },
	filters: Array<{ name: string; value: string }>,
	manifest: WorkflowManifest,
): boolean {
	return filters.every((filter) => {
		const declaration = namedReadinessFilter(manifest, filter.name);
		return (
			declaration !== undefined &&
			declaration.relationship === "parent" &&
			issue.relationships.parent === filter.value
		);
	});
}

export function namedReadinessFilter(
	manifest: WorkflowManifest,
	name: string,
): ManifestNamedReadinessFilter | undefined {
	return manifest.readiness?.namedFilters?.find(
		(filter) => filter.name === name,
	);
}

export function readyItem(issue: {
	id: string;
	title: string;
	workflow: WorkflowFields;
}) {
	return {
		id: issue.id,
		title: issue.title,
		workflow: cleanWorkflowFields(issue.workflow),
		suggestedCommand: {
			argv: ["start", issue.id],
			display: `awf start ${issue.id}`,
		},
	};
}

export function readinessBlocking(
	issue: {
		workflow: WorkflowFields;
		relationships: { dependencies: Array<string> };
	},
	byId: Map<string, { id: string; title: string; workflow: WorkflowFields }>,
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	return [
		...dependencyBlocking(issue, byId),
		...concurrencyBlocking(issue.workflow.kind, manifest, activeIssues),
	];
}

export function dependencyBlocking(
	issue: { relationships: { dependencies: Array<string> } },
	byId: Map<string, { id: string; title: string; workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	const blockedBy: Array<Record<string, JsonValue>> = [];
	for (const id of issue.relationships.dependencies) {
		const dependency = byId.get(id);
		if (isDone(dependency)) {
			continue;
		}
		blockedBy.push(
			dependency === undefined
				? { id, missing: true }
				: {
						id: dependency.id,
						title: dependency.title,
						workflow: cleanWorkflowFields(dependency.workflow),
					},
		);
	}
	return blockedBy.length === 0 ? [] : [{ gate: "dependency", blockedBy }];
}

export function concurrencyBlocking(
	kind: string,
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	const blocking: Array<Record<string, JsonValue>> = [];
	const workflowLimit = manifest.concurrency.perWorkflow;
	if (workflowLimit !== undefined && activeIssues.length >= workflowLimit) {
		blocking.push({
			gate: "concurrency",
			scope: "workflow",
			limit: workflowLimit,
			active: activeIssues.length,
		});
	}
	const kindLimit = manifest.concurrency.perKind?.[kind];
	const activeForKind = activeIssues.filter(
		(issue) => issue.workflow.kind === kind,
	).length;
	if (kindLimit !== undefined && activeForKind >= kindLimit) {
		blocking.push({
			gate: "concurrency",
			scope: "kind",
			kind,
			limit: kindLimit,
			active: activeForKind,
		});
	}
	return blocking;
}

export function isDone(
	issue: { workflow: WorkflowFields } | undefined,
): boolean {
	return issue?.workflow.state === "done";
}

export function specPostTicketGateIsOpen(
	issue: {
		workflow: WorkflowFields;
		relationships: { children: Array<string> };
	},
	byId: Map<string, { workflow: WorkflowFields }>,
): boolean {
	if (
		issue.workflow.kind !== "spec" ||
		issue.workflow.action !== "integration-test"
	) {
		return true;
	}
	return (
		issue.relationships.children.length > 0 &&
		issue.relationships.children.every((id) => isDone(byId.get(id)))
	);
}

export function compareReadyIssues(
	left: { id: string; title: string },
	right: { id: string; title: string },
): number {
	return (
		left.id.localeCompare(right.id, undefined, { numeric: true }) ||
		left.title.localeCompare(right.title) ||
		left.id.localeCompare(right.id)
	);
}

export function cleanWorkflowFields(
	workflow: WorkflowFields,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			kind: workflow.kind,
			state: workflow.state,
			action: workflow.action,
			reason: workflow.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
}

export function planApplicationTarget(
	manifest: WorkflowManifest,
	workflow: WorkflowFields,
): ManifestTransition["to"] | undefined {
	const direct = findTransition(manifest, workflow, "succeed");
	if (direct !== undefined) {
		return direct.to;
	}
	const started = findTransition(manifest, workflow, "start");
	if (started === undefined) {
		return undefined;
	}
	return findTransition(
		manifest,
		{ ...workflow, ...workflowTarget(started.to) },
		"succeed",
	)?.to;
}

export function findTransition(
	manifest: WorkflowManifest,
	workflow: WorkflowFields,
	event: string,
): ManifestTransition | undefined {
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === workflow.kind,
	);
	return kind?.transitions.find(
		(transition) =>
			transition.event === event && fieldsMatch(transition.from, workflow),
	);
}

export function fieldsMatch(
	from: ManifestTransition["from"],
	workflow: WorkflowFields,
): boolean {
	return (
		from.state === workflow.state &&
		from.action === workflow.action &&
		from.reason === workflow.reason
	);
}

export function invalidTransition(id: string, event: string): Envelope {
	return failure(
		"INVALID_TRANSITION",
		"No manifest transition matches the current workflow fields for this event.",
		{ id, event },
	);
}

export function lifecycleError(id: string, error: unknown): Envelope {
	if (error instanceof IssueNotFoundError) {
		return failure("NOT_FOUND", error.message, { id });
	}
	if (
		error instanceof NeedReconciliationError ||
		error instanceof ProjectionConflictError ||
		(error instanceof CorruptWorkflowProjectionError &&
			error.message.includes("NEED_RECONCILIATION"))
	) {
		return failure("NEED_RECONCILIATION", error.message, { id });
	}
	if (error instanceof CorruptWorkflowProjectionError) {
		return failure("CORRUPT_WORKFLOW_PROJECTION", error.message, { id });
	}
	throw error;
}

export function terminalLogType(event: "succeed" | "fail"): string {
	return event === "succeed" ? "action_succeeded" : "action_failed";
}

export function isTerminalLog(type: string): boolean {
	return type === "action_succeeded" || type === "action_failed";
}

export function terminalLogInputMatches(
	payload: JsonValue | undefined,
	input: JsonValue,
): boolean {
	if (!isRecord(payload) || payload.input === undefined) {
		return true;
	}
	return stableStringify(payload.input) === stableStringify(input);
}

export function initialWorkflowTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): { state: string; action: string; reason?: string } {
	return { ...workflowTarget(target), action: target.action ?? "none" };
}

export function workflowTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): { state: string; action?: string; reason?: string } {
	return {
		state: target.state,
		...(target.action === undefined ? {} : { action: target.action }),
		...(target.reason === undefined || target.reason === null
			? {}
			: { reason: target.reason }),
	};
}

export function cleanTransitionTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): Record<string, string | null> {
	return Object.fromEntries(
		Object.entries({
			state: target.state,
			action: target.action,
			reason: target.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string | null>;
}

export function cleanCurrentTarget(target: {
	state: string;
	action: string;
	reason?: string;
}): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			state: target.state,
			action: target.action,
			reason: target.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
}

export function defaultRetryTarget(workflow: {
	state: string;
	action: string;
}): { state: string; action: string } | undefined {
	if (workflow.state !== "running" || workflow.action === "none") {
		return undefined;
	}
	return { state: "ready", action: workflow.action };
}

export function retryPolicyAllows(
	manifest: WorkflowManifest,
	workflow: { kind: string; action: string },
): boolean {
	return targetPolicyAllows(
		manifest.lifecycle?.retry?.allow,
		workflow.kind,
		workflow.action,
	);
}

export function escalationPolicyAllows(
	manifest: WorkflowManifest,
	workflow: { kind: string; action: string },
): boolean {
	return targetPolicyAllows(
		manifest.lifecycle?.escalation?.allow,
		workflow.kind,
		workflow.action,
	);
}

export function targetPolicyAllows(
	allow: Array<{ kind: string; action: string }> | undefined,
	kind: string,
	action: string,
): boolean {
	return (
		allow === undefined ||
		allow.some((target) => target.kind === kind && target.action === action)
	);
}

export function resumePolicyAllows(
	manifest: WorkflowManifest,
	kind: string,
	action: string,
): boolean {
	const allow = manifest.lifecycle?.resume?.allow;
	return (
		allow === undefined ||
		allow.some(
			(target) => target.kind === kind && target.actions.includes(action),
		)
	);
}

export function isReadyAction(
	manifest: WorkflowManifest,
	kind: string,
	action: string,
): boolean {
	return manifest.kinds.some(
		(manifestKind) =>
			manifestKind.id === kind &&
			manifestKind.transitions.some(
				(transition) =>
					transition.from.state === "ready" &&
					transition.from.action === action,
			),
	);
}

export function policyViolation(
	id: string,
	policy: string,
	action: string,
): Envelope {
	return failure(
		"LIFECYCLE_POLICY_VIOLATION",
		"Lifecycle policy does not allow this transition.",
		{ id, policy, action },
	);
}

export function deriveRuns(
	activeRunId: string | undefined,
	logs: Array<{ type: string; runId?: string }>,
): {
	activeRunId?: string;
	attempts: Array<{ runId: string; status: string }>;
} {
	const attempts = new Map<string, { runId: string; status: string }>();
	for (const log of logs) {
		if (log.runId === undefined) {
			continue;
		}
		if (!attempts.has(log.runId)) {
			attempts.set(log.runId, { runId: log.runId, status: "unknown" });
		}
		const attempt = attempts.get(log.runId);
		if (attempt === undefined) {
			continue;
		}
		if (log.type === "action_started") {
			attempt.status = "running";
		}
		if (log.type === "action_succeeded") {
			attempt.status = "succeeded";
		}
		if (log.type === "action_failed") {
			attempt.status = "failed";
		}
	}
	if (activeRunId !== undefined && !attempts.has(activeRunId)) {
		attempts.set(activeRunId, { runId: activeRunId, status: "running" });
	}
	return { activeRunId, attempts: [...attempts.values()] };
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function unknownCommand(args: Array<string>): Envelope {
	return failure("UNKNOWN_COMMAND", "Unknown command.", {
		command: args.join(" "),
	});
}
