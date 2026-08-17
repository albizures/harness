import {
	WorkflowArtifact,
	WorkflowArtifactInput,
} from "./workflow/artifact.ts";
import { WorkflowChange } from "./workflow/change.ts";
import { CreateIssueInput, UpdateIssueInput, WorkflowIssue } from "./workflow/issue.ts";
import { WorkflowLog } from "./workflow/log.ts";
import { WorkflowProjection } from "./workflow/projection.ts";

export type TrackerProjectionExpectation = NonNullable<
	UpdateIssueInput["expect"]
>;

export type TrackerLog = Omit<WorkflowLog, "sequence" | "issueId">
export type TrackerWorkflow = Partial<Omit<WorkflowProjection, "version" | "hash">>

export type TrackerCreateWorkflowIssueIntent = CreateIssueInput & {
	initialLog?: TrackerLog;
};

export type TrackerStartRunIntent = {
	expect: TrackerProjectionExpectation;
	runId: string;
	workflow: TrackerWorkflow;
	log: TrackerLog;
};

export type TrackerCompleteRunIntent = {
	expect: TrackerProjectionExpectation;
	runId: string;
	workflow: TrackerWorkflow;
	artifacts?: Array<WorkflowArtifactInput>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: TrackerLog;
};

export type TrackerRecordArtifactsIntent = {
	artifacts?: Array<WorkflowArtifactInput>;
	changes?: Array<Omit<WorkflowChange, "id">>;
	log: TrackerLog;
};

export type TrackerRecordCommandIntent = {
	log: TrackerLog;
};

export type TrackerAdvanceWorkflowIntent = {
	expect: TrackerProjectionExpectation;
	workflow: TrackerWorkflow;
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
	workflow: TrackerWorkflow;
	log: TrackerLog;
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
	specWorkflow: TrackerWorkflow;
	tickets: Array<{
		key: string;
		title: string;
		body?: string;
		workflow: CreateIssueInput["workflow"];
		dependsOn?: Array<string>;
	}>;
	artifacts?: Array<WorkflowArtifactInput>;
	log: TrackerLog;
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
export type TrackerAdapterPrimitiveReads = {
	getIssue: (id: string) => Promise<WorkflowIssue>;
	listIssues: () => Promise<Array<WorkflowIssue>>;
	readLogs: (id: string) => Promise<Array<WorkflowLog>>;
	inspectIssue?: (id: string) => Promise<TrackerIssueInspection>;
};

export type TrackerAdapterPrimitiveOperations = {
	createIssue: (input: CreateIssueInput) => Promise<WorkflowIssue>;
	updateIssue: (id: string, input: UpdateIssueInput) => Promise<WorkflowIssue>;
	appendLog: (
		id: string,
		input: TrackerLog,
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

export type TrackerVerificationHooks = {
	verifyChild?: (
		parentId: string,
		childId: string,
		expected: boolean,
	) => void | Promise<void>;
	verifyDependency?: (
		issueId: string,
		blockedById: string,
		expected: boolean,
	) => void | Promise<void>;
	verifyPlanApplication?: (
		specId: string,
		tickets: Array<{ key: string; id: string }>,
		inputs: TrackerApplyPlanIntent["tickets"],
	) => void | Promise<void>;
};

export type TrackerAdapterPrimitives = TrackerAdapterPrimitiveOperations;

export type TrackerAdapter = Tracker & TrackerAdapterPrimitiveOperations;

export class NeedReconciliationError extends Error {
	constructor(
		message = "NEED_RECONCILIATION: tracker intent verification failed.",
	) {
		super(message);
		this.name = "NeedReconciliationError";
	}
}

