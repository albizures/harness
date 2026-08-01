import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowManifest } from "./manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	ProjectionConflictError,
	type CreateIssueInput,
	type IssueRelationships,
	type Tracker,
	type TrackerIssueInspection,
	type UpdateIssueInput,
	type WorkflowArtifact,
	type WorkflowChange,
	type WorkflowIssue,
	type WorkflowLog,
	type WorkflowProjection,
} from "./tracker.ts";

const execFileAsync = promisify(execFile);
const PROJECTION_SCHEMA_VERSION = 1;
const BYTES_PER_KIB = 1024;
const GH_API_MAX_BUFFER_MIB = 10;
const GH_API_MAX_BUFFER_BYTES =
	GH_API_MAX_BUFFER_MIB * BYTES_PER_KIB * BYTES_PER_KIB;

type GitHubComment = {
	id: string | number;
	body: string;
};

export type GitHubTrackerIssue = {
	number: number;
	id?: string | number;
	title: string;
	body?: string | null;
	labels: Array<string>;
	state?: string;
};

export type GitHubTrackerCapabilities = {
	subIssues: boolean;
	dependencies: boolean;
};

export type GitHubTrackerApi = {
	capabilities: () => Promise<GitHubTrackerCapabilities>;
	createIssue: (input: {
		title: string;
		body?: string;
		labels: Array<string>;
	}) => Promise<GitHubTrackerIssue>;
	getIssue: (number: number) => Promise<GitHubTrackerIssue | undefined>;
	listIssues: () => Promise<Array<GitHubTrackerIssue>>;
	updateIssue: (
		number: number,
		input: { title?: string; body?: string },
	) => Promise<void>;
	addLabels: (number: number, labels: Array<string>) => Promise<void>;
	removeLabel: (number: number, label: string) => Promise<void>;
	listComments: (number: number) => Promise<Array<GitHubComment>>;
	createComment: (number: number, body: string) => Promise<GitHubComment>;
	updateComment: (commentId: string | number, body: string) => Promise<void>;
	addSubIssue: (parentNumber: number, childNumber: number) => Promise<void>;
	removeSubIssue: (parentNumber: number, childNumber: number) => Promise<void>;
	addDependency: (
		issueNumber: number,
		blockedByNumber: number,
	) => Promise<void>;
	removeDependency: (
		issueNumber: number,
		blockedByNumber: number,
	) => Promise<void>;
	readRelationships: (number: number) => Promise<Partial<IssueRelationships>>;
	deleteIssue?: (number: number) => Promise<void>;
};

export type CreateGitHubTrackerOptions = {
	api: GitHubTrackerApi;
	manifest: WorkflowManifest;
};

export async function validateGitHubTrackerCapabilities(
	api: GitHubTrackerApi,
): Promise<void> {
	const capabilities = await api.capabilities();
	const missing = [
		...(capabilities.subIssues ? [] : ["native GitHub sub-issues"]),
		...(capabilities.dependencies ? [] : ["native GitHub issue dependencies"]),
	];
	if (missing.length > 0) {
		throw new CorruptWorkflowProjectionError(
			`GitHub tracker adapter requires ${missing.join(" and ")}.`,
		);
	}
}

export function createGitHubTracker({
	api,
	manifest,
}: CreateGitHubTrackerOptions): Tracker {
	return new GitHubTracker(api, manifest);
}

export function createGhCliGitHubTracker(options: {
	owner: string;
	repo: string;
	manifest: WorkflowManifest;
}): Tracker {
	return createGitHubTracker({
		manifest: options.manifest,
		api: new GhCliGitHubTrackerApi(options.owner, options.repo),
	});
}

class GitHubTracker implements Tracker {
	private readonly api: GitHubTrackerApi;
	private readonly manifest: WorkflowManifest;

	constructor(api: GitHubTrackerApi, manifest: WorkflowManifest) {
		this.api = api;
		this.manifest = manifest;
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
			await this.projectLabels(number, current.workflow, next);
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
		input: Omit<WorkflowArtifact, "id">,
	): Promise<WorkflowArtifact> {
		validatePullRequestArtifact(input.kind, input.uri);
		const issue = await this.readProjectedIssue(issueId);
		const artifact = { id: `artifact-${issue.artifacts.length + 1}`, ...input };
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
		current: WorkflowProjection,
		next: WorkflowProjection,
	): Promise<void> {
		const currentLabels = new Set(labelsForProjection(this.manifest, current));
		const nextLabels = new Set(labelsForProjection(this.manifest, next));
		for (const label of currentLabels) {
			if (!nextLabels.has(label)) {
				await this.api.removeLabel(number, label);
			}
		}
		const add = [...nextLabels].filter((label) => !currentLabels.has(label));
		if (add.length > 0) {
			await this.api.addLabels(number, add);
		}
	}
}

