import type { WorkflowManifest } from "../../manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	NeedReconciliationError,
	ProjectionConflictError,
	normalizeWorkflowArtifactInput,
	type CreateIssueInput,
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
	type WorkflowProjection,
} from "../../tracker.ts";
import type { GitHubTrackerApi, GitHubTrackerIssue } from "./index.ts";
import {
	hasWorkflowProjectionLabels,
	assertNoMalformedWorkflowProjectionLabels,
	isWorkflowProjectionLabel,
	labelsForProjection,
	projectionFromLabels,
	projectionMarker,
	logMarker,
	machineComment,
	parseMachineComment,
	metadataFromProjection,
	isProjectionMetadata,
	isWorkflowLog,
	withHash,
	sameProjection,
	normalizeRelationships,
	parseIssueNumber,
	validatePullRequestArtifact,
	needsReconciliation,
	validateGitHubTrackerCapabilities,
	validateProjectionShape,
	sameJson,
	cloneJson,
	asObject,
	type ProjectionMetadata,
} from "./helpers.ts";

export class GitHubTracker implements TrackerAdapter {
	private readonly api: GitHubTrackerApi;
	private readonly manifest: WorkflowManifest;

	constructor(api: GitHubTrackerApi, manifest: WorkflowManifest) {
		this.api = api;
		this.manifest = manifest;
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
			await this.verifyChild(input.parentId, input.childId, true);
		} else if (input.type === "remove-child") {
			await this.removeChild(input.parentId, input.childId);
			await this.verifyChild(input.parentId, input.childId, false);
		} else if (input.type === "add-dependency") {
			await this.addDependency(input.issueId, input.blockedById);
			await this.verifyDependency(input.issueId, input.blockedById, true);
		} else {
			await this.removeDependency(input.issueId, input.blockedById);
			await this.verifyDependency(input.issueId, input.blockedById, false);
		}
	}

	async applyPlan(
		input: TrackerApplyPlanIntent,
	): Promise<TrackerApplyPlanResult> {
		const tickets: Array<{ key: string; id: string }> = [];
		try {
			for (const ticket of input.tickets) {
				const issue = await this.createIssue({
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
				payload: { ...asObject(input.log.payload), tickets, artifacts },
			});
			await this.verifyPlanApplication(input.specId, tickets, input.tickets);
			return {
				spec: await this.getIssue(input.specId),
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

	async createIssue(input: CreateIssueInput): Promise<WorkflowIssue> {
		await validateGitHubTrackerCapabilities(this.api);
		const projection = withHash({
			...input.workflow,
			version: input.workflow.version ?? 1,
		});
		const labels = labelsForProjection(this.manifest, projection);
		const metadata = metadataFromProjection(projection, [], []);
		const created = await this.api.createIssue({
			title: input.title,
			body: input.body,
			labels,
		});
		await this.upsertProjectionComment(created.number, metadata);
		for (const log of input.logs ?? []) {
			await this.appendLog(String(created.number), log);
		}
		if (input.relationships?.parent !== undefined) {
			await this.addChild(input.relationships.parent, String(created.number));
		}
		for (const childId of input.relationships?.children ?? []) {
			await this.addChild(String(created.number), childId);
		}
		for (const blockedById of input.relationships?.dependencies ?? []) {
			await this.addDependency(String(created.number), blockedById);
		}
		return this.getIssue(String(created.number));
	}

	async getIssue(id: string): Promise<WorkflowIssue> {
		return this.readProjectedIssue(id);
	}

	async listIssues(): Promise<Array<WorkflowIssue>> {
		const issues: Array<WorkflowIssue> = [];
		for (const issue of await this.api.listIssues()) {
			assertNoMalformedWorkflowProjectionLabels(
				this.manifest,
				issue.number,
				issue.labels,
			);
			if (!hasWorkflowProjectionLabels(this.manifest, issue.labels)) {
				continue;
			}
			issues.push(await this.readProjectedIssue(String(issue.number), issue));
		}
		return issues;
	}

	async updateIssue(
		id: string,
		input: UpdateIssueInput,
	): Promise<WorkflowIssue> {
		const current = await this.readProjectedIssue(id);
		if (
			input.expect?.version !== undefined &&
			input.expect.version !== current.workflow.version
		) {
			throw new ProjectionConflictError();
		}
		if (
			input.expect?.hash !== undefined &&
			input.expect.hash !== current.workflow.hash
		) {
			throw new ProjectionConflictError();
		}
		const number = parseIssueNumber(id);
		if (input.title !== undefined || input.body !== undefined) {
			await this.api.updateIssue(number, {
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.body === undefined ? {} : { body: input.body }),
			});
		}
		if (input.workflow !== undefined) {
			const next = withHash({
				...current.workflow,
				...input.workflow,
				version: current.workflow.version + 1,
			});
			validateProjectionShape(id, next);
			await this.projectLabels(number, next);
			await this.upsertProjectionComment(
				number,
				metadataFromProjection(next, current.artifacts, current.changes),
			);
			const reread = await this.readProjectedIssue(id);
			if (!sameProjection(reread.workflow, next)) {
				throw needsReconciliation(
					id,
					"post-update projection verification failed",
				);
			}
			return reread;
		}
		return this.readProjectedIssue(id);
	}

	async appendLog(
		id: string,
		input: Omit<WorkflowLog, "sequence" | "issueId">,
	): Promise<WorkflowLog> {
		const number = parseIssueNumber(id);
		const logs = await this.readLogs(id);
		const log = cloneJson({
			...input,
			issueId: id,
			sequence: logs.length + 1,
		}) as WorkflowLog;
		await this.api.createComment(
			number,
			machineComment(logMarker(this.manifest), log),
		);
		const reread = await this.readLogs(id);
		const appended = reread.at(-1);
		if (appended === undefined || !sameJson(appended, log)) {
			throw needsReconciliation(id, "post-log projection verification failed");
		}
		return appended;
	}

	async readLogs(id: string): Promise<Array<WorkflowLog>> {
		const comments = await this.api.listComments(parseIssueNumber(id));
		return comments
			.map((comment) =>
				parseMachineComment(comment.body, logMarker(this.manifest)),
			)
			.filter((value): value is WorkflowLog => value !== undefined)
			.map((value, index) => {
				if (
					!isWorkflowLog(value) ||
					value.issueId !== id ||
					value.sequence !== index + 1
				) {
					throw needsReconciliation(id, "workflow log comment is corrupt");
				}
				return value;
			});
	}

	async inspectIssue(id: string): Promise<TrackerIssueInspection> {
		try {
			return {
				issue: await this.getIssue(id),
				logs: await this.readLogs(id),
				labels: (await this.requireGitHubIssue(id)).labels,
			};
		} catch (error) {
			return {
				logs: [],
				projectionError: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async addChild(parentId: string, childId: string): Promise<void> {
		await validateGitHubTrackerCapabilities(this.api);
		await this.api.addSubIssue(
			parseIssueNumber(parentId),
			parseIssueNumber(childId),
		);
	}

	async removeChild(parentId: string, childId: string): Promise<void> {
		await this.api.removeSubIssue(
			parseIssueNumber(parentId),
			parseIssueNumber(childId),
		);
	}

	async addDependency(issueId: string, blockedById: string): Promise<void> {
		await validateGitHubTrackerCapabilities(this.api);
		await this.api.addDependency(
			parseIssueNumber(issueId),
			parseIssueNumber(blockedById),
		);
	}

	async removeDependency(issueId: string, blockedById: string): Promise<void> {
		await this.api.removeDependency(
			parseIssueNumber(issueId),
			parseIssueNumber(blockedById),
		);
	}

	async deleteIssue(id: string): Promise<void> {
		if (this.api.deleteIssue === undefined) {
			throw new CorruptWorkflowProjectionError(
				"GitHub issue deletion is unavailable.",
			);
		}
		await this.api.deleteIssue(parseIssueNumber(id));
	}

	async registerArtifact(
		issueId: string,
		input: WorkflowArtifactInput,
	): Promise<WorkflowArtifact> {
		const issue = await this.readProjectedIssue(issueId);
		const artifact = normalizeWorkflowArtifactInput(
			input,
			input.id ?? `artifact-${issue.artifacts.length + 1}`,
		);
		await this.upsertProjectionComment(
			parseIssueNumber(issueId),
			metadataFromProjection(
				issue.workflow,
				[...issue.artifacts, artifact],
				issue.changes,
			),
		);
		const reread = await this.readProjectedIssue(issueId);
		if (!reread.artifacts.some((candidate) => sameJson(candidate, artifact))) {
			throw needsReconciliation(
				issueId,
				"post-artifact projection verification failed",
			);
		}
		return artifact;
	}

	async registerChange(
		issueId: string,
		input: Omit<WorkflowChange, "id">,
	): Promise<WorkflowChange> {
		validatePullRequestArtifact(input.kind, input.uri);
		const issue = await this.readProjectedIssue(issueId);
		const change = { id: `change-${issue.changes.length + 1}`, ...input };
		await this.upsertProjectionComment(
			parseIssueNumber(issueId),
			metadataFromProjection(issue.workflow, issue.artifacts, [
				...issue.changes,
				change,
			]),
		);
		const reread = await this.readProjectedIssue(issueId);
		if (!reread.changes.some((candidate) => sameJson(candidate, change))) {
			throw needsReconciliation(
				issueId,
				"post-change projection verification failed",
			);
		}
		return change;
	}

	private async readProjectedIssue(
		id: string,
		known?: GitHubTrackerIssue,
	): Promise<WorkflowIssue> {
		const issue = known ?? (await this.requireGitHubIssue(id));
		const metadata = await this.readProjectionMetadata(issue.number);
		const labels = projectionFromLabels(
			this.manifest,
			issue.number,
			issue.labels,
		);
		const workflow = withHash({ ...metadata.workflow, ...labels });
		if (!sameProjection(workflow, metadata.workflow)) {
			throw needsReconciliation(
				String(issue.number),
				"labels and metadata disagree",
			);
		}
		return {
			id: String(issue.number),
			title: issue.title,
			...(issue.body === undefined || issue.body === null
				? {}
				: { body: issue.body }),
			workflow,
			relationships: normalizeRelationships(
				await this.api.readRelationships(issue.number),
			),
			artifacts: metadata.artifacts,
			changes: metadata.changes,
		};
	}

	private async requireGitHubIssue(id: string): Promise<GitHubTrackerIssue> {
		const issue = await this.api.getIssue(parseIssueNumber(id));
		if (issue === undefined) {
			throw new IssueNotFoundError(id);
		}
		return issue;
	}

	private async readProjectionMetadata(
		number: number,
	): Promise<ProjectionMetadata> {
		const matches = (await this.api.listComments(number))
			.map((comment) =>
				parseMachineComment(comment.body, projectionMarker(this.manifest)),
			)
			.filter((value): value is ProjectionMetadata => value !== undefined);
		if (matches.length !== 1 || !isProjectionMetadata(matches[0])) {
			throw needsReconciliation(
				String(number),
				"projection metadata comment is missing, duplicated, or corrupt",
			);
		}
		return matches[0];
	}

	private async upsertProjectionComment(
		number: number,
		metadata: ProjectionMetadata,
	): Promise<void> {
		const marker = projectionMarker(this.manifest);
		const comments = await this.api.listComments(number);
		const matches = comments.filter(
			(comment) => parseMachineComment(comment.body, marker) !== undefined,
		);
		if (matches.length > 1) {
			throw needsReconciliation(
				String(number),
				"projection metadata comment is duplicated",
			);
		}
		const body = machineComment(marker, metadata);
		if (matches.length === 0) {
			await this.api.createComment(number, body);
			return;
		}
		if (matches[0]?.body !== body) {
			await this.api.updateComment(matches[0].id, body);
		}
	}

	private async projectLabels(
		number: number,
		next: WorkflowProjection,
	): Promise<void> {
		const actualLabels = new Set(
			(await this.requireGitHubIssue(String(number))).labels,
		);
		const nextLabels = new Set(labelsForProjection(this.manifest, next));
		for (const label of actualLabels) {
			if (
				isWorkflowProjectionLabel(this.manifest, label) &&
				!nextLabels.has(label)
			) {
				await this.api.removeLabel(number, label);
			}
		}
		const add = [...nextLabels].filter((label) => !actualLabels.has(label));
		if (add.length > 0) {
			await this.api.addLabels(number, add);
		}
	}

	private async verifyChild(
		parentId: string,
		childId: string,
		expected: boolean,
	): Promise<void> {
		const [parent, child] = await Promise.all([
			this.getIssue(parentId),
			this.getIssue(childId),
		]);
		const present =
			parent.relationships.children.includes(childId) &&
			child.relationships.parent === parentId;
		if (present !== expected) {
			throw needsReconciliation(
				parentId,
				`child relationship to '${childId}' could not be verified`,
			);
		}
	}

	private async verifyDependency(
		issueId: string,
		blockedById: string,
		expected: boolean,
	): Promise<void> {
		const [issue, blocker] = await Promise.all([
			this.getIssue(issueId),
			this.getIssue(blockedById),
		]);
		const present =
			issue.relationships.dependencies.includes(blockedById) &&
			blocker.relationships.dependents.includes(issueId);
		if (present !== expected) {
			throw needsReconciliation(
				issueId,
				`dependency relationship to '${blockedById}' could not be verified`,
			);
		}
	}

	private async verifyPlanApplication(
		specId: string,
		tickets: Array<{ key: string; id: string }>,
		inputs: TrackerApplyPlanIntent["tickets"],
	): Promise<void> {
		const spec = await this.getIssue(specId);
		for (const ticket of tickets) {
			if (!spec.relationships.children.includes(ticket.id)) {
				throw needsReconciliation(
					specId,
					"plan child relationships could not be verified",
				);
			}
		}
		const idsByKey = new Map(tickets.map((ticket) => [ticket.key, ticket.id]));
		for (const input of inputs) {
			const issueId = idsByKey.get(input.key);
			if (issueId === undefined) {
				throw needsReconciliation(
					specId,
					"plan ticket creation could not be verified",
				);
			}
			const issue = await this.getIssue(issueId);
			for (const dependencyKey of input.dependsOn ?? []) {
				const blockedById = idsByKey.get(dependencyKey);
				if (
					blockedById === undefined ||
					!issue.relationships.dependencies.includes(blockedById)
				) {
					throw needsReconciliation(
						specId,
						"plan dependency relationships could not be verified",
					);
				}
			}
		}
	}
}
