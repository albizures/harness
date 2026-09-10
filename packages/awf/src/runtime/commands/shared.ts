import { readFile } from "node:fs/promises";
import type { JsonValue } from "type-fest";
import {
	failure,
	success,
	type Envelope,
	type ErrorEnvelope,
	type FailureDefinition,
} from "../envelope.ts";
import { jsonValueSchema } from "../../shared/json.ts";
import type {
	ManifestCommand,
	PayloadZodSchema,
	ManifestNamedReadinessFilter,
	ManifestTransition,
	ManifestWorkflowFilter,
	WorkflowManifest,
} from "../../domain/manifest/schema.ts";
import { NeedReconciliationError, type Tracker } from "../../ports/tracker.ts";
import { IssueNotFoundError } from "../../domain/workflow/issue.ts";
import { runtimeFailures } from "../failures.ts";
import {
	CorruptWorkflowProjectionError,
	ProjectionConflictError,
} from "../../domain/workflow/projection.ts";
export type WorkflowFields = {
	kind: string;
	state: string;
	action?: string;
	reason?: string;
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
	verb: string,
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
		runtimeFailures.workflowCommandInputValidationFailed({
			...(command === undefined ? {} : { command: command.id }),
			issues: result.issues,
		}),
	);
}

export function validateWorkflowCommandInput(
	command: ManifestCommand | undefined,
	value: unknown,
): Envelope | undefined {
	const result = parseWorkflowCommandInput(command, value);
	return result.ok ? undefined : result;
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

export function parseJsonInput(
	raw: string,
	definition:
		| FailureDefinition<
				"INVALID_ACTION_INPUT" | "WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED"
		  >
		| string,
): JsonInputEnvelope {
	try {
		return { ok: true, data: JSON.parse(raw) as unknown };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof definition === "string") {
			return failure(definition, "Input must be valid JSON.", { message });
		}
		return failure(
			runtimeFailures.inputMustBeValidJson(definition, { message }),
		);
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
		await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id: parent.id },
					expect: {
						version: parent.workflow.version,
						hash: parent.workflow.hash,
					},
					workflow: workflowTarget(policy.to),
				},
			],
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

export function isWorkflowActive(
	workflow: WorkflowFields,
	manifest: WorkflowManifest,
): boolean {
	const activeStates = manifest.lifecycle?.activeStates;
	return (activeStates ?? ["running"]).includes(workflow.state);
}

export function isWorkflowTerminal(
	workflow: WorkflowFields,
	manifest: WorkflowManifest,
): boolean {
	return manifest.lifecycle?.terminalStates?.includes(workflow.state) ?? false;
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
				runtimeFailures.invalidReadyFilter({
					message: "Readiness filter is not declared by the manifest.",
					details: { filter: filter.name },
				}),
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
				runtimeFailures.invalidReadyFilter({
					message:
						"Readiness filter value does not resolve to a workflow issue.",
					details: { filter: filter.name, value: filter.value },
				}),
			);
		}
		if (issue.workflow.kind !== declaration.kind) {
			return failure(
				runtimeFailures.invalidReadyFilter({
					message: "Readiness filter value has the wrong workflow kind.",
					details: {
						filter: filter.name,
						value: filter.value,
						expectedKind: declaration.kind,
						actualKind: issue.workflow.kind,
					},
				}),
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

export function readyItem(
	issue: {
		id: string;
		title: string;
		workflow: WorkflowFields;
	},
	manifest?: WorkflowManifest,
) {
	return {
		id: issue.id,
		title: issue.title,
		workflow: cleanWorkflowFields(issue.workflow, manifest),
		suggestedCommand: {
			argv: ["run-command", "start", issue.id],
			display: `awf run-command start ${issue.id}`,
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
	const subkind = readWorkflowSubkind(workflow, manifest);
	const subkindLimit =
		subkind === undefined
			? undefined
			: manifest.concurrency.perSubkind?.[kind]?.[subkind];
	if (subkind !== undefined && subkindLimit !== undefined) {
		const activeForSubkind = activeIssues.filter(
			(issue) =>
				issue.workflow.kind === kind &&
				readWorkflowSubkind(issue.workflow, manifest) === subkind,
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

function readWorkflowSubkind(
	workflow: WorkflowFields,
	manifest?: WorkflowManifest,
): string | undefined {
	if (typeof workflow.data?.subkind === "string") {
		return workflow.data.subkind;
	}
	return manifest?.kinds.find((kind) => kind.id === workflow.kind)
		?.subkinds?.[0];
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
	manifest?: WorkflowManifest,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			kind: workflow.kind,
			state: workflow.state,
			action: workflow.action,
			reason: workflow.reason,
			subkind: readWorkflowSubkind(workflow, manifest),
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
		runtimeFailures.invalidTransition({
			message:
				"No manifest transition matches the current workflow fields for this event.",
			id,
			event,
		}),
	);
}

export function lifecycleError(id: string, error: unknown): Envelope {
	if (error instanceof IssueNotFoundError) {
		return failure(runtimeFailures.notFound({ message: error.message, id }));
	}
	if (
		error instanceof NeedReconciliationError ||
		error instanceof ProjectionConflictError ||
		(error instanceof CorruptWorkflowProjectionError &&
			error.message.includes("NEED_RECONCILIATION"))
	) {
		return failure(
			runtimeFailures.needReconciliation({
				message: error.message,
				details: { id },
			}),
		);
	}
	if (error instanceof CorruptWorkflowProjectionError) {
		return failure(
			runtimeFailures.corruptWorkflowProjection({
				message: error.message,
				details: { id },
			}),
		);
	}
	throw error;
}

export function terminalLogType(event: "succeed" | "fail"): string {
	return event === "succeed" ? "action_succeeded" : "action_failed";
}

export function isTerminalLog(type: string): boolean {
	return type === "action_succeeded" || type === "action_failed";
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
		runtimeFailures.lifecyclePolicyViolation({ id, policy, action }),
	);
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
	return failure(runtimeFailures.unknownCommand({ command: args.join(" ") }));
}
