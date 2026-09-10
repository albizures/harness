import { createHash } from "node:crypto";
import type { JsonValue } from "type-fest";
import { jsonRecordSchema } from "../../shared/json.ts";
import {
	NeedReconciliationError,
	type TrackerApplyWorkflowEffectsResult,
	type TrackerIssueInspection,
	type TrackerLog,
	type TrackerWorkflowEffect,
} from "../../ports/tracker.ts";
import {
	IssueNotFoundError,
	type CreateIssueInput,
	type IssueRelationships,
	type SeedIssueInput,
	type UpdateIssueInput,
	type WorkflowIssue,
} from "../../domain/workflow/issue.ts";
import {
	CorruptWorkflowProjectionError,
	ProjectionConflictError,
	type WorkflowProjection,
} from "../../domain/workflow/projection.ts";
import type { WorkflowLog } from "../../domain/workflow/log.ts";

export class WorkflowTrackerState {
	private readonly issues = new Map<string, StoredIssue>();
	private nextIssueNumber = 1;

	constructor(seed: Array<SeedIssueInput> = []) {
		for (const issue of seed) {
			this.storeSeed(issue);
		}
		this.backfillSeededRelationshipInverses();
	}

	static fromSnapshot(
		snapshot: WorkflowTrackerStateSnapshot,
	): WorkflowTrackerState {
		const state = new WorkflowTrackerState();
		state.nextIssueNumber = snapshot.nextIssueNumber;
		for (const issue of snapshot.issues) {
			state.issues.set(issue.id, cloneJson(issue) as StoredIssue);
		}
		return state;
	}

	snapshot(): WorkflowTrackerStateSnapshot {
		return {
			version: 1,
			nextIssueNumber: this.nextIssueNumber,
			issues: [...this.issues.values()].map(
				(issue) => cloneJson(issue) as StoredIssue,
			),
		};
	}

	createIssue(input: CreateIssueInput): WorkflowIssue {
		const id = input.id ?? String(this.nextIssueNumber++);
		if (this.issues.has(id)) {
			throw new CorruptWorkflowProjectionError(`Duplicate issue id '${id}'.`);
		}
		const stored = normalizeIssue({ ...input, id });
		this.issues.set(id, stored);
		return cloneIssue(stored);
	}

	getIssue(id: string): WorkflowIssue {
		return cloneIssue(this.requireHealthyIssue(id));
	}

	listIssues(): Array<WorkflowIssue> {
		return [...this.issues.values()].map((issue) =>
			cloneIssue(requireHealthy(issue)),
		);
	}

	inspectIssue(id: string): TrackerIssueInspection {
		const issue = this.requireIssue(id);
		return {
			...(issue.projectionError === undefined
				? { issue: cloneIssue(issue) }
				: {}),
			logs: cloneJson(issue.logs) as Array<unknown>,
			...(issue.labels === undefined ? {} : { labels: [...issue.labels] }),
			...(issue.projectionError === undefined
				? {}
				: { projectionError: issue.projectionError }),
		};
	}

	updateIssue(id: string, input: UpdateIssueInput): WorkflowIssue {
		const issue = this.requireHealthyIssue(id);
		if (
			input.expect?.version !== undefined &&
			input.expect.version !== issue.workflow.version
		) {
			throw new ProjectionConflictError();
		}
		if (
			input.expect?.hash !== undefined &&
			input.expect.hash !== issue.workflow.hash
		) {
			throw new ProjectionConflictError();
		}

		if (input.title !== undefined) {
			issue.title = input.title;
		}
		if (input.body !== undefined) {
			issue.body = input.body;
		}
		if (input.workflow !== undefined) {
			const next = cleanProjectionFields({
				...issue.workflow,
				...input.workflow,
				version: issue.workflow.version + 1,
			});
			validateWorkflowProjection(id, next);
			issue.workflow = withHash(next);
		}
		return cloneIssue(issue);
	}

