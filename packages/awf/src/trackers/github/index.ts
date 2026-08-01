import type { WorkflowManifest } from "../../manifest.ts";
import type { IssueRelationships, Tracker, TrackerAdapter } from "../../tracker.ts";
import { GhCliGitHubTrackerApi } from "./gh-cli.ts";
import { validateGitHubTrackerCapabilities } from "./helpers.ts";
import { GitHubTracker } from "./tracker.ts";

export type GitHubComment = {
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

export function createGitHubTracker({
	api,
	manifest,
}: CreateGitHubTrackerOptions): TrackerAdapter {
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

export { GhCliGitHubTrackerApi, GitHubTracker, validateGitHubTrackerCapabilities };
