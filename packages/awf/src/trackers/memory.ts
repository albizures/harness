import { createTrackerAdapter } from "../tracker-intents.ts";
import {
	CorruptWorkflowProjectionError,
	type CreateIssueInput,
	type SeedIssueInput,
	type TrackerAdapter,
	type TrackerIssueInspection,
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
	return createTrackerAdapter(
		new WorkflowStateTracker(new WorkflowTrackerState(seed.issues ?? [])),
	);
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

export class WorkflowStateTracker {
	readonly verification;
	private readonly state: WorkflowTrackerState;
	private readonly onMutation: () => void;

	constructor(state: WorkflowTrackerState, onMutation: () => void = () => {}) {
		this.state = state;
		this.onMutation = onMutation;
		this.verification = {
			verifyChild: (parentId: string, childId: string, expected: boolean) =>
				this.state.verifyChild(parentId, childId, expected),
			verifyDependency: (
				issueId: string,
				blockedById: string,
				expected: boolean,
			) => this.state.verifyDependency(issueId, blockedById, expected),
			verifyPlanApplication: (
				specId: string,
				tickets: Array<{ key: string; id: string }>,
				inputs: Parameters<WorkflowTrackerState["verifyPlanApplication"]>[2],
			) => this.state.verifyPlanApplication(specId, tickets, inputs),
		};
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
