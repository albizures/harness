import { createHash } from "node:crypto";
import type { JsonValue } from "type-fest";
import type { ArtifactKind } from "./manifest.ts";

export type WorkflowProjection = {
	kind: string;
	state: string;
	action: string;
	reason?: string;
	activeRunId?: string;
	version: number;
	hash: string;
};

export type IssueRelationships = {
	parent?: string;
	children: Array<string>;
	dependencies: Array<string>;
	dependents: Array<string>;
};

export type WorkflowArtifact = {
	id: string;
	kind: ArtifactKind;
	uri: string;
	name?: string;
};

export type WorkflowChange = {
	id: string;
	kind: ArtifactKind;
	uri: string;
	summary?: string;
};

export type WorkflowIssue = {
	id: string;
	title: string;
	body?: string;
	workflow: WorkflowProjection;
	relationships: IssueRelationships;
	artifacts: Array<WorkflowArtifact>;
	changes: Array<WorkflowChange>;
};

export type WorkflowLog = {
	sequence: number;
	issueId: string;
	type: string;
	runId?: string;
	payload?: JsonValue;
};

export type CreateIssueInput = {
	id?: string;
	title: string;
	body?: string;
	workflow: Omit<WorkflowProjection, "version" | "hash"> & { version?: number };
	relationships?: Partial<IssueRelationships>;
	logs?: Array<Omit<WorkflowLog, "issueId">>;
};

export type SeedIssueInput =
	| CreateIssueInput
	| {
			id: string;
			title: string;
			body?: string;
			labels: Array<string>;
			relationships?: Partial<IssueRelationships>;
			version?: number;
	  };

export type UpdateIssueInput = {
	expect?: { version?: number; hash?: string };
	title?: string;
	body?: string;
	workflow?: Partial<Omit<WorkflowProjection, "version" | "hash">>;
};

export type TrackerProjectionExpectation = NonNullable<
	UpdateIssueInput["expect"]
>;