type ProjectionMetadata = {
	schemaVersion: number;
	workflow: WorkflowProjection;
	artifacts: Array<WorkflowArtifact>;
	changes: Array<WorkflowChange>;
};

function hasWorkflowProjectionLabels(
	manifest: WorkflowManifest,
	labels: Array<string>,
): boolean {
	return labels.some(
		(label) =>
			manifest.kinds.some((kind) => kind.label === label) ||
			label.startsWith(`awf:${manifest.workflow.id}:`),
	);
}

function labelsForProjection(
	manifest: WorkflowManifest,
	projection: WorkflowProjection,
): Array<string> {
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === projection.kind,
	);
	if (kind === undefined) {
		throw new CorruptWorkflowProjectionError(
			`Unknown workflow kind '${projection.kind}'.`,
		);
	}
	return [
		kind.label,
		labelFor(manifest, "state", projection.state),
		labelFor(manifest, "action", projection.action),
		...(projection.reason === undefined
			? []
			: [labelFor(manifest, "reason", projection.reason)]),
	];
}

function projectionFromLabels(
	manifest: WorkflowManifest,
	number: number,
	labels: Array<string>,
): Pick<WorkflowProjection, "kind" | "state" | "action" | "reason"> {
	const kindLabels = manifest.kinds.filter((kind) =>
		labels.includes(kind.label),
	);
	if (kindLabels.length !== 1) {
		throw needsReconciliation(
			String(number),
			"issue must have exactly one workflow kind label",
		);
	}
	return {
		kind: kindLabels[0]?.id ?? "",
		state: readSingleReservedLabel(manifest, labels, "state", number),
		action: readSingleReservedLabel(manifest, labels, "action", number),
		reason: readOptionalReservedLabel(manifest, labels, "reason", number),
	};
}

function readSingleReservedLabel(
	manifest: WorkflowManifest,
	labels: Array<string>,
	field: "state" | "action",
	number: number,
): string {
	const values = valuesForReservedLabel(manifest, labels, field);
	if (values.length !== 1 || values[0] === "") {
		throw needsReconciliation(
			String(number),
			`issue must have exactly one ${field} workflow label`,
		);
	}
	return values[0] ?? "";
}

function readOptionalReservedLabel(
	manifest: WorkflowManifest,
	labels: Array<string>,
	field: "reason",
	number: number,
): string | undefined {
	const values = valuesForReservedLabel(manifest, labels, field);
	if (values.length > 1 || values.some((value) => value === "")) {
		throw needsReconciliation(
			String(number),
			`issue has corrupt ${field} workflow labels`,
		);
	}
	return values[0];
}

function valuesForReservedLabel(
	manifest: WorkflowManifest,
	labels: Array<string>,
	field: "state" | "action" | "reason",
): Array<string> {
	const prefix = reservedPrefix(manifest, field);
	return labels
		.filter((label) => label.startsWith(prefix))
		.map((label) => label.slice(prefix.length));
}

function labelFor(
	manifest: WorkflowManifest,
	field: "state" | "action" | "reason",
	value: string,
): string {
	return `${reservedPrefix(manifest, field)}${value}`;
}

function reservedPrefix(
	manifest: WorkflowManifest,
	field: "state" | "action" | "reason",
): string {
	return `awf:${manifest.workflow.id}:${field}:`;
}

function projectionMarker(manifest: WorkflowManifest): string {
	return `awf:${manifest.workflow.id}:projection`;
}

function logMarker(manifest: WorkflowManifest): string {
	return `awf:${manifest.workflow.id}:log`;
}

function machineComment(marker: string, payload: unknown): string {
	return `<!-- ${marker}\n${stableStringify(payload)}\n-->`;
}

function parseMachineComment(
	body: string,
	marker: string,
): unknown | undefined {
	const trimmed = body.trim();
	const prefix = `<!-- ${marker}\n`;
	if (!trimmed.startsWith(prefix)) {
		return undefined;
	}
	if (!trimmed.endsWith("\n-->")) {
		throw new CorruptWorkflowProjectionError(
			"NEED_RECONCILIATION: malformed machine comment marker.",
		);
	}
	const json = trimmed.slice(prefix.length, -"\n-->".length);
	try {
		return JSON.parse(json) as unknown;
	} catch {
		throw new CorruptWorkflowProjectionError(
			"NEED_RECONCILIATION: malformed machine comment JSON.",
		);
	}
}

