import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "./commands.ts";
import { defaultManifest } from "./default-manifest.ts";
import {
	createGitHubTracker,
	validateGitHubTrackerCapabilities,
	type GitHubTrackerApi,
	type GitHubTrackerIssue,
} from "./trackers/github/index.ts";
import { CorruptWorkflowProjectionError } from "./tracker.ts";

const PROJECT_COMMENT_AND_TWO_LOGS = 3;

test("projects workflow fields to reserved GitHub labels and singleton metadata", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });

	const issue = await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	assert.deepEqual(api.issue(1).labels.sort(), [
		"awf:agent-development:action:implement",
		"awf:agent-development:kind:ticket",
		"awf:agent-development:state:ready",
	]);
	assert.equal(api.issue(1).comments.length, 1);
	assert.ok(
		api
			.issue(1)
			.comments[0]?.body.startsWith(
				'<!-- awf:current v1 agent-development -->\n{"artifacts":[],',
			),
	);
	assert.equal(issue.workflow.kind, "ticket");
	assert.equal(issue.workflow.version, 1);

	await tracker.updateIssue(issue.id, {
		expect: { hash: issue.workflow.hash },
		workflow: { state: "running", activeRunId: "run-1" },
	});

	assert.deepEqual(api.issue(1).labels.sort(), [
		"awf:agent-development:action:implement",
		"awf:agent-development:kind:ticket",
		"awf:agent-development:state:running",
	]);
	assert.equal(api.issue(1).comments.length, 1);
	assert.ok(
		api
			.issue(1)
			.comments[0]?.body.startsWith(
				'<!-- awf:current v1 agent-development -->\n{"artifacts":[],',
			),
	);
	const updated = await tracker.getIssue("1");
	assert.equal(updated.workflow.activeRunId, "run-1");
	assert.equal(updated.workflow.version, 2);
});

test("projects optional reasons and removes stale canonical labels on update", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });

	const issue = await tracker.createIssue({
		title: "Blocked ticket",
		workflow: {
			kind: "ticket",
			state: "need-human",
			action: "none",
			reason: "dependencies",
		},
	});

	assert.deepEqual(api.issue(1).labels.sort(), [
		"awf:agent-development:action:none",
		"awf:agent-development:kind:ticket",
		"awf:agent-development:reason:dependencies",
		"awf:agent-development:state:need-human",
	]);

	await tracker.updateIssue(issue.id, {
		expect: { hash: issue.workflow.hash },
		workflow: {
			kind: "spec",
			state: "ready",
			action: "plan",
			reason: undefined,
		},
	});

	assert.deepEqual(api.issue(1).labels.sort(), [
		"awf:agent-development:action:plan",
		"awf:agent-development:kind:spec",
		"awf:agent-development:state:ready",
	]);
});

test("listIssues requires reconciliation for malformed reserved GitHub labels", async () => {
	const api = createMockGitHubApi();
	await api.createIssue({
		title: "Reserved but malformed workflow label",
		labels: ["awf:agent-development"],
	});
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Workflow issue",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await assert.rejects(tracker.listIssues(), /NEED_RECONCILIATION/);
});

test("appends logs as strict machine comments", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	const issue = await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await tracker.appendLog(issue.id, { type: "started", runId: "run-1" });
	await tracker.appendLog(issue.id, {
		type: "succeeded",
		payload: { ok: true },
	});

	assert.equal(api.issue(1).comments.length, PROJECT_COMMENT_AND_TWO_LOGS);
	assert.equal(
		api.issue(1).comments[1]?.body,
		'<!-- awf:log v1 agent-development -->\n{"issueId":"1","runId":"run-1","sequence":1,"type":"started"}',
	);
	assert.deepEqual(
		(await tracker.readLogs(issue.id)).map((log) => [log.sequence, log.type]),
		[
			[1, "started"],
			[2, "succeeded"],
		],
	);
});