	appendLog(id: string, input: TrackerLog): WorkflowLog {
		const issue = this.requireHealthyIssue(id);
		const log = cloneJson({
			type: input.type,
			...(input.message === undefined ? {} : { message: input.message }),
			issueId: id,
			sequence: issue.logs.length + 1,
		}) as WorkflowLog;
		issue.logs.push(log);
		return cloneJson(log) as WorkflowLog;
	}

	readLogs(id: string): Array<WorkflowLog> {
		return cloneJson(this.requireHealthyIssue(id).logs) as Array<WorkflowLog>;
	}

	addChild(parentId: string, childId: string): void {
		const parent = this.requireIssue(parentId);
		const child = this.requireIssue(childId);
		child.relationships.parent = parentId;
		pushUnique(parent.relationships.children, childId);
	}

	removeChild(parentId: string, childId: string): void {
		const parent = this.requireIssue(parentId);
		const child = this.requireIssue(childId);
		parent.relationships.children = parent.relationships.children.filter(
			(id) => id !== childId,
		);
		if (child.relationships.parent === parentId) {
			delete child.relationships.parent;
		}
	}

	addDependency(issueId: string, blockedById: string): void {
		const issue = this.requireIssue(issueId);
		const blocker = this.requireIssue(blockedById);
		pushUnique(issue.relationships.dependencies, blockedById);
		pushUnique(blocker.relationships.dependents, issueId);
	}

	removeDependency(issueId: string, blockedById: string): void {
		const issue = this.requireIssue(issueId);
		const blocker = this.requireIssue(blockedById);
		issue.relationships.dependencies = issue.relationships.dependencies.filter(
			(id) => id !== blockedById,
		);
		blocker.relationships.dependents = blocker.relationships.dependents.filter(
			(id) => id !== issueId,
		);
	}

	deleteIssue(id: string): void {
		const issue = this.requireIssue(id);
		if (issue.relationships.parent !== undefined) {
			this.removeChild(issue.relationships.parent, id);
		}
		for (const childId of [...issue.relationships.children]) {
			this.removeChild(id, childId);
		}
		for (const dependencyId of [...issue.relationships.dependencies]) {
			this.removeDependency(id, dependencyId);
		}
		for (const dependentId of [...issue.relationships.dependents]) {
			this.removeDependency(dependentId, id);
		}
		this.issues.delete(id);
	}