function metadataFromProjection(
	workflow: WorkflowProjection,
	artifacts: Array<WorkflowArtifact>,
	changes: Array<WorkflowChange>,
): ProjectionMetadata {
	return {
		schemaVersion: PROJECTION_SCHEMA_VERSION,
		workflow,
		artifacts: cloneJson(artifacts) as Array<WorkflowArtifact>,
		changes: cloneJson(changes) as Array<WorkflowChange>,
	};
}

function isProjectionMetadata(value: unknown): value is ProjectionMetadata {
	if (!isRecord(value) || !isRecord(value.workflow)) {
		return false;
	}
	return (
		value.schemaVersion === PROJECTION_SCHEMA_VERSION &&
		isProjection(value.workflow) &&
		Array.isArray(value.artifacts) &&
		Array.isArray(value.changes)
	);
}

function isProjection(value: unknown): value is WorkflowProjection {
	return (
		isRecord(value) &&
		typeof value.kind === "string" &&
		typeof value.state === "string" &&
		typeof value.action === "string" &&
		(value.reason === undefined || typeof value.reason === "string") &&
		(value.activeRunId === undefined ||
			typeof value.activeRunId === "string") &&
		typeof value.version === "number" &&
		typeof value.hash === "string"
	);
}

function isWorkflowLog(value: unknown): value is WorkflowLog {
	return (
		isRecord(value) &&
		typeof value.sequence === "number" &&
		typeof value.issueId === "string" &&
		typeof value.type === "string" &&
		(value.runId === undefined || typeof value.runId === "string")
	);
}

function validateProjectionShape(
	id: string,
	projection: WorkflowProjection,
): void {
	for (const field of ["kind", "state", "action"] as const) {
		if (projection[field] === "") {
			throw needsReconciliation(id, `malformed ${field} projection data`);
		}
	}
	if (projection.reason === "" || projection.activeRunId === "") {
		throw needsReconciliation(id, "malformed optional projection data");
	}
}

function withHash(
	projection: Omit<WorkflowProjection, "hash"> | WorkflowProjection,
): WorkflowProjection {
	const { hash: _hash, ...withoutHash } = projection as WorkflowProjection;
	return { ...withoutHash, hash: hashProjection(withoutHash) };
}

function hashProjection(projection: Omit<WorkflowProjection, "hash">): string {
	return createHash("sha256").update(stableStringify(projection)).digest("hex");
}

function sameProjection(
	left: WorkflowProjection,
	right: WorkflowProjection,
): boolean {
	return stableStringify(left) === stableStringify(right);
}

