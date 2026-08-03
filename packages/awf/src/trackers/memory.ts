import { createHash } from "node:crypto";
import type { JsonValue } from "type-fest";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	NeedReconciliationError,
	ProjectionConflictError,
	type CreateIssueInput,
	type IssueRelationships,
	type SeedIssueInput,
	type TrackerAdapter,
	type TrackerApplyPlanIntent,
	type TrackerApplyPlanResult,
	type TrackerCompleteRunIntent,
	type TrackerCreateWorkflowIssueIntent,
	type TrackerEscalateIntent,
	type TrackerIssueInspection,
	type TrackerRecordArtifactsIntent,
	type TrackerRecordArtifactsResult,
	type TrackerRecordCommandIntent,
	type TrackerRelationshipIntent,
	type TrackerAdvanceWorkflowIntent,
	type TrackerRepairIssueIntent,
	type TrackerResumeIntent,
	type TrackerStartRunIntent,
	type UpdateIssueInput,
	type WorkflowArtifact,
	type WorkflowArtifactInput,
	normalizeWorkflowArtifactInput,
	type WorkflowChange,
	type WorkflowIssue,
	type WorkflowLog,
	type WorkflowProjection,
} from "../tracker.ts";

export function createInMemoryTracker(
	seed: { issues?: Array<SeedIssueInput> } = {},
): TrackerAdapter {
	return new InMemoryTracker(seed.issues ?? []);
}

export function createInMemoryTrackerFromEnvironment(
	env: Record<string, string | undefined>,
): TrackerAdapter {
	const rawIssues = env.AWF_MEMORY_ISSUES;
	if (rawIssues === undefined || rawIssues === "") {
		return createInMemoryTracker();
	}
	const parsed = JSON.parse(rawIssues) as unknown;
	if (!Array.isArray(parsed)) {
		throw new CorruptWorkflowProjectionError(
			"AWF_MEMORY_ISSUES must be a JSON array.",
		);
	}
	return createInMemoryTracker({ issues: parsed as Array<SeedIssueInput> });
}

class InMemoryTracker implements TrackerAdapter {
	private readonly issues = new Map<string, StoredIssue>();
	private nextIssueNumber = 1;

	constructor(seed: Array<SeedIssueInput>) {
		for (const issue of seed) {
			this.storeSeed(issue);
		}
		this.backfillSeededRelationshipInverses();
	}

	async createWorkflowIssue(
		input: TrackerCreateWorkflowIssueIntent,
	): Promise<{ issue: WorkflowIssue; log?: WorkflowLog }> {
		const issue = await this.createIssue(input);
		const log =
			input.initialLog === undefined
				? undefined
				: await this.appendLog(issue.id, input.initialLog);
		return {
			issue: log === undefined ? issue : await this.getIssue(issue.id),
			log,
		};
	}

	async startRun(
		id: string,
		input: TrackerStartRunIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const issue = await this.updateIssue(id, {
			expect: input.expect,
			workflow: { ...input.workflow, activeRunId: input.runId },
		});
		const log = await this.appendLog(id, input.log);
		return { issue, log };
	}

	async completeRun(
		id: string,
		input: TrackerCompleteRunIntent,
	): Promise<TrackerRecordArtifactsResult> {
		await this.updateIssue(id, {
			expect: input.expect,
			workflow: { ...input.workflow, activeRunId: undefined },
		});
		return this.recordArtifacts(id, input);
	}

	async recordArtifacts(
		id: string,
		input: TrackerRecordArtifactsIntent,
	): Promise<TrackerRecordArtifactsResult> {
		const artifacts = [];
		for (const artifact of input.artifacts ?? []) {
			artifacts.push(await this.registerArtifact(id, artifact));
		}
		const changes = [];
		for (const change of input.changes ?? []) {
			changes.push(await this.registerChange(id, change));
		}
		const log = await this.appendLog(id, input.log);
		return {
			issue: await this.getIssue(id),
			log,
			artifacts,
			changes,
		};
	}

	async escalateWorkflow(
		id: string,
		input: TrackerEscalateIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const issue = await this.updateIssue(id, {
			expect: input.expect,
			workflow: input.workflow,
		});
		const log = await this.appendLog(id, input.log);
		return { issue, log };
	}

	async resumeWorkflow(
		id: string,
		input: TrackerResumeIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const issue = await this.updateIssue(id, {
			expect: input.expect,
			workflow: input.workflow,
		});
		const log = await this.appendLog(id, input.log);
		return { issue, log };
	}

	async recordCommand(
		id: string,
		input: TrackerRecordCommandIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const log = await this.appendLog(id, input.log);
		return { issue: await this.getIssue(id), log };
	}

	async advanceWorkflow(
		id: string,
		input: TrackerAdvanceWorkflowIntent,
	): Promise<WorkflowIssue> {
		return this.updateIssue(id, input);
	}

