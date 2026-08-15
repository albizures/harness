import { createTrackerIntentModule } from "../tracker-intents.ts";
import {
	CorruptWorkflowProjectionError,
	type CreateIssueInput,
	type SeedIssueInput,
	type Tracker,
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
	type WorkflowChange,
	type WorkflowIssue,
	type WorkflowLog,
} from "../tracker.ts";
import { WorkflowTrackerState } from "./state.ts";

export function createInMemoryTracker(
	seed: { issues?: Array<SeedIssueInput> } = {},
): TrackerAdapter {
	return new WorkflowStateTracker(new WorkflowTrackerState(seed.issues ?? []));
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

export class WorkflowStateTracker implements TrackerAdapter {
	private readonly state: WorkflowTrackerState;
	private readonly intentModule: Tracker;
	private readonly onMutation: () => void;

	constructor(state: WorkflowTrackerState, onMutation: () => void = () => {}) {
		this.state = state;
		this.onMutation = onMutation;
		this.intentModule = createTrackerIntentModule({
			createIssue: (input) => this.createIssue(input),
			updateIssue: (id, input) => this.updateIssue(id, input),
			appendLog: (id, input) => this.appendLog(id, input),
			addChild: (parentId, childId) => this.addChild(parentId, childId),
			removeChild: (parentId, childId) => this.removeChild(parentId, childId),
			addDependency: (issueId, blockedById) =>
				this.addDependency(issueId, blockedById),
			removeDependency: (issueId, blockedById) =>
				this.removeDependency(issueId, blockedById),
			deleteIssue: (id) => this.deleteIssue(id),
			registerArtifact: (issueId, input) =>
				this.registerArtifact(issueId, input),
			registerChange: (issueId, input) => this.registerChange(issueId, input),
			getIssue: (id) => this.getIssue(id),
			listIssues: () => this.listIssues(),
			readLogs: (id) => this.readLogs(id),
			inspectIssue: (id) => this.inspectIssue(id),
			verification: {
				verifyChild: (parentId, childId, expected) =>
					this.state.verifyChild(parentId, childId, expected),
				verifyDependency: (issueId, blockedById, expected) =>
					this.state.verifyDependency(issueId, blockedById, expected),
				verifyPlanApplication: (specId, tickets, inputs) =>
					this.state.verifyPlanApplication(specId, tickets, inputs),
			},
		});
	}

	async createWorkflowIssue(
		input: TrackerCreateWorkflowIssueIntent,
	): Promise<{ issue: WorkflowIssue; log?: WorkflowLog }> {
		return this.intentModule.createWorkflowIssue(input);
	}

	async startRun(
		id: string,
		input: TrackerStartRunIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		return this.intentModule.startRun(id, input);
	}

	async completeRun(
		id: string,
		input: TrackerCompleteRunIntent,
	): Promise<TrackerRecordArtifactsResult> {
		return this.intentModule.completeRun(id, input);
	}

	async recordArtifacts(
		id: string,
		input: TrackerRecordArtifactsIntent,
	): Promise<TrackerRecordArtifactsResult> {
		return this.intentModule.recordArtifacts(id, input);
	}

	async escalateWorkflow(
		id: string,
		input: TrackerEscalateIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		return this.intentModule.escalateWorkflow(id, input);
	}

	async resumeWorkflow(
		id: string,
		input: TrackerResumeIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		return this.intentModule.resumeWorkflow(id, input);
	}

	async recordCommand(
		id: string,
		input: TrackerRecordCommandIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		return this.intentModule.recordCommand(id, input);
	}

	async advanceWorkflow(
		id: string,
		input: TrackerAdvanceWorkflowIntent,
	): Promise<WorkflowIssue> {
		return this.intentModule.advanceWorkflow(id, input);
	}

	async repairIssue(
		id: string,
		input: TrackerRepairIssueIntent,
	): Promise<WorkflowIssue> {
		return this.intentModule.repairIssue(id, input);
	}

	async changeRelationship(input: TrackerRelationshipIntent): Promise<void> {
		return this.intentModule.changeRelationship(input);
	}

	async applyPlan(
		input: TrackerApplyPlanIntent,
	): Promise<TrackerApplyPlanResult> {
		return this.intentModule.applyPlan(input);
	}

	async createIssue(input: CreateIssueInput): Promise<WorkflowIssue> {
		const result = this.state.createIssue(input);
		this.onMutation();
		return result;
	}

	async getIssue(id: string): Promise<WorkflowIssue> {
		return this.state.getIssue(id);
	}

	async listIssues(): Promise<Array<WorkflowIssue>> {
		return this.state.listIssues();
	}

	async inspectIssue(id: string): Promise<TrackerIssueInspection> {
		return this.state.inspectIssue(id);
	}

	async updateIssue(
		id: string,
		input: UpdateIssueInput,
	): Promise<WorkflowIssue> {
		const result = this.state.updateIssue(id, input);
		this.onMutation();
		return result;
	}

	async appendLog(
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	): Promise<WorkflowLog> {
		const result = this.state.appendLog(id, input);
		this.onMutation();
		return result;
	}

	async readLogs(id: string): Promise<Array<WorkflowLog>> {
		return this.state.readLogs(id);
	}

	async addChild(parentId: string, childId: string): Promise<void> {
		this.state.addChild(parentId, childId);
		this.onMutation();
	}

	async removeChild(parentId: string, childId: string): Promise<void> {
		this.state.removeChild(parentId, childId);
		this.onMutation();
	}

	async addDependency(issueId: string, blockedById: string): Promise<void> {
		this.state.addDependency(issueId, blockedById);
		this.onMutation();
	}

	async removeDependency(issueId: string, blockedById: string): Promise<void> {
		this.state.removeDependency(issueId, blockedById);
		this.onMutation();
	}

	async deleteIssue(id: string): Promise<void> {
		this.state.deleteIssue(id);
		this.onMutation();
	}

	async registerArtifact(
		issueId: string,
		input: WorkflowArtifactInput,
	): Promise<WorkflowArtifact> {
		const result = this.state.registerArtifact(issueId, input);
		this.onMutation();
		return result;
	}

	async registerChange(
		issueId: string,
		input: Omit<WorkflowChange, "id">,
	): Promise<WorkflowChange> {
		const result = this.state.registerChange(issueId, input);
		this.onMutation();
		return result;
	}
}
