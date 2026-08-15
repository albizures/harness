import {
	IssueNotFoundError,
	NeedReconciliationError,
	ProjectionConflictError,
	type Tracker,
	type TrackerAdapterPrimitiveReads,
	type TrackerAdapterPrimitiveOperations,
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
	type TrackerVerificationHooks,
	type WorkflowArtifact,
	type WorkflowChange,
	type WorkflowIssue,
	type WorkflowLog,
} from "./tracker.ts";

export type TrackerIntentModulePrimitives = TrackerAdapterPrimitiveOperations &
	TrackerAdapterPrimitiveReads & {
		verification?: TrackerVerificationHooks;
	};

export function createTrackerIntentModule(
	primitives: TrackerIntentModulePrimitives,
): Tracker {
	return new PrimitiveTrackerIntentModule(primitives);
}

class PrimitiveTrackerIntentModule implements Tracker {
	private readonly primitives: TrackerIntentModulePrimitives;

	constructor(primitives: TrackerIntentModulePrimitives) {
		this.primitives = primitives;
	}

	async createWorkflowIssue(
		input: TrackerCreateWorkflowIssueIntent,
	): Promise<{ issue: WorkflowIssue; log?: WorkflowLog }> {
		const issue = await this.primitives.createIssue(input);
		const log =
			input.initialLog === undefined
				? undefined
				: await this.primitives.appendLog(issue.id, input.initialLog);
		return {
			issue:
				log === undefined ? issue : await this.primitives.getIssue(issue.id),
			log,
		};
	}

	async startRun(
		id: string,
		input: TrackerStartRunIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const issue = await this.primitives.updateIssue(id, {
			expect: input.expect,
			workflow: { ...input.workflow, activeRunId: input.runId },
		});
		const log = await this.primitives.appendLog(id, input.log);
		return { issue, log };
	}

	async completeRun(
		id: string,
		input: TrackerCompleteRunIntent,
	): Promise<TrackerRecordArtifactsResult> {
		await this.primitives.updateIssue(id, {
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
			artifacts.push(await this.primitives.registerArtifact(id, artifact));
		}
		const changes: Array<WorkflowChange> = [];
		for (const change of input.changes ?? []) {
			changes.push(await this.primitives.registerChange(id, change));
		}
		const log = await this.primitives.appendLog(id, input.log);
		return {
			issue: await this.primitives.getIssue(id),
			log,
			artifacts,
			changes,
		};
	}

	async escalateWorkflow(
		id: string,
		input: TrackerEscalateIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const issue = await this.primitives.updateIssue(id, {
			expect: input.expect,
			workflow: input.workflow,
		});
		const log = await this.primitives.appendLog(id, input.log);
		return { issue, log };
	}

	async resumeWorkflow(
		id: string,
		input: TrackerResumeIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const issue = await this.primitives.updateIssue(id, {
			expect: input.expect,
			workflow: input.workflow,
		});
		const log = await this.primitives.appendLog(id, input.log);
		return { issue, log };
	}

	async recordCommand(
		id: string,
		input: TrackerRecordCommandIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const log = await this.primitives.appendLog(id, input.log);
		return { issue: await this.primitives.getIssue(id), log };
	}

	async advanceWorkflow(
		id: string,
		input: TrackerAdvanceWorkflowIntent,
	): Promise<WorkflowIssue> {
		return this.primitives.updateIssue(id, input);
	}

	async repairIssue(
		id: string,
		input: TrackerRepairIssueIntent,
	): Promise<WorkflowIssue> {
		return this.primitives.updateIssue(id, input);
	}

	async changeRelationship(input: TrackerRelationshipIntent): Promise<void> {
		if (input.type === "add-child") {
			await this.primitives.addChild(input.parentId, input.childId);
			await this.primitives.verification?.verifyChild?.(
				input.parentId,
				input.childId,
				true,
			);
		} else if (input.type === "remove-child") {
			await this.primitives.removeChild(input.parentId, input.childId);
			await this.primitives.verification?.verifyChild?.(
				input.parentId,
				input.childId,
				false,
			);
		} else if (input.type === "add-dependency") {
			await this.primitives.addDependency(input.issueId, input.blockedById);
			await this.primitives.verification?.verifyDependency?.(
				input.issueId,
				input.blockedById,
				true,
			);
		} else {
			await this.primitives.removeDependency(input.issueId, input.blockedById);
			await this.primitives.verification?.verifyDependency?.(
				input.issueId,
				input.blockedById,
				false,
			);
		}
	}

	async applyPlan(
		input: TrackerApplyPlanIntent,
	): Promise<TrackerApplyPlanResult> {
		const tickets: Array<{ key: string; id: string }> = [];
		try {
			for (const ticket of input.tickets) {
				const issue = await this.primitives.createIssue({
					title: ticket.title,
					body: ticket.body,
					workflow: ticket.workflow,
				});
				tickets.push({ key: ticket.key, id: issue.id });
				await this.changeRelationship({
					type: "add-child",
					parentId: input.specId,
					childId: issue.id,
				});
			}
			const idsByKey = new Map(
				tickets.map((ticket) => [ticket.key, ticket.id]),
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
			await this.primitives.updateIssue(input.specId, {
				expect: input.expect,
				workflow: input.specWorkflow,
			});
			const artifacts: Array<WorkflowArtifact> = [];
			for (const artifact of input.artifacts ?? []) {
				artifacts.push(
					await this.primitives.registerArtifact(input.specId, artifact),
				);
			}
			const log = await this.primitives.appendLog(input.specId, {
				...input.log,
				payload: { ...asObject(input.log.payload), tickets, artifacts },
			});
			await this.primitives.verification?.verifyPlanApplication?.(
				input.specId,
				tickets,
				input.tickets,
			);
			return {
				spec: await this.primitives.getIssue(input.specId),
				tickets,
				artifacts,
				log,
			};
		} catch (error) {
			if (
				error instanceof NeedReconciliationError ||
				error instanceof ProjectionConflictError ||
				error instanceof IssueNotFoundError
			) {
				throw error;
			}
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: plan application intent failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async getIssue(id: string): Promise<WorkflowIssue> {
		return this.primitives.getIssue(id);
	}

	async listIssues(): Promise<Array<WorkflowIssue>> {
		return this.primitives.listIssues();
	}

	async readLogs(id: string): Promise<Array<WorkflowLog>> {
		return this.primitives.readLogs(id);
	}

	async inspectIssue(id: string): Promise<TrackerIssueInspection> {
		if (this.primitives.inspectIssue !== undefined) {
			return this.primitives.inspectIssue(id);
		}
		return {
			issue: await this.primitives.getIssue(id),
			logs: await this.primitives.readLogs(id),
		};
	}
}

function asObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