	verifyChild(parentId: string, childId: string, expected: boolean): void {
		const parent = this.requireHealthyIssue(parentId);
		const child = this.requireHealthyIssue(childId);
		const present =
			parent.relationships.children.includes(childId) &&
			child.relationships.parent === parentId;
		if (present !== expected) {
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: child relationship '${parentId}' -> '${childId}' could not be verified.`,
			);
		}
	}

	verifyDependency(
		issueId: string,
		blockedById: string,
		expected: boolean,
	): void {
		const issue = this.requireHealthyIssue(issueId);
		const blocker = this.requireHealthyIssue(blockedById);
		const present =
			issue.relationships.dependencies.includes(blockedById) &&
			blocker.relationships.dependents.includes(issueId);
		if (present !== expected) {
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: dependency relationship '${issueId}' -> '${blockedById}' could not be verified.`,
			);
		}
	}

	verifyWorkflowEffects(
		result: TrackerApplyWorkflowEffectsResult,
		_effects: Array<TrackerWorkflowEffect>,
	): void {
		for (const created of result.createdIssues) {
			this.getIssue(created.id);
		}
		for (const log of result.logs) {
			if (
				!this.readLogs(log.issueId).some(
					(stored) =>
						stored.sequence === log.sequence && stored.type === log.type,
				)
			) {
				throw new NeedReconciliationError(
					"NEED_RECONCILIATION: workflow log addition could not be verified.",
				);
			}
		}
	}

	private storeSeed(input: SeedIssueInput): void {
		const projected = "labels" in input ? tryFromLabels(input) : { input };
		const seeded = projected.input;
		if (seeded.id === undefined) {
			throw new CorruptWorkflowProjectionError(
				"Seeded issues must have an id.",
			);
		}
		const normalized = normalizeIssue({ ...seeded, id: seeded.id });
		if ("labels" in input) {
			normalized.labels = [...input.labels];
		}
		if (projected.error !== undefined) {
			normalized.projectionError = projected.error;
		}
		if (this.issues.has(normalized.id)) {
			throw new CorruptWorkflowProjectionError(
				`Duplicate issue id '${normalized.id}'.`,
			);
		}
		this.issues.set(normalized.id, normalized);
		const numeric = Number(normalized.id);
		if (Number.isInteger(numeric) && numeric >= this.nextIssueNumber) {
			this.nextIssueNumber = numeric + 1;
		}
	}

	private requireIssue(id: string): StoredIssue {
		const issue = this.issues.get(id);
		if (issue === undefined) {
			throw new IssueNotFoundError(id);
		}
		return issue;
	}

	private requireHealthyIssue(id: string): StoredIssue {
		return requireHealthy(this.requireIssue(id));
	}

	private backfillSeededRelationshipInverses(): void {
		for (const issue of this.issues.values()) {
			if (issue.relationships.parent !== undefined) {
				pushUnique(
					this.requireIssue(issue.relationships.parent).relationships.children,
					issue.id,
				);
			}
			for (const childId of issue.relationships.children) {
				this.requireIssue(childId).relationships.parent = issue.id;
			}
			for (const dependencyId of issue.relationships.dependencies) {
				pushUnique(
					this.requireIssue(dependencyId).relationships.dependents,
					issue.id,
				);
			}
			for (const dependentId of issue.relationships.dependents) {
				pushUnique(
					this.requireIssue(dependentId).relationships.dependencies,
					issue.id,
				);
			}
		}
	}
}

export type WorkflowTrackerStateSnapshot = {
	version: 1;
	nextIssueNumber: number;
	issues: Array<StoredIssue>;
};

type StoredIssue = Omit<WorkflowIssue, "workflow"> & {
	workflow: WorkflowProjection;
	logs: Array<unknown>;
	labels?: Array<string>;
	projectionError?: string;
};

function tryFromLabels(
	input: Extract<SeedIssueInput, { labels: Array<string> }>,
): { input: CreateIssueInput; error?: string } {
	try {
		return { input: fromLabels(input) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("malformed label projection data")) {
			throw error;
		}
		return {
			input: {
				id: input.id,
				title: input.title,
				body: input.body,
				workflow: {
					kind: "corrupt",
					state: "corrupt",
					action: "none",
					version: input.version,
				},
				relationships: input.relationships,
			},
			error: message,
		};
	}
}

function fromLabels(
	input: Extract<SeedIssueInput, { labels: Array<string> }>,
): CreateIssueInput {
	if (
		!Array.isArray(input.labels) ||
		input.labels.some((label) => typeof label !== "string")
	) {
		throw new CorruptWorkflowProjectionError(
			`Issue '${input.id}' has malformed label projection data.`,
		);
	}
	const fields = {
		kind: readSingleLabel(input.labels, "kind", input.id),
		state: readSingleLabel(input.labels, "state", input.id),
		action: readSingleLabel(input.labels, "action", input.id),
	};
	return {
		id: input.id,
		title: input.title,
		body: input.body,
		workflow: { ...fields, version: input.version },
		relationships: input.relationships,
	};
}

function readSingleLabel(
	labels: Array<string>,
	prefix: string,
	id: string,
): string {
	const values = workflowLabelValues(labels, prefix);
	if (values.length !== 1 || values[0] === "") {
		throw new CorruptWorkflowProjectionError(
			`Issue '${id}' has corrupt ${prefix} projection data.`,
		);
	}
	return values[0];
}

