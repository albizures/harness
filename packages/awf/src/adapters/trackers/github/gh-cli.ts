import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	GitHubComment,
	GitHubTrackerApi,
	GitHubTrackerCapabilities,
	GitHubTrackerIssue,
} from "./index.ts";
import { isRecord } from "./helpers.ts";
import {
	IssueNotFoundError,
	type IssueRelationships,
} from "../../../domain/workflow/issue.ts";

const execFileAsync = promisify(execFile);
const BYTES_PER_KIB = 1024;
const GH_API_MAX_BUFFER_MIB = 10;
const GH_API_MAX_BUFFER_BYTES =
	GH_API_MAX_BUFFER_MIB * BYTES_PER_KIB * BYTES_PER_KIB;

type GhApiTransport = (
	method: string,
	path: string,
	args?: Array<string>,
) => Promise<unknown>;

export class GhCliGitHubTrackerApi implements GitHubTrackerApi {
	private readonly owner: string;
	private readonly repo: string;
	private readonly transport?: GhApiTransport;

	constructor(owner: string, repo: string, transport?: GhApiTransport) {
		this.owner = owner;
		this.repo = repo;
		this.transport = transport;
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
		number: number,
	): Promise<Partial<IssueRelationships>> {
		const [issue, subIssues, blockedBy, blocking] = await Promise.all([
			this.api<Record<string, unknown>>(
				"GET",
				`repos/${this.owner}/${this.repo}/issues/${number}`,
			),
			this.api<Array<Record<string, unknown>>>(
				"GET",
				`repos/${this.owner}/${this.repo}/issues/${number}/sub_issues`,
			),
			this.api<Array<Record<string, unknown>>>(
				"GET",
				`repos/${this.owner}/${this.repo}/issues/${number}/dependencies/blocked_by`,
			),
			this.api<Array<Record<string, unknown>>>(
				"GET",
				`repos/${this.owner}/${this.repo}/issues/${number}/dependencies/blocking`,
			),
		]);
		const parentNumber = relatedIssueNumber(issue.parent_issue ?? issue.parent);
		return {
			...(parentNumber === undefined ? {} : { parent: String(parentNumber) }),
			children: relatedIssueNumbers(subIssues),
			dependencies: relatedIssueNumbers(blockedBy),
			dependents: relatedIssueNumbers(blocking),
		};
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
		if (this.transport !== undefined) {
			return (await this.transport(method, path, args)) as T;
		}
		const { stdout } = await execFileAsync(
			"gh",
			["api", "--method", method, path, ...args],
			{ maxBuffer: GH_API_MAX_BUFFER_BYTES },
		);
		return JSON.parse(stdout) as T;
	}
}

function relatedIssueNumbers(
	issues: Array<Record<string, unknown>>,
): Array<string> {
	return issues.flatMap((issue) => {
		const number = relatedIssueNumber(issue);
		return number === undefined ? [] : [String(number)];
	});
}

function relatedIssueNumber(issue: unknown): number | undefined {
	if (!isRecord(issue)) {
		return undefined;
	}
	const number = Number(issue.number);
	return Number.isInteger(number) && number > 0 ? number : undefined;
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