function sameJson(left: unknown, right: unknown): boolean {
	return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeRelationships(
	relationships: Partial<IssueRelationships>,
): IssueRelationships {
	return {
		...(relationships.parent === undefined
			? {}
			: { parent: relationships.parent }),
		children: [...(relationships.children ?? [])],
		dependencies: [...(relationships.dependencies ?? [])],
		dependents: [...(relationships.dependents ?? [])],
	};
}

function parseIssueNumber(id: string): number {
	const number = Number(id);
	if (!Number.isInteger(number) || number < 1) {
		throw new IssueNotFoundError(id);
	}
	return number;
}

function validatePullRequestArtifact(kind: string, uri: string): void {
	if (
		kind === "pull-request" &&
		!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u.test(uri)
	) {
		throw new CorruptWorkflowProjectionError(
			"Pull request artifact must be a GitHub pull request URL.",
		);
	}
}

function needsReconciliation(
	id: string,
	reason: string,
): CorruptWorkflowProjectionError {
	return new CorruptWorkflowProjectionError(
		`NEED_RECONCILIATION: Issue '${id}' ${reason}.`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

class GhCliGitHubTrackerApi implements GitHubTrackerApi {
	private readonly owner: string;
	private readonly repo: string;

	constructor(owner: string, repo: string) {
		this.owner = owner;
		this.repo = repo;
	}

	async capabilities(): Promise<GitHubTrackerCapabilities> {
		return { subIssues: true, dependencies: true };
	}

	async createIssue(input: {
		title: string;
		body?: string;
		labels: Array<string>;
	}): Promise<GitHubTrackerIssue> {
		const fields = ["-f", `title=${input.title}`];
		if (input.body !== undefined) {
			fields.push("-f", `body=${input.body}`);
		}
		for (const label of input.labels) {
			fields.push("-f", `labels[]=${label}`);
		}
		return this.api<GitHubTrackerIssue>(
			"POST",
			`repos/${this.owner}/${this.repo}/issues`,
			fields,
		);
	}

	async getIssue(number: number): Promise<GitHubTrackerIssue | undefined> {
		try {
			const issue = await this.api<Record<string, unknown>>(
				"GET",
				`repos/${this.owner}/${this.repo}/issues/${number}`,
			);
			return normalizeGhIssue(issue);
		} catch {
			return undefined;
		}
	}

	async listIssues(): Promise<Array<GitHubTrackerIssue>> {
		const issues = await this.api<Array<Record<string, unknown>>>(
			"GET",
			`repos/${this.owner}/${this.repo}/issues`,
			["-f", "state=all"],
		);
		return issues.map(normalizeGhIssue);
	}

	async updateIssue(
		number: number,
		input: { title?: string; body?: string },
	): Promise<void> {
		const fields: Array<string> = [];
		if (input.title !== undefined) {
			fields.push("-f", `title=${input.title}`);
		}
		if (input.body !== undefined) {
			fields.push("-f", `body=${input.body}`);
		}
		await this.api(
			"PATCH",
			`repos/${this.owner}/${this.repo}/issues/${number}`,
			fields,
		);
	}

	async addLabels(number: number, labels: Array<string>): Promise<void> {
		await this.api(
			"POST",
			`repos/${this.owner}/${this.repo}/issues/${number}/labels`,
			labels.flatMap((label) => ["-f", `labels[]=${label}`]),
		);
	}

	async removeLabel(number: number, label: string): Promise<void> {
		await this.api(
			"DELETE",
			`repos/${this.owner}/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
		);
	}

	async listComments(number: number): Promise<Array<GitHubComment>> {
		return this.api<Array<GitHubComment>>(
			"GET",
			`repos/${this.owner}/${this.repo}/issues/${number}/comments`,
		);
	}

	async createComment(number: number, body: string): Promise<GitHubComment> {
		return this.api<GitHubComment>(
			"POST",
			`repos/${this.owner}/${this.repo}/issues/${number}/comments`,
			["-f", `body=${body}`],
		);
	}

	async updateComment(commentId: string | number, body: string): Promise<void> {
		await this.api(
			"PATCH",
			`repos/${this.owner}/${this.repo}/issues/comments/${commentId}`,
			["-f", `body=${body}`],
		);
	}

	async addSubIssue(parentNumber: number, childNumber: number): Promise<void> {
		const child = await this.requireIssue(childNumber);
		await this.api(
			"POST",
			`repos/${this.owner}/${this.repo}/issues/${parentNumber}/sub_issues`,
			["-F", `sub_issue_id=${child.id}`],
		);
	}

	async removeSubIssue(
		parentNumber: number,
		childNumber: number,
	): Promise<void> {
		const child = await this.requireIssue(childNumber);
		await this.api(
			"DELETE",
			`repos/${this.owner}/${this.repo}/issues/${parentNumber}/sub_issues/${child.id}`,
		);
	}

	async addDependency(
		issueNumber: number,
		blockedByNumber: number,
	): Promise<void> {
		const blocker = await this.requireIssue(blockedByNumber);
		await this.api(
			"POST",
			`repos/${this.owner}/${this.repo}/issues/${issueNumber}/dependencies/blocked_by`,
			["-F", `issue_id=${blocker.id}`],
		);
	}

	async removeDependency(
		issueNumber: number,
		blockedByNumber: number,
	): Promise<void> {
		const blocker = await this.requireIssue(blockedByNumber);
		await this.api(
			"DELETE",
			`repos/${this.owner}/${this.repo}/issues/${issueNumber}/dependencies/blocked_by/${blocker.id}`,
		);
	}

	async readRelationships(
		_number: number,
	): Promise<Partial<IssueRelationships>> {
		return {};
	}

	private async requireIssue(number: number): Promise<GitHubTrackerIssue> {
		const issue = await this.getIssue(number);
		if (issue === undefined) {
			throw new IssueNotFoundError(String(number));
		}
		return issue;
	}

	private async api<T = unknown>(
		method: string,
		path: string,
		args: Array<string> = [],
	): Promise<T> {
		const { stdout } = await execFileAsync(
			"gh",
			["api", "--method", method, path, ...args],
			{ maxBuffer: GH_API_MAX_BUFFER_BYTES },
		);
		return JSON.parse(stdout) as T;
	}
}

function normalizeGhIssue(issue: Record<string, unknown>): GitHubTrackerIssue {
	const labels = Array.isArray(issue.labels)
		? issue.labels.map((label) =>
				isRecord(label) ? String(label.name) : String(label),
			)
		: [];
	return {
		number: Number(issue.number),
		id:
			typeof issue.id === "string" || typeof issue.id === "number"
				? issue.id
				: undefined,
		title: String(issue.title),
		body: typeof issue.body === "string" ? issue.body : undefined,
		labels,
		state: typeof issue.state === "string" ? issue.state : undefined,
	};
}