test("uses native hierarchy and dependency capabilities", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Spec",
		workflow: { kind: "spec", state: "ready", action: "plan" },
	});
	await tracker.createIssue({
		title: "Ticket",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	await tracker.createIssue({
		title: "Blocker",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await tracker.addChild("1", "2");
	await tracker.addDependency("2", "3");

	assert.deepEqual((await tracker.getIssue("1")).relationships.children, ["2"]);
	assert.equal((await tracker.getIssue("2")).relationships.parent, "1");
	assert.deepEqual((await tracker.getIssue("2")).relationships.dependencies, [
		"3",
	]);
	assert.deepEqual((await tracker.getIssue("3")).relationships.dependents, [
		"2",
	]);
});

test("listIssues ignores unrelated GitHub issues without workflow projection labels", async () => {
	const api = createMockGitHubApi();
	await api.createIssue({ title: "Regular issue", labels: ["project:awf"] });
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Workflow issue",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	api.issue(1).comments.push({ id: 99, body: "Human note about awf labels" });

	assert.deepEqual(
		(await tracker.listIssues()).map((issue) => issue.id),
		["2"],
	);
});

test("capability validation fails when native issue relationships are unavailable", async () => {
	const api = createMockGitHubApi({
		capabilities: { subIssues: false, dependencies: true },
	});
	await assert.rejects(validateGitHubTrackerCapabilities(api), /sub-issues/);
});

test("manual reserved-label corruption requires reconciliation", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	api.issue(1).labels.push("awf:agent-development:state:running");

	await assert.rejects(
		tracker.getIssue("1"),
		(error: unknown) =>
			error instanceof CorruptWorkflowProjectionError &&
			error.message.includes("NEED_RECONCILIATION"),
	);
});

test("machine-comment corruption requires reconciliation", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	api.issue(1).comments[0].body =
		"<!-- awf:current v1 agent-development -->\nnot-json";

	await assert.rejects(tracker.getIssue("1"), /NEED_RECONCILIATION/);
});

test("malformed canonical and legacy workflow-owned machine comments require reconciliation", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	api.issue(1).comments.push({
		id: 100,
		body: "<!-- awf:log v2 agent-development -->\n{}",
	});
	await assert.rejects(tracker.readLogs("1"), /NEED_RECONCILIATION/);

	api.issue(1).comments[1].body = "<!-- awf:agent-development:log -->\n{}";
	await assert.rejects(tracker.readLogs("1"), /NEED_RECONCILIATION/);

	api.issue(1).comments[1].body = "<!-- awf:current v1 agent-development -->";
	await assert.rejects(tracker.getIssue("1"), /NEED_RECONCILIATION/);
});

test("machine-comment markers validate type version and workflow id", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	api.issue(1).comments[0].body =
		api
			.issue(1)
			.comments[0]?.body.replace(
				"<!-- awf:current v1 agent-development -->",
				"<!-- awf:log v1 agent-development -->",
			) ?? "";

	await assert.rejects(tracker.getIssue("1"), /NEED_RECONCILIATION/);

	api.issue(1).comments[0].body =
		api
			.issue(1)
			.comments[0]?.body.replace(
				"<!-- awf:log v1 agent-development -->",
				"<!-- awf:current v2 agent-development -->",
			) ?? "";

	await assert.rejects(tracker.getIssue("1"), /NEED_RECONCILIATION/);

	api.issue(1).comments[0].body =
		api
			.issue(1)
			.comments[0]?.body.replace(
				"<!-- awf:current v2 agent-development -->",
				"<!-- awf:current v1 other-workflow -->",
			) ?? "";

	await assert.rejects(tracker.getIssue("1"), /NEED_RECONCILIATION/);
});

test("registers and validates pull-request artifacts", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({ api, manifest: defaultManifest });
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "running", action: "implement" },
	});

	await assert.rejects(
		tracker.registerArtifact("1", { kind: "pull-request", uri: "not a pr" }),
		/Pull request artifact/,
	);
	await tracker.registerArtifact("1", {
		kind: "pull-request",
		uri: "https://github.com/albizures/harness/pull/1",
	});

	assert.equal(
		(await tracker.getIssue("1")).artifacts[0]?.kind,
		"pull-request",
	);
});

test("opt-in smoke: execute create/get/start/succeed/log against a real GitHub repository", {
	skip: process.env.AWF_GITHUB_SMOKE !== "1",
}, async () => {
	const repo = process.env.AWF_GITHUB_SMOKE_REPO;
	assert.ok(repo, "set AWF_GITHUB_SMOKE_REPO=owner/repo");
	// Documented fixture contract: point AWF_GITHUB_SMOKE_REPO at a disposable
	// repository with GitHub sub-issues/dependencies enabled and gh authenticated.
	// This path exercises the tracker through command semantics and verifies
	// machine labels/comments, not prose parsing. The default CI run skips it.
	const { createGhCliGitHubTracker } = await import(
		"./trackers/github/index.ts"
	);
	const [owner, name] = repo.split("/");
	assert.ok(owner);
	assert.ok(name);
	const tracker = createGhCliGitHubTracker({
		owner,
		repo: name,
		manifest: defaultManifest,
	});
	const created = await execute(["create", "spec", "--input", "-"], {
		tracker,
		stdin: "# Smoke spec\n",
	});
	assert.equal(created.ok, true);
	const createdData = created.data as { issue: { id: string } };
	const id = createdData.issue.id;
	assert.equal((await execute(["get", id], { tracker })).ok, true);
	const started = await execute(["start", id], { tracker });
	assert.equal(started.ok, true);
	const startedData = started.data as { run: { id: string } };
	const runId = startedData.run.id;
	assert.equal((await execute(["logs", id], { tracker })).ok, true);
	assert.equal(
		(
			await execute(["succeed", id, "--run", runId, "--input", "-"], {
				tracker,
				stdin: JSON.stringify({ tickets: [] }),
			})
		).ok,
		true,
	);
});

