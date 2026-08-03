import type { JsonValue } from "type-fest";
import {
	validateArtifactReferenceValue,
	type ArtifactKind,
} from "./manifest.ts";

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

export type StructuredWorkflowArtifactReference = {
	type: ArtifactKind;
	ref?: string;
	url?: string;
	path?: string;
	id?: string;
	title?: string;
	metadata?: Record<string, JsonValue>;
};

export type WorkflowArtifact = {
	id: string;
	kind: ArtifactKind;
	uri: string;
	name?: string;
} & Partial<StructuredWorkflowArtifactReference>;

export type WorkflowArtifactInput = Omit<WorkflowArtifact, "id"> & {
	id?: string;
};

export function normalizeWorkflowArtifactInput(
	input: WorkflowArtifactInput,
	id: string,
): WorkflowArtifact {
	validateWorkflowArtifactInput(input);
	return {
		...compatibilityStructuredArtifactFields(input.kind, input.uri),
		...input,
		type: input.type ?? input.kind,
		id,
	};
}

export function validateWorkflowArtifactInput(
	input: WorkflowArtifactInput,
): void {
	const uriIssue = validateArtifactReferenceValue(input.uri, input.kind);
	if (uriIssue !== undefined) {
		throw new Error(uriIssue);
	}
	if (input.type !== undefined && input.type !== input.kind) {
		throw new Error(`Artifact type must be '${input.kind}'.`);
	}
	for (const [field, value] of structuredArtifactFields(input.kind, input)) {
		const fieldIssue = validateArtifactReferenceValue(value, input.kind);
		if (fieldIssue !== undefined) {
			throw new Error(`${field}: ${fieldIssue}`);
		}
	}
}

function structuredArtifactFields(
	kind: ArtifactKind,
	input: WorkflowArtifactInput,
): Array<["ref" | "url" | "path", string]> {
	const field = structuredArtifactField(kind);
	const value = input[field];
	return value === undefined ? [] : [[field, value]];
}

function structuredArtifactField(kind: ArtifactKind): "ref" | "url" | "path" {
	if (kind === "pull-request" || kind === "url") {
		return "url";
	}
	if (kind === "file") {
		return "path";
	}
	return "ref";
}

function compatibilityStructuredArtifactFields(
	kind: ArtifactKind,
	uri: string,
): Partial<StructuredWorkflowArtifactReference> {
	if (kind === "pull-request" || kind === "url") {
		return { type: kind, url: uri };
	}
	if (kind === "file") {
		return { type: kind, path: uri };
	}
	return { type: kind, ref: uri };
}

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
	artifacts?: Array<WorkflowArtifactInput>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerRecordArtifactsIntent = {
	artifacts?: Array<WorkflowArtifactInput>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerRecordCommandIntent = {
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerAdvanceWorkflowIntent = {
	expect: TrackerProjectionExpectation;
	workflow: Partial<Omit<WorkflowProjection, "version" | "hash">>;
};

export type TrackerRepairIssueIntent = TrackerAdvanceWorkflowIntent;

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
	artifacts?: Array<WorkflowArtifactInput>;
	log: Omit<WorkflowLog, "sequence" | "issueId">;
};

export type TrackerApplyPlanResult = {
	spec: WorkflowIssue;
	tickets: Array<{ key: string; id: string }>;
	artifacts: Array<WorkflowArtifact>;
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
	recordCommand: (
		id: string,
		input: TrackerRecordCommandIntent,
	) => Promise<{ issue: WorkflowIssue; log: WorkflowLog }>;
	advanceWorkflow: (
		id: string,
		input: TrackerAdvanceWorkflowIntent,
	) => Promise<WorkflowIssue>;
	repairIssue: (
		id: string,
		input: TrackerRepairIssueIntent,
	) => Promise<WorkflowIssue>;
	getIssue: (id: string) => Promise<WorkflowIssue>;
	listIssues: () => Promise<Array<WorkflowIssue>>;
	readLogs: (id: string) => Promise<Array<WorkflowLog>>;
	inspectIssue?: (id: string) => Promise<TrackerIssueInspection>;
};

/**
 * Adapter-owned mutating primitives.
 *
 * Runtime and CLI code should depend on `Tracker`, which exposes verified
 * workflow intents plus reads. These primitives are retained for adapter
 * implementations, reconciliation/test setup, and projection repair internals.
 */
export type TrackerAdapterPrimitives = {
	createIssue: (input: CreateIssueInput) => Promise<WorkflowIssue>;
	updateIssue: (id: string, input: UpdateIssueInput) => Promise<WorkflowIssue>;
	appendLog: (
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	) => Promise<WorkflowLog>;
	addChild: (parentId: string, childId: string) => Promise<void>;
	removeChild: (parentId: string, childId: string) => Promise<void>;
	addDependency: (issueId: string, blockedById: string) => Promise<void>;
	removeDependency: (issueId: string, blockedById: string) => Promise<void>;
	deleteIssue: (id: string) => Promise<void>;
	registerArtifact: (
		issueId: string,
		input: WorkflowArtifactInput,
	) => Promise<WorkflowArtifact>;
	registerChange: (
		issueId: string,
		input: Omit<WorkflowChange, "id">,
	) => Promise<WorkflowChange>;
};

export type TrackerAdapter = Tracker & TrackerAdapterPrimitives;

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