export type TrackerCreateWorkflowIssueIntent = CreateIssueInput & {
	initialLog?: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerStartRunIntent = {
	expect: TrackerProjectionExpectation;
	runId: string;
	workflow: Partial<Omit<WorkflowProjection, "version" | "hash">>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerCompleteRunIntent = {
	expect: TrackerProjectionExpectation;
	runId: string;
	workflow: Partial<Omit<WorkflowProjection, "version" | "hash">>;
	artifacts?: Array<Omit<WorkflowArtifact, "id">>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerRecordArtifactsIntent = {
	artifacts?: Array<Omit<WorkflowArtifact, "id">>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerRecordArtifactsResult = {
	issue: WorkflowIssue;
	log: WorkflowLog;
	artifacts: Array<WorkflowArtifact>;
	changes: Array<WorkflowChange>;
};

export type TrackerEscalateIntent = {
	expect: TrackerProjectionExpectation;
	workflow: Partial<Omit<WorkflowProjection, "version" | "hash">>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerResumeIntent = TrackerEscalateIntent;

export type TrackerRelationshipIntent =
	| { type: "add-child"; parentId: string; childId: string }
	| { type: "remove-child"; parentId: string; childId: string }
	| { type: "add-dependency"; issueId: string; blockedById: string }
	| { type: "remove-dependency"; issueId: string; blockedById: string };

export type TrackerApplyPlanIntent = {
	specId: string;
	expect: TrackerProjectionExpectation;
	specWorkflow: Partial<Omit<WorkflowProjection, "version" | "hash">>;
	tickets: Array<{
		key: string;
		title: string;
		body?: string;
		workflow: CreateIssueInput["workflow"];
		dependsOn?: Array<string>;
	}>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerApplyPlanResult = {
	spec: WorkflowIssue;
	tickets: Array<{ key: string; id: string }>;
	log: WorkflowLog;
};

export type TrackerIssueInspection = {
	issue?: WorkflowIssue;
	logs: Array<unknown>;
	labels?: Array<string>;
	projectionError?: string;
};

export type Tracker = {
	createWorkflowIssue: (
		input: TrackerCreateWorkflowIssueIntent,
	) => Promise<{ issue: WorkflowIssue; log?: WorkflowLog }>;
	startRun: (
		id: string,
		input: TrackerStartRunIntent,
	) => Promise<{ issue: WorkflowIssue; log: WorkflowLog }>;
	completeRun: (
		id: string,
		input: TrackerCompleteRunIntent,
	) => Promise<TrackerRecordArtifactsResult>;
	recordArtifacts: (
		id: string,
		input: TrackerRecordArtifactsIntent,
	) => Promise<TrackerRecordArtifactsResult>;
	escalateWorkflow: (
		id: string,
		input: TrackerEscalateIntent,
	) => Promise<{ issue: WorkflowIssue; log: WorkflowLog }>;
	resumeWorkflow: (
		id: string,
		input: TrackerResumeIntent,
	) => Promise<{ issue: WorkflowIssue; log: WorkflowLog }>;
	changeRelationship: (input: TrackerRelationshipIntent) => Promise<void>;
	applyPlan: (input: TrackerApplyPlanIntent) => Promise<TrackerApplyPlanResult>;
	createIssue: (input: CreateIssueInput) => Promise<WorkflowIssue>;
	getIssue: (id: string) => Promise<WorkflowIssue>;
	listIssues: () => Promise<Array<WorkflowIssue>>;
	updateIssue: (id: string, input: UpdateIssueInput) => Promise<WorkflowIssue>;
	appendLog: (
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	) => Promise<WorkflowLog>;
	readLogs: (id: string) => Promise<Array<WorkflowLog>>;
	inspectIssue?: (id: string) => Promise<TrackerIssueInspection>;
	addChild: (parentId: string, childId: string) => Promise<void>;
	removeChild: (parentId: string, childId: string) => Promise<void>;
	addDependency: (issueId: string, blockedById: string) => Promise<void>;
	removeDependency: (issueId: string, blockedById: string) => Promise<void>;
	deleteIssue: (id: string) => Promise<void>;
	registerArtifact: (
		issueId: string,
		input: Omit<WorkflowArtifact, "id">,
	) => Promise<WorkflowArtifact>;
	registerChange: (
		issueId: string,
		input: Omit<WorkflowChange, "id">,
	) => Promise<WorkflowChange>;
};

export class ProjectionConflictError extends Error {
	constructor(
		message = "Workflow projection expectation does not match current projection.",
	) {
		super(message);
		this.name = "ProjectionConflictError";
	}
}

export class NeedReconciliationError extends Error {
	constructor(
		message = "NEED_RECONCILIATION: tracker intent verification failed.",
	) {
		super(message);
		this.name = "NeedReconciliationError";
	}
}

export class CorruptWorkflowProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorruptWorkflowProjectionError";
	}
}

export class IssueNotFoundError extends Error {
	constructor(id: string) {
		super(`Workflow issue '${id}' was not found.`);
		this.name = "IssueNotFoundError";
	}
}

export function createInMemoryTracker(
	seed: { issues?: Array<SeedIssueInput> } = {},
): Tracker {
	return new InMemoryTracker(seed.issues ?? []);
}

export function createInMemoryTrackerFromEnvironment(
	env: Record<string, string | undefined>,
): Tracker {
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

class InMemoryTracker implements Tracker {
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

	async changeRelationship(input: TrackerRelationshipIntent): Promise<void> {
		if (input.type === "add-child") {
			await this.addChild(input.parentId, input.childId);
		} else if (input.type === "remove-child") {
			await this.removeChild(input.parentId, input.childId);
		} else if (input.type === "add-dependency") {
			await this.addDependency(input.issueId, input.blockedById);
		} else {
			await this.removeDependency(input.issueId, input.blockedById);
		}
	}

	async applyPlan(
		input: TrackerApplyPlanIntent,
	): Promise<TrackerApplyPlanResult> {
		const created: Array<{ key: string; id: string }> = [];
		for (const ticket of input.tickets) {
			const issue = await this.createIssue({
				title: ticket.title,
				body: ticket.body,
				workflow: ticket.workflow,
			});
			created.push({ key: ticket.key, id: issue.id });
			await this.addChild(input.specId, issue.id);
		}
		const idsByKey = new Map(created.map((ticket) => [ticket.key, ticket.id]));
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
				await this.addDependency(issueId, blockedById);
			}
		}
		const spec = await this.updateIssue(input.specId, {
			expect: input.expect,
			workflow: input.specWorkflow,
		});
		const log = await this.appendLog(input.specId, input.log);
		return { spec, tickets: created, log };
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
		input: Omit<WorkflowArtifact, "id">,
	): Promise<WorkflowArtifact> {
		const issue = this.requireIssue(issueId);
		const artifact = { id: `artifact-${issue.artifacts.length + 1}`, ...input };
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
		kind: readSingleLabel(input.labels, "type", input.id),
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
	const values = labels
		.filter((label) => label.startsWith(`${prefix}:`))
		.map((label) => label.slice(prefix.length + 1));
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
	const values = labels
		.filter((label) => label.startsWith(`${prefix}:`))
		.map((label) => label.slice(prefix.length + 1));
	if (values.length > 1 || values.some((value) => value === "")) {
		throw new CorruptWorkflowProjectionError(
			`Issue '${id}' has corrupt ${prefix} projection data.`,
		);
	}
	return values[0];
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

function pushUnique(values: Array<string>, value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}
