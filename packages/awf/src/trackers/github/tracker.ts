import type { WorkflowManifest } from "../../manifest/manifest.ts";
import type { TrackerIssueInspection, TrackerLog } from "../../tracker.ts";
import {
	type CreateIssueInput,
	IssueNotFoundError,
	type UpdateIssueInput,
	type WorkflowIssue,
} from "../../workflow/issue.ts";
import type { WorkflowLog } from "../../workflow/log.ts";
import {
	CorruptWorkflowProjectionError,
	ProjectionConflictError,
	type WorkflowProjection,
} from "../../workflow/projection.ts";
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
	needsReconciliation,
	validateGitHubTrackerCapabilities,
	validateProjectionShape,
	sameJson,
	cloneJson,
	type ProjectionMetadata,
} from "./helpers.ts";

export class GitHubTracker {
	readonly verification;
	private readonly api: GitHubTrackerApi;
	private readonly manifest: WorkflowManifest;

	constructor(api: GitHubTrackerApi, manifest: WorkflowManifest) {
		this.api = api;
		this.manifest = manifest;
		this.verification = {
			verifyChild: (parentId: string, childId: string, expected: boolean) =>
				this.verifyChild(parentId, childId, expected),
			verifyDependency: (
				issueId: string,
				blockedById: string,
				expected: boolean,
			) => this.verifyDependency(issueId, blockedById, expected),
		};
	}

	async createIssue(input: CreateIssueInput): Promise<WorkflowIssue> {
		await validateGitHubTrackerCapabilities(this.api);
		const projection = withHash({
			...input.workflow,
			version: input.workflow.version ?? 1,
		});
		const labels = labelsForProjection(this.manifest, projection);
		const metadata = metadataFromProjection(projection, {
			generatedBy: input.relationships?.generatedBy,
		});
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
				metadataFromProjection(next, {
					generatedBy: current.relationships.generatedBy,
				}),
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

	async appendLog(id: string, input: TrackerLog): Promise<WorkflowLog> {
		const number = parseIssueNumber(id);
		const logs = await this.readLogs(id);
		const log = cloneJson({
			...input,
			...(input.message === undefined ? {} : { message: input.message }),
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
			relationships: normalizeRelationships({
				...(await this.api.readRelationships(issue.number)),
				...metadata.relationships,
			}),
		} as WorkflowIssue;
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
}