function createMockGitHubApi(
	options: {
		capabilities?: { subIssues: boolean; dependencies: boolean };
	} = {},
): GitHubTrackerApi & { issue: (number: number) => MockIssue } {
	const issues = new Map<number, MockIssue>();
	let nextIssue = 1;
	let nextComment = 1;
	const capabilities = options.capabilities ?? {
		subIssues: true,
		dependencies: true,
	};
	const requireIssue = (number: number): MockIssue => {
		const issue = issues.get(number);
		assert.ok(issue, `missing issue ${number}`);
		return issue;
	};
	return {
		issue: requireIssue,
		async capabilities() {
			return capabilities;
		},
		async createIssue(input) {
			const issue: MockIssue = {
				number: nextIssue++,
				id: `db-${nextIssue}`,
				title: input.title,
				body: input.body,
				labels: [...input.labels],
				comments: [],
				relationships: { children: [], dependencies: [], dependents: [] },
			};
			issues.set(issue.number, issue);
			return toGitHubIssue(issue);
		},
		async getIssue(number) {
			const issue = issues.get(number);
			return issue === undefined ? undefined : toGitHubIssue(issue);
		},
		async listIssues() {
			return [...issues.values()].map(toGitHubIssue);
		},
		async updateIssue(number, input) {
			const issue = requireIssue(number);
			if (input.title !== undefined) {
				issue.title = input.title;
			}
			if (input.body !== undefined) {
				issue.body = input.body;
			}
		},
		async addLabels(number, labels) {
			const issue = requireIssue(number);
			for (const label of labels) {
				if (!issue.labels.includes(label)) {
					issue.labels.push(label);
				}
			}
		},
		async removeLabel(number, label) {
			requireIssue(number).labels = requireIssue(number).labels.filter(
				(candidate) => candidate !== label,
			);
		},
		async listComments(number) {
			return requireIssue(number).comments.map((comment) => ({ ...comment }));
		},
		async createComment(number, body) {
			const comment = { id: nextComment++, body };
			requireIssue(number).comments.push(comment);
			return comment;
		},
		async updateComment(commentId, body) {
			for (const issue of issues.values()) {
				const comment = issue.comments.find(
					(candidate) => candidate.id === commentId,
				);
				if (comment !== undefined) {
					comment.body = body;
				}
			}
		},
		async addSubIssue(parentNumber, childNumber) {
			const parent = requireIssue(parentNumber);
			const child = requireIssue(childNumber);
			child.relationships.parent = String(parentNumber);
			pushUnique(parent.relationships.children, String(childNumber));
		},
		async removeSubIssue(parentNumber, childNumber) {
			const parent = requireIssue(parentNumber);
			const child = requireIssue(childNumber);
			parent.relationships.children = parent.relationships.children.filter(
				(id) => id !== String(childNumber),
			);
			if (child.relationships.parent === String(parentNumber)) {
				delete child.relationships.parent;
			}
		},
		async addDependency(issueNumber, blockedByNumber) {
			pushUnique(
				requireIssue(issueNumber).relationships.dependencies,
				String(blockedByNumber),
			);
			pushUnique(
				requireIssue(blockedByNumber).relationships.dependents,
				String(issueNumber),
			);
		},
		async removeDependency(issueNumber, blockedByNumber) {
			requireIssue(issueNumber).relationships.dependencies = requireIssue(
				issueNumber,
			).relationships.dependencies.filter(
				(id) => id !== String(blockedByNumber),
			);
			requireIssue(blockedByNumber).relationships.dependents = requireIssue(
				blockedByNumber,
			).relationships.dependents.filter((id) => id !== String(issueNumber));
		},
		async readRelationships(number) {
			return structuredClone(requireIssue(number).relationships);
		},
	};
}

type MockIssue = GitHubTrackerIssue & {
	comments: Array<{ id: number; body: string }>;
	relationships: {
		parent?: string;
		children: Array<string>;
		dependencies: Array<string>;
		dependents: Array<string>;
	};
};

function toGitHubIssue(issue: MockIssue): GitHubTrackerIssue {
	return {
		number: issue.number,
		id: issue.id,
		title: issue.title,
		body: issue.body,
		labels: [...issue.labels],
	};
}

function pushUnique(values: Array<string>, value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}