function workflowLabelValues(
	labels: Array<string>,
	field: string,
): Array<string> {
	const canonical = new RegExp(`^awf:[^:]+:${field}:(.*)$`, "u");
	const values = labels
		.map((label) => canonical.exec(label)?.[1])
		.filter((value): value is string => value !== undefined);
	if (values.length > 0) {
		return values;
	}
	const legacyField = field === "kind" ? "type" : field;
	return labels
		.filter((label) => label.startsWith(`${legacyField}:`))
		.map((label) => label.slice(legacyField.length + 1));
}

function normalizeIssue(input: CreateIssueInput & { id: string }): StoredIssue {
	validateWorkflowProjection(input.id, input.workflow);
	return {
		id: input.id,
		title: input.title,
		...(input.body === undefined ? {} : { body: input.body }),
		workflow: withHash(
			cleanProjectionFields({
				...input.workflow,
				version: input.workflow.version ?? 1,
			}),
		),
		relationships: normalizeRelationships(input.relationships),
		logs: (input.logs ?? []).map((log, index) => ({
			type: log.type,
			...(log.message === undefined ? {} : { message: log.message }),
			issueId: input.id,
			sequence: log.sequence ?? index + 1,
		})),
	};
}

function normalizeRelationships(
	relationships: Partial<IssueRelationships> | undefined,
): IssueRelationships {
	return {
		...(relationships?.parent === undefined
			? {}
			: { parent: relationships.parent }),
		children: [...(relationships?.children ?? [])],
		dependencies: [...(relationships?.dependencies ?? [])],
		dependents: [...(relationships?.dependents ?? [])],
		...(relationships?.generatedBy === undefined
			? {}
			: { generatedBy: relationships.generatedBy }),
	};
}

function cleanProjectionFields(
	projection: Omit<WorkflowProjection, "hash">,
): Omit<WorkflowProjection, "hash"> {
	return {
		kind: projection.kind,
		state: projection.state,
		action: projection.action,
		...(projection.data === undefined ? {} : { data: projection.data }),
		...(projection.semanticVersion === undefined
			? {}
			: { semanticVersion: projection.semanticVersion }),
		version: projection.version,
	};
}

function validateWorkflowProjection(
	id: string,
	projection: CreateIssueInput["workflow"],
): void {
	for (const field of ["kind", "state", "action"] as const) {
		if (typeof projection[field] !== "string" || projection[field] === "") {
			throw new CorruptWorkflowProjectionError(
				`Issue '${id}' has malformed ${field} projection data.`,
			);
		}
	}
	if (
		projection.semanticVersion !== undefined &&
		projection.semanticVersion === ""
	) {
		throw new CorruptWorkflowProjectionError(
			`Issue '${id}' has malformed workflow semantic version projection data.`,
		);
	}
	if (
		projection.data !== undefined &&
		!jsonRecordSchema.safeParse(projection.data).success
	) {
		throw new CorruptWorkflowProjectionError(
			`Issue '${id}' has malformed workflow data.`,
		);
	}
}

function withHash(
	projection: Omit<WorkflowProjection, "hash"> | WorkflowProjection,
): WorkflowProjection {
	const { hash: _hash, ...withoutHash } = projection as WorkflowProjection;
	return { ...withoutHash, hash: hashProjection(withoutHash) };
}

function hashProjection(projection: Omit<WorkflowProjection, "hash">): string {
	return createHash("sha256").update(stableStringify(projection)).digest("hex");
}

function stableStringify(value: unknown): string {
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

function cloneIssue(issue: StoredIssue): WorkflowIssue {
	const {
		logs: _logs,
		labels: _labels,
		projectionError: _projectionError,
		...withoutLogs
	} = issue;
	return cloneJson(withoutLogs) as WorkflowIssue;
}

function requireHealthy(issue: StoredIssue): StoredIssue {
	if (issue.projectionError !== undefined) {
		throw new CorruptWorkflowProjectionError(issue.projectionError);
	}
	return issue;
}

function cloneJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

export function asObject(
	value: JsonValue | undefined,
): Record<string, JsonValue> {
	const parsed = jsonRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}

function pushUnique(values: Array<string>, value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}
