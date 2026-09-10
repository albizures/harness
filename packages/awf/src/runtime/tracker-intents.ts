import {
	NeedReconciliationError,
	type Tracker,
	type TrackerAdapter,
	type TrackerAdapterPrimitiveReads,
	type TrackerAdapterPrimitiveOperations,
	type TrackerApplyWorkflowEffectsIntent,
	type TrackerApplyWorkflowEffectsResult,
	type TrackerCreateWorkflowIssueIntent,
	type TrackerIssueInspection,
	type TrackerRecordCommandIntent,
	type TrackerRelationshipIntent,
	type TrackerRepairIssueIntent,
	type TrackerVerificationHooks,
} from "../ports/tracker.ts";
import {
	IssueNotFoundError,
	type CreateIssueInput,
	type UpdateIssueInput,
	type WorkflowIssue,
} from "../domain/workflow/issue.ts";
import type { WorkflowLog } from "../domain/workflow/log.ts";
import { ProjectionConflictError } from "../domain/workflow/projection.ts";

export type TrackerIntentModulePrimitives = TrackerAdapterPrimitiveOperations &
	TrackerAdapterPrimitiveReads & {
		verification?: TrackerVerificationHooks;
	};

export function createTrackerIntentModule(
	primitives: TrackerIntentModulePrimitives,
): Tracker {
	return new PrimitiveTrackerIntentModule(primitives);
}

