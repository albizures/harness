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
};

export type SeedIssueInput =
	| CreateIssueInput
	| {
			id: string;
			title: string;
			body?: string;
			labels: Array<string>;
			version?: number;
	  };

export type UpdateIssueInput = {
	expect?: { version?: number; hash?: string };
	title?: string;
	body?: string;
	workflow?: Partial<Omit<WorkflowProjection, "version" | "hash">>;
};

export type Tracker = {
	createIssue: (input: CreateIssueInput) => Promise<WorkflowIssue>;
	getIssue: (id: string) => Promise<WorkflowIssue>;
	updateIssue: (id: string, input: UpdateIssueInput) => Promise<WorkflowIssue>;
	appendLog: (
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	) => Promise<WorkflowLog>;
	readLogs: (id: string) => Promise<Array<WorkflowLog>>;
	addChild: (parentId: string, childId: string) => Promise<void>;
	addDependency: (issueId: string, blockedById: string) => Promise<void>;
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
		return cloneIssue(this.requireIssue(id));
	}

	async updateIssue(
		id: string,
		input: UpdateIssueInput,
	): Promise<WorkflowIssue> {
		const issue = this.requireIssue(id);
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
		const issue = this.requireIssue(id);
		const log = cloneJson({
			...input,
			issueId: id,
			sequence: issue.logs.length + 1,
		}) as WorkflowLog;
		issue.logs.push(log);
		return cloneJson(log) as WorkflowLog;
	}

	async readLogs(id: string): Promise<Array<WorkflowLog>> {
		return cloneJson(this.requireIssue(id).logs) as Array<WorkflowLog>;
	}

	async addChild(parentId: string, childId: string): Promise<void> {
		const parent = this.requireIssue(parentId);
		const child = this.requireIssue(childId);
		child.relationships.parent = parentId;
		pushUnique(parent.relationships.children, childId);
	}

	async addDependency(issueId: string, blockedById: string): Promise<void> {
		const issue = this.requireIssue(issueId);
		const blocker = this.requireIssue(blockedById);
		pushUnique(issue.relationships.dependencies, blockedById);
		pushUnique(blocker.relationships.dependents, issueId);
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
		const seeded = "labels" in input ? fromLabels(input) : input;
		if (seeded.id === undefined) {
			throw new CorruptWorkflowProjectionError(
				"Seeded issues must have an id.",
			);
		}
		const normalized = normalizeIssue({ ...seeded, id: seeded.id });
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
}

type StoredIssue = Omit<WorkflowIssue, "workflow"> & {
	workflow: WorkflowProjection;
	logs: Array<WorkflowLog>;
};

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
		relationships: { children: [], dependencies: [], dependents: [] },
		artifacts: [],
		changes: [],
		logs: [],
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
	const { logs: _logs, ...withoutLogs } = issue;
	return cloneJson(withoutLogs) as WorkflowIssue;
}

function cloneJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function pushUnique(values: Array<string>, value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}
