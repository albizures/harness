import {
	CorruptWorkflowProjectionError,
	NeedReconciliationError,
	ProjectionConflictError,
	type CreateIssueInput,
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
	type WorkflowChange,
	type WorkflowIssue,
	type WorkflowLog,
} from "../tracker.ts";
import { WorkflowTrackerState, asObject } from "./state.ts";

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
	protected readonly state: WorkflowTrackerState;

	constructor(state: WorkflowTrackerState) {
		this.state = state;
	}

	protected afterMutation(): void {
		// In-memory trackers have no durable side effect.
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
		const artifacts: Array<WorkflowArtifact> = [];
		for (const artifact of input.artifacts ?? []) {
			artifacts.push(await this.registerArtifact(id, artifact));
		}
		const changes: Array<WorkflowChange> = [];
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
			this.state.verifyChild(input.parentId, input.childId, true);
		} else if (input.type === "remove-child") {
			await this.removeChild(input.parentId, input.childId);
			this.state.verifyChild(input.parentId, input.childId, false);
		} else if (input.type === "add-dependency") {
			await this.addDependency(input.issueId, input.blockedById);
			this.state.verifyDependency(input.issueId, input.blockedById, true);
		} else {
			await this.removeDependency(input.issueId, input.blockedById);
			this.state.verifyDependency(input.issueId, input.blockedById, false);
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
			const artifacts: Array<WorkflowArtifact> = [];
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
			this.state.verifyPlanApplication(input.specId, created, input.tickets);
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
		const result = this.state.createIssue(input);
		this.afterMutation();
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
		this.afterMutation();
		return result;
	}

	async appendLog(
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	): Promise<WorkflowLog> {
		const result = this.state.appendLog(id, input);
		this.afterMutation();
		return result;
	}

	async readLogs(id: string): Promise<Array<WorkflowLog>> {
		return this.state.readLogs(id);
	}

	async addChild(parentId: string, childId: string): Promise<void> {
		this.state.addChild(parentId, childId);
		this.afterMutation();
	}

	async removeChild(parentId: string, childId: string): Promise<void> {
		this.state.removeChild(parentId, childId);
		this.afterMutation();
	}

	async addDependency(issueId: string, blockedById: string): Promise<void> {
		this.state.addDependency(issueId, blockedById);
		this.afterMutation();
	}

	async removeDependency(issueId: string, blockedById: string): Promise<void> {
		this.state.removeDependency(issueId, blockedById);
		this.afterMutation();
	}

	async deleteIssue(id: string): Promise<void> {
		this.state.deleteIssue(id);
		this.afterMutation();
	}

	async registerArtifact(
		issueId: string,
		input: WorkflowArtifactInput,
	): Promise<WorkflowArtifact> {
		const result = this.state.registerArtifact(issueId, input);
		this.afterMutation();
		return result;
	}

	async registerChange(
		issueId: string,
		input: Omit<WorkflowChange, "id">,
	): Promise<WorkflowChange> {
		const result = this.state.registerChange(issueId, input);
		this.afterMutation();
		return result;
	}
}
