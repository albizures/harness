import type {
	CreateIssueInput,
	UpdateIssueInput,
	WorkflowIssue,
} from "../domain/workflow/issue.ts";
import type { WorkflowLog } from "../domain/workflow/log.ts";
import type { WorkflowProjection } from "../domain/workflow/projection.ts";

export type TrackerProjectionExpectation = NonNullable<
	UpdateIssueInput["expect"]
>;

export type TrackerLog = Omit<WorkflowLog, "sequence" | "issueId">;
export type TrackerWorkflow = Partial<
	Omit<WorkflowProjection, "version" | "hash">
>;

export type TrackerCreateWorkflowIssueIntent = CreateIssueInput & {
	initialLog?: TrackerLog;
};

export type TrackerRecordCommandIntent = {
	log: TrackerLog;
};

export type TrackerRepairIssueIntent = {
	expect: TrackerProjectionExpectation;
	workflow: TrackerWorkflow;
};

export type TrackerRelationshipIntent =
	| { type: "add-child"; parentId: string; childId: string }
	| { type: "remove-child"; parentId: string; childId: string }
	| { type: "add-dependency"; issueId: string; blockedById: string }
	| { type: "remove-dependency"; issueId: string; blockedById: string };

export type TrackerIssueRef = { id: string } | { key: string };

export type TrackerWorkflowEffect =
	| {
			type: "create-workflow-issue";
			key?: string;
			input: CreateIssueInput;
			initialLog?: TrackerLog;
	  }
	| {
			type: "update-workflow";
			issue: TrackerIssueRef;
			expect: TrackerProjectionExpectation;
			workflow: TrackerWorkflow;
	  }
	| {
			type: "update-issue";
			issue: TrackerIssueRef;
			expect?: TrackerProjectionExpectation;
			title?: string;
			body?: string;
	  }
	| { type: "record-command"; issue: TrackerIssueRef; log: TrackerLog }
	| { type: "add-child"; parent: TrackerIssueRef; child: TrackerIssueRef }
	| { type: "remove-child"; parent: TrackerIssueRef; child: TrackerIssueRef }
	| {
			type: "add-dependency";
			issue: TrackerIssueRef;
			blockedBy: TrackerIssueRef;
	  }
	| {
			type: "remove-dependency";
			issue: TrackerIssueRef;
			blockedBy: TrackerIssueRef;
	  };

export type TrackerApplyWorkflowEffectsIntent = {
	effects: Array<TrackerWorkflowEffect>;
};

export type TrackerApplyWorkflowEffectsResult = {
	issues: Record<string, WorkflowIssue>;
	createdIssues: Array<{ key?: string; id: string; issue: WorkflowIssue }>;
	logs: Array<WorkflowLog>;
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
	changeRelationship: (input: TrackerRelationshipIntent) => Promise<void>;
	applyWorkflowEffects: (
		input: TrackerApplyWorkflowEffectsIntent,
	) => Promise<TrackerApplyWorkflowEffectsResult>;
	recordCommand: (
		id: string,
		input: TrackerRecordCommandIntent,
	) => Promise<{ issue: WorkflowIssue; log: WorkflowLog }>;
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
	appendLog: (id: string, input: TrackerLog) => Promise<WorkflowLog>;
	addChild: (parentId: string, childId: string) => Promise<void>;
	removeChild: (parentId: string, childId: string) => Promise<void>;
	addDependency: (issueId: string, blockedById: string) => Promise<void>;
	removeDependency: (issueId: string, blockedById: string) => Promise<void>;
	deleteIssue: (id: string) => Promise<void>;
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
	verifyWorkflowEffects?: (
		result: TrackerApplyWorkflowEffectsResult,
		effects: Array<TrackerWorkflowEffect>,
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