	async repairIssue(
		id: string,
		input: TrackerRepairIssueIntent,
	): Promise<WorkflowIssue> {
		return this.updateIssue(id, input);
	}

	async changeRelationship(input: TrackerRelationshipIntent): Promise<void> {
		if (input.type === "add-child") {
			await this.addChild(input.parentId, input.childId);
			this.verifyChild(input.parentId, input.childId, true);
		} else if (input.type === "remove-child") {
			await this.removeChild(input.parentId, input.childId);
			this.verifyChild(input.parentId, input.childId, false);
		} else if (input.type === "add-dependency") {
			await this.addDependency(input.issueId, input.blockedById);
			this.verifyDependency(input.issueId, input.blockedById, true);
		} else {
			await this.removeDependency(input.issueId, input.blockedById);
			this.verifyDependency(input.issueId, input.blockedById, false);
		}
	}

	async applyPlan(
		input: TrackerApplyPlanIntent,
	): Promise<TrackerApplyPlanResult> {
		const created: Array<{ key: string; id: string }> = [];
		try {
			for (const ticket of input.tickets) {
				const issue = await this.createIssue({
					title: ticket.title,
					body: ticket.body,
					workflow: ticket.workflow,
				});
				created.push({ key: ticket.key, id: issue.id });
				await this.changeRelationship({
					type: "add-child",
					parentId: input.specId,
					childId: issue.id,
				});
			}
			const idsByKey = new Map(
				created.map((ticket) => [ticket.key, ticket.id]),
			);
			for (const ticket of input.tickets) {
				const issueId = idsByKey.get(ticket.key);
				if (issueId === undefined) {
					throw new NeedReconciliationError(
						"NEED_RECONCILIATION: plan ticket creation could not be verified.",
					);
				}
				for (const dependencyKey of ticket.dependsOn ?? []) {
					const blockedById = idsByKey.get(dependencyKey);
					if (blockedById === undefined) {
						throw new NeedReconciliationError(
							"NEED_RECONCILIATION: plan dependency resolution failed.",
						);
					}
					await this.changeRelationship({
						type: "add-dependency",
						issueId,
						blockedById,
					});
				}
			}
			await this.updateIssue(input.specId, {
				expect: input.expect,
				workflow: input.specWorkflow,
			});
			const artifacts = [];
			for (const artifact of input.artifacts ?? []) {
				artifacts.push(await this.registerArtifact(input.specId, artifact));
			}
			const log = await this.appendLog(input.specId, {
				...input.log,
				payload: {
					...asObject(input.log.payload),
					tickets: created,
					artifacts,
				},
			});
			await this.verifyPlanApplication(input.specId, created, input.tickets);
			return {
				spec: await this.getIssue(input.specId),
				tickets: created,
				artifacts,
				log,
			};
		} catch (error) {
			if (
				error instanceof NeedReconciliationError ||
				error instanceof ProjectionConflictError
			) {
				throw error;
			}
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: plan application intent failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async createIssue(input: CreateIssueInput): Promise<WorkflowIssue> {
		const id = input.id ?? String(this.nextIssueNumber++);
		if (this.issues.has(id)) {
			throw new CorruptWorkflowProjectionError(`Duplicate issue id '${id}'.`);
		}
		const stored = normalizeIssue({ ...input, id });
		this.issues.set(id, stored);
		return cloneIssue(stored);
	}

	async getIssue(id: string): Promise<WorkflowIssue> {
		return cloneIssue(this.requireHealthyIssue(id));
	}

	async listIssues(): Promise<Array<WorkflowIssue>> {
		return [...this.issues.values()].map((issue) =>
			cloneIssue(requireHealthy(issue)),
		);
	}

	async inspectIssue(id: string): Promise<TrackerIssueInspection> {
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

	async updateIssue(
		id: string,
		input: UpdateIssueInput,
	): Promise<WorkflowIssue> {
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
			const next = {
				...issue.workflow,
				...input.workflow,
				version: issue.workflow.version + 1,
			};
			validateWorkflowProjection(id, next);
			issue.workflow = withHash(next);
		}
		return cloneIssue(issue);
	}

	async appendLog(
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	): Promise<WorkflowLog> {
		const issue = this.requireHealthyIssue(id);
		const log = cloneJson({
			...input,
			issueId: id,
			sequence: issue.logs.length + 1,
		}) as WorkflowLog;
		issue.logs.push(log);
		return cloneJson(log) as WorkflowLog;
	}

	async readLogs(id: string): Promise<Array<WorkflowLog>> {
		return cloneJson(this.requireHealthyIssue(id).logs) as Array<WorkflowLog>;
	}

	async addChild(parentId: string, childId: string): Promise<void> {
		const parent = this.requireIssue(parentId);
		const child = this.requireIssue(childId);
		child.relationships.parent = parentId;
		pushUnique(parent.relationships.children, childId);
	}

	async removeChild(parentId: string, childId: string): Promise<void> {
		const parent = this.requireIssue(parentId);
		const child = this.requireIssue(childId);
		parent.relationships.children = parent.relationships.children.filter(
			(id) => id !== childId,
		);
		if (child.relationships.parent === parentId) {
			delete child.relationships.parent;
		}
	}

	async addDependency(issueId: string, blockedById: string): Promise<void> {
		const issue = this.requireIssue(issueId);
		const blocker = this.requireIssue(blockedById);
		pushUnique(issue.relationships.dependencies, blockedById);
		pushUnique(blocker.relationships.dependents, issueId);
	}

	async removeDependency(issueId: string, blockedById: string): Promise<void> {
		const issue = this.requireIssue(issueId);
		const blocker = this.requireIssue(blockedById);
		issue.relationships.dependencies = issue.relationships.dependencies.filter(
			(id) => id !== blockedById,
		);
		blocker.relationships.dependents = blocker.relationships.dependents.filter(
			(id) => id !== issueId,
		);
	}

	async deleteIssue(id: string): Promise<void> {
		const issue = this.requireIssue(id);
		if (issue.relationships.parent !== undefined) {
			await this.removeChild(issue.relationships.parent, id);
		}
		for (const childId of [...issue.relationships.children]) {
			await this.removeChild(id, childId);
		}
		for (const dependencyId of [...issue.relationships.dependencies]) {
			await this.removeDependency(id, dependencyId);
		}
		for (const dependentId of [...issue.relationships.dependents]) {
			await this.removeDependency(dependentId, id);
		}
		this.issues.delete(id);
	}

	async registerArtifact(
		issueId: string,
		input: WorkflowArtifactInput,
	): Promise<WorkflowArtifact> {
		const issue = this.requireIssue(issueId);
		const artifact = normalizeWorkflowArtifactInput(
			input,
			input.id ?? `artifact-${issue.artifacts.length + 1}`,
		);
		issue.artifacts.push(artifact);
		return cloneJson(artifact) as WorkflowArtifact;
	}

	async registerChange(
		issueId: string,
		input: Omit<WorkflowChange, "id">,
	): Promise<WorkflowChange> {
		const issue = this.requireIssue(issueId);
		const change = { id: `change-${issue.changes.length + 1}`, ...input };
		issue.changes.push(change);
		return cloneJson(change) as WorkflowChange;
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

	private verifyChild(
		parentId: string,
		childId: string,
		expected: boolean,
	): void {
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

	private verifyDependency(
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

	private async verifyPlanApplication(
		specId: string,
		created: Array<{ key: string; id: string }>,
		tickets: TrackerApplyPlanIntent["tickets"],
	): Promise<void> {
		const spec = await this.getIssue(specId);
		for (const ticket of created) {
			if (!spec.relationships.children.includes(ticket.id)) {
				throw new NeedReconciliationError(
					"NEED_RECONCILIATION: plan child relationships could not be verified.",
				);
			}
		}
		const idsByKey = new Map(created.map((ticket) => [ticket.key, ticket.id]));
		for (const ticket of tickets) {
			const issueId = idsByKey.get(ticket.key);
			if (issueId === undefined) {
				throw new NeedReconciliationError(
					"NEED_RECONCILIATION: plan ticket creation could not be verified.",
				);
			}
			const issue = await this.getIssue(issueId);
			for (const dependencyKey of ticket.dependsOn ?? []) {
				const blockedById = idsByKey.get(dependencyKey);
				if (
					blockedById === undefined ||
					!issue.relationships.dependencies.includes(blockedById)
				) {
					throw new NeedReconciliationError(
						"NEED_RECONCILIATION: plan dependency relationships could not be verified.",
					);
				}
			}
		}
	}
}

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
					state: "need-human",
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
		reason: readOptionalSingleLabel(input.labels, "reason", input.id),
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

function readOptionalSingleLabel(
	labels: Array<string>,
	prefix: string,
	id: string,
): string | undefined {
	const values = workflowLabelValues(labels, prefix);
	if (values.length > 1 || values.some((value) => value === "")) {
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
		workflow: withHash({
			...input.workflow,
			version: input.workflow.version ?? 1,
		}),
		relationships: normalizeRelationships(input.relationships),
		artifacts: [],
		changes: [],
		logs: (input.logs ?? []).map((log, index) => ({
			...log,
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
	if (projection.reason !== undefined && projection.reason === "") {
		throw new CorruptWorkflowProjectionError(
			`Issue '${id}' has malformed reason projection data.`,
		);
	}
	if (projection.activeRunId !== undefined && projection.activeRunId === "") {
		throw new CorruptWorkflowProjectionError(
			`Issue '${id}' has malformed active run projection data.`,
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

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, JsonValue>;
	}
	return {};
}

function pushUnique(values: Array<string>, value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}