export function createTrackerAdapter(
	primitives: TrackerIntentModulePrimitives,
): TrackerAdapter {
	const intents = createTrackerIntentModule(primitives);
	return new Proxy(primitives as TrackerAdapter, {
		get(target, property, receiver) {
			const intentValue = Reflect.get(intents, property, intents);
			if (intentValue !== undefined) {
				return typeof intentValue === "function"
					? intentValue.bind(intents)
					: intentValue;
			}
			const primitiveValue = Reflect.get(target, property, receiver);
			return typeof primitiveValue === "function"
				? primitiveValue.bind(target)
				: primitiveValue;
		},
	});
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

	async recordCommand(
		id: string,
		input: TrackerRecordCommandIntent,
	): Promise<{ issue: WorkflowIssue; log: WorkflowLog }> {
		const log = await this.primitives.appendLog(id, input.log);
		return { issue: await this.primitives.getIssue(id), log };
	}

	async repairIssue(
		id: string,
		input: TrackerRepairIssueIntent,
	): Promise<WorkflowIssue> {
		return this.primitives.updateIssue(id, input);
	}

	async changeRelationship(input: TrackerRelationshipIntent): Promise<void> {
		try {
			if (input.type === "add-child") {
				await this.primitives.addChild(input.parentId, input.childId);
				await this.verifyChild(input.parentId, input.childId, true);
			} else if (input.type === "remove-child") {
				await this.primitives.removeChild(input.parentId, input.childId);
				await this.verifyChild(input.parentId, input.childId, false);
			} else if (input.type === "add-dependency") {
				await this.primitives.addDependency(input.issueId, input.blockedById);
				await this.verifyDependency(input.issueId, input.blockedById, true);
			} else {
				await this.primitives.removeDependency(
					input.issueId,
					input.blockedById,
				);
				await this.verifyDependency(input.issueId, input.blockedById, false);
			}
		} catch (error) {
			throw relationshipIntentError(error);
		}
	}

	private async verifyChild(
		parentId: string,
		childId: string,
		expected: boolean,
	): Promise<void> {
		if (this.primitives.verification?.verifyChild !== undefined) {
			await this.primitives.verification.verifyChild(
				parentId,
				childId,
				expected,
			);
			return;
		}
		const [parent, child] = await Promise.all([
			this.primitives.getIssue(parentId),
			this.primitives.getIssue(childId),
		]);
		const present =
			parent.relationships.children.includes(childId) &&
			child.relationships.parent === parentId;
		if (present !== expected) {
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: child relationship '${parentId}' -> '${childId}' could not be verified.`,
			);
		}
	}

	private async verifyDependency(
		issueId: string,
		blockedById: string,
		expected: boolean,
	): Promise<void> {
		if (this.primitives.verification?.verifyDependency !== undefined) {
			await this.primitives.verification.verifyDependency(
				issueId,
				blockedById,
				expected,
			);
			return;
		}
		const [issue, blocker] = await Promise.all([
			this.primitives.getIssue(issueId),
			this.primitives.getIssue(blockedById),
		]);
		const present =
			issue.relationships.dependencies.includes(blockedById) &&
			blocker.relationships.dependents.includes(issueId);
		if (present !== expected) {
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: dependency relationship '${issueId}' -> '${blockedById}' could not be verified.`,
			);
		}
	}

	async applyWorkflowEffects(
		input: TrackerApplyWorkflowEffectsIntent,
	): Promise<TrackerApplyWorkflowEffectsResult> {
		const result: TrackerApplyWorkflowEffectsResult = {
			issues: {},
			createdIssues: [],
			logs: [],
		};
		const idsByKey = new Map<string, string>();
		const rollback: Array<() => Promise<void>> = [];
		try {
			for (const effect of input.effects) {
				if (effect.type === "create-workflow-issue") {
					const issue = await this.primitives.createIssue(effect.input);
					if (effect.key !== undefined) {
						idsByKey.set(effect.key, issue.id);
					}
					rollback.push(async () => this.primitives.deleteIssue(issue.id));
					let current = issue;
					let log: WorkflowLog | undefined;
					if (effect.initialLog !== undefined) {
						log = await this.primitives.appendLog(issue.id, effect.initialLog);
						result.logs.push(log);
						current = await this.primitives.getIssue(issue.id);
					}
					await this.verifyCreatedIssue(current, effect.input, log);
					result.issues[issue.id] = current;
					result.createdIssues.push({
						key: effect.key,
						id: issue.id,
						issue: current,
					});
				} else if (effect.type === "update-workflow") {
					const id = resolveIssueRef(effect.issue, idsByKey);
					const issue = await this.primitives.updateIssue(id, {
						expect: effect.expect,
						workflow: effect.workflow,
					});
					await this.verifyWorkflowUpdate(id, effect.workflow);
					result.issues[id] = issue;
				} else if (effect.type === "update-issue") {
					const id = resolveIssueRef(effect.issue, idsByKey);
					const before = await this.primitives.getIssue(id);
					const update: UpdateIssueInput = {
						...(effect.expect === undefined ? {} : { expect: effect.expect }),
						...(effect.title === undefined ? {} : { title: effect.title }),
						...(effect.body === undefined ? {} : { body: effect.body }),
					};
					const issue = await this.primitives.updateIssue(id, update);
					rollback.push(async () => {
						await this.primitives.updateIssue(id, {
							title: before.title,
							...(before.body === undefined
								? { body: "" }
								: { body: before.body }),
						});
					});
					result.issues[id] = issue;
				} else if (effect.type === "record-command") {
					const id = resolveIssueRef(effect.issue, idsByKey);
					const log = await this.primitives.appendLog(id, effect.log);
					result.logs.push(log);
					await this.verifyLog(id, log);
					result.issues[id] = await this.primitives.getIssue(id);
				} else if (effect.type === "add-child") {
					const parentId = resolveIssueRef(effect.parent, idsByKey);
					const childId = resolveIssueRef(effect.child, idsByKey);
					await this.primitives.addChild(parentId, childId);
					rollback.push(async () =>
						this.primitives.removeChild(parentId, childId),
					);
					await this.verifyChild(parentId, childId, true);
				} else if (effect.type === "remove-child") {
					const parentId = resolveIssueRef(effect.parent, idsByKey);
					const childId = resolveIssueRef(effect.child, idsByKey);
					await this.primitives.removeChild(parentId, childId);
					rollback.push(async () =>
						this.primitives.addChild(parentId, childId),
					);
					await this.verifyChild(parentId, childId, false);
				} else if (effect.type === "add-dependency") {
					const issueId = resolveIssueRef(effect.issue, idsByKey);
					const blockedById = resolveIssueRef(effect.blockedBy, idsByKey);
					await this.primitives.addDependency(issueId, blockedById);
					rollback.push(async () =>
						this.primitives.removeDependency(issueId, blockedById),
					);
					await this.verifyDependency(issueId, blockedById, true);
				} else {
					const issueId = resolveIssueRef(effect.issue, idsByKey);
					const blockedById = resolveIssueRef(effect.blockedBy, idsByKey);
					await this.primitives.removeDependency(issueId, blockedById);
					rollback.push(async () =>
						this.primitives.addDependency(issueId, blockedById),
					);
					await this.verifyDependency(issueId, blockedById, false);
				}
			}
			await this.primitives.verification?.verifyWorkflowEffects?.(
				result,
				input.effects,
			);
			return result;
		} catch (error) {
			for (const undo of rollback.reverse()) {
				try {
					await undo();
				} catch {
					/* best-effort rollback */
				}
			}
			if (
				error instanceof NeedReconciliationError ||
				error instanceof ProjectionConflictError ||
				error instanceof IssueNotFoundError
			) {
				throw error;
			}
			throw new NeedReconciliationError(
				`NEED_RECONCILIATION: workflow effects application failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async verifyCreatedIssue(
		issue: WorkflowIssue,
		input: CreateIssueInput,
		log?: WorkflowLog,
	): Promise<void> {
		const reread = await this.primitives.getIssue(issue.id);
		if (
			reread.title !== input.title ||
			reread.workflow.kind !== input.workflow.kind
		) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow issue creation could not be verified.",
			);
		}
		if (log !== undefined) {
			await this.verifyLog(issue.id, log);
		}
	}

	private async verifyWorkflowUpdate(
		id: string,
		workflow: Record<string, unknown>,
	): Promise<void> {
		const issue = await this.primitives.getIssue(id);
		for (const [field, value] of Object.entries(workflow)) {
			if ((issue.workflow as Record<string, unknown>)[field] !== value) {
				throw new NeedReconciliationError(
					"NEED_RECONCILIATION: workflow-field update could not be verified.",
				);
			}
		}
	}

	private async verifyLog(id: string, log: WorkflowLog): Promise<void> {
		const logs = await this.primitives.readLogs(id);
		if (
			!logs.some(
				(stored) =>
					stored.sequence === log.sequence && stored.type === log.type,
			)
		) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow log addition could not be verified.",
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

function resolveIssueRef(
	ref: { id: string } | { key: string },
	idsByKey: Map<string, string>,
): string {
	if ("id" in ref) {
		return ref.id;
	}
	const id = idsByKey.get(ref.key);
	if (id === undefined) {
		throw new NeedReconciliationError(
			`NEED_RECONCILIATION: workflow issue key '${ref.key}' could not be resolved.`,
		);
	}
	return id;
}

function relationshipIntentError(error: unknown): Error {
	if (
		error instanceof NeedReconciliationError ||
		error instanceof ProjectionConflictError ||
		error instanceof IssueNotFoundError
	) {
		return error;
	}
	return new NeedReconciliationError(
		`NEED_RECONCILIATION: relationship intent failed: ${error instanceof Error ? error.message : String(error)}`,
	);
}
