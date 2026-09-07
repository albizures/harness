import { readFile } from "node:fs/promises";
import type { JsonValue } from "type-fest";
import {
	failure,
	success,
	type Envelope,
	type ErrorEnvelope,
} from "../envelope.ts";
import { jsonRecordSchema, jsonValueSchema } from "../json.ts";
import type {
	ManifestCommand,
	PayloadZodSchema,
	ManifestNamedReadinessFilter,
	ManifestTransition,
	ManifestWorkflowFilter,
	WorkflowManifest,
} from "../manifest/manifest.ts";
import {
	type ArtifactKind,
	artifacts as artifactSchemas,
} from "../workflow/artifact.ts";
import { NeedReconciliationError, type Tracker } from "../tracker.ts";
import { IssueNotFoundError } from "../workflow/issue.ts";
import {
	CorruptWorkflowProjectionError,
	ProjectionConflictError,
} from "../workflow/projection.ts";
export type WorkflowFields = {
	kind: string;
	state: string;
	action?: string;
	reason?: string;
	activeRunId?: string;
	data?: Record<string, JsonValue>;
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

export function parseWorkflowCommandInput(
	command: ManifestCommand | undefined,
	value: unknown,
): Envelope<JsonValue> {
	const result = parsePayloadValue(value, command?.input, "$input");
	const jsonValue = jsonValueSchema.safeParse(result.value);
	if (result.issues.length === 0 && jsonValue.success) {
		return success(jsonValue.data);
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

export function validateWorkflowCommandInput(
	command: ManifestCommand | undefined,
	value: unknown,
): Envelope | undefined {
	const result = parseWorkflowCommandInput(command, value);
	return result.ok ? undefined : result;
}

export function validateWorkflowCommandOutput(
	command: ManifestCommand | undefined,
	value: unknown,
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

export type JsonInputEnvelope = { ok: true; data: unknown } | ErrorEnvelope;

export function parseJsonInput(raw: string, code: string): JsonInputEnvelope {
	try {
		return { ok: true, data: JSON.parse(raw) as unknown };
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
	const schemaResult = schema?.safeParse(value);
	if (schemaResult?.success === false) {
		return {
			value,
			issues: schemaResult.error.issues.map((issue) => ({
				path: formatPayloadPath(path, issue.path),
				message: issue.message,
			})),
		};
	}
	const parsedValue = schemaResult?.data ?? value;
	const jsonResult = jsonValueSchema.safeParse(parsedValue);
	if (jsonResult.success) {
		return { value: jsonResult.data, issues: [] };
	}
	return {
		value: parsedValue,
		issues: jsonResult.error.issues.map((issue) => ({
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

export type StructuredArtifactInput = {
	kind: ArtifactKind;
	uri: string;
	name: string;
} & Record<string, JsonValue>;

export function structuredArtifactInput(
	value: unknown,
	kind: ArtifactKind,
	name: string,
): StructuredArtifactInput | undefined {
	return parseStructuredArtifactInput(value, kind, name, "$input").value;
}

export function parseStructuredArtifactInput(
	value: unknown,
	kind: ArtifactKind,
	name: string,
	path: string,
): { value?: StructuredArtifactInput; issue?: RuntimeValidationIssue } {
	if (value === undefined) {
		return {};
	}
	const schemaResult = artifactSchema(kind).safeParse(value);
	if (!schemaResult.success) {
		const issue = schemaResult.error.issues[0];
		return {
			issue: {
				path: issue === undefined ? path : formatPayloadPath(path, issue.path),
				message: issue?.message ?? "Invalid artifact reference.",
			},
		};
	}
	const jsonResult = jsonRecordSchema.safeParse(schemaResult.data);
	if (!jsonResult.success) {
		const issue = jsonResult.error.issues[0];
		return {
			issue: {
				path: issue === undefined ? path : formatPayloadPath(path, issue.path),
				message:
					issue?.message ?? "Artifact reference must be JSON-compatible.",
			},
		};
	}
	const data = jsonResult.data;
	const uri = artifactReferenceUri(data);
	if (uri === undefined) {
		return {
			issue: { path, message: "Artifact reference must include a URI field." },
		};
	}
	return {
		value: {
			...data,
			kind,
			uri,
			name,
		},
	};
}

function artifactSchema(kind: ArtifactKind): PayloadZodSchema {
	switch (kind) {
		case "url":
			return artifactSchemas.url();
		case "file":
			return artifactSchemas.file();
		case "issue":
			return artifactSchemas.issue();
		case "pull-request":
			return artifactSchemas.pullRequest();
		case "git-ref":
			return artifactSchemas.gitRef();
		case "markdown":
			return artifactSchemas.markdown();
		case "inline":
			return artifactSchemas.inline();
		case "handoff":
			return artifactSchemas.handoff();
		case "finding":
			return artifactSchemas.finding();
	}
}

export function artifactReferenceUri(
	value: Record<string, unknown>,
): string | undefined {
	for (const field of ["url", "path", "ref", "id"] as const) {
		const candidate = value[field];
		if (typeof candidate === "string") {
			return candidate;
		}
	}
	return undefined;
}

export async function progressRelationshipsAfterLifecycleTransition(
	tracker: Tracker,
	manifest: WorkflowManifest,
	previous: Awaited<ReturnType<Tracker["getIssue"]>>,
	updated: Awaited<ReturnType<Tracker["getIssue"]>>,
): Promise<void> {
	for (const policy of manifest.lifecycle?.relationshipPolicies ?? []) {
		if (
			policy.relationship !== "parent" ||
			previous.relationships.parent === undefined ||
			!workflowMatchesFilter(updated.workflow, policy.child)
		) {
			continue;
		}
		const parent = await tracker.getIssue(previous.relationships.parent);
		if (
			!workflowMatchesFilter(parent.workflow, policy.parent) ||
			!childrenSatisfyPolicy(
				parent.relationships.children,
				policy.siblings,
				await Promise.all(
					parent.relationships.children.map((childId) =>
						tracker.getIssue(childId),
					),
				),
			)
		) {
			continue;
		}
		await tracker.advanceWorkflow(parent.id, {
			expect: { version: parent.workflow.version, hash: parent.workflow.hash },
			workflow: workflowTarget(policy.to),
		});
	}
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
		relationships: { dependencies: Array<string>; children: Array<string> };
	},
	byId: Map<string, { id: string; title: string; workflow: WorkflowFields }>,
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	return [
		...dependencyBlocking(issue, byId),
		...relationshipReadinessBlocking(issue, byId, manifest),
		...concurrencyBlocking(issue.workflow, manifest, activeIssues),
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
	workflow: WorkflowFields,
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): Array<Record<string, JsonValue>> {
	const blocking: Array<Record<string, JsonValue>> = [];
	const { kind } = workflow;
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
	const subkind = readWorkflowSubkind(workflow);
	const subkindLimit =
		subkind === undefined
			? undefined
			: manifest.concurrency.perSubkind?.[kind]?.[subkind];
	if (subkind !== undefined && subkindLimit !== undefined) {
		const activeForSubkind = activeIssues.filter(
			(issue) =>
				issue.workflow.kind === kind &&
				readWorkflowSubkind(issue.workflow) === subkind,
		).length;
		if (activeForSubkind >= subkindLimit) {
			blocking.push({
				gate: "concurrency",
				scope: "subkind",
				kind,
				subkind,
				limit: subkindLimit,
				active: activeForSubkind,
			});
		}
	}
	return blocking;
}

function readWorkflowSubkind(workflow: WorkflowFields): string | undefined {
	return typeof workflow.data?.subkind === "string"
		? workflow.data.subkind
		: undefined;
}

export function isDone(
	issue: { workflow: WorkflowFields } | undefined,
): boolean {
	return issue?.workflow.state === "done";
}

export function relationshipReadinessBlocking(
	issue: {
		workflow: WorkflowFields;
		relationships: { children: Array<string> };
	},
	byId: Map<string, { id: string; title: string; workflow: WorkflowFields }>,
	manifest: WorkflowManifest,
): Array<Record<string, JsonValue>> {
	const blocking: Array<Record<string, JsonValue>> = [];
	for (const policy of manifest.readiness?.relationshipPolicies ?? []) {
		if (
			policy.relationship !== "children" ||
			!workflowMatchesFilter(issue.workflow, policy.where)
		) {
			continue;
		}
		const children = issue.relationships.children.map((id) => byId.get(id));
		const minimum = policy.children.min ?? 0;
		const missing = issue.relationships.children.filter(
			(_id, index) => children[index] === undefined,
		);
		const unmatched = children.flatMap((child) =>
			child !== undefined &&
			!workflowMatchesFilter(child.workflow, policy.children.all)
				? [child]
				: [],
		);
		if (
			children.length >= minimum &&
			missing.length === 0 &&
			unmatched.length === 0
		) {
			continue;
		}
		blocking.push({
			gate: policy.gate ?? "relationship",
			relationship: "children",
			...(minimum === 0 ? {} : { minimum }),
			...(missing.length === 0 ? {} : { missing }),
			...(unmatched.length === 0
				? {}
				: {
						blockedBy: unmatched.map((child) => ({
							id: child.id,
							title: child.title,
							workflow: cleanWorkflowFields(child.workflow),
						})),
					}),
		});
	}
	return blocking;
}

function childrenSatisfyPolicy(
	childIds: Array<string>,
	policy: { all: ManifestWorkflowFilter; min?: number },
	children: Array<{ workflow: WorkflowFields }>,
): boolean {
	return (
		childIds.length >= (policy.min ?? 0) &&
		children.length === childIds.length &&
		children.every((child) => workflowMatchesFilter(child.workflow, policy.all))
	);
}

export function workflowMatchesFilter(
	workflow: WorkflowFields,
	filter: ManifestWorkflowFilter,
): boolean {
	return (
		fieldMatches(filter.kind, workflow.kind) &&
		fieldMatches(filter.state, workflow.state) &&
		fieldMatches(filter.action, workflow.action) &&
		fieldMatches(filter.reason, workflow.reason)
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
			subkind: readWorkflowSubkind(workflow),
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
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
		if (log.type === "human_input_needed") {
			attempt.status = "paused";
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
