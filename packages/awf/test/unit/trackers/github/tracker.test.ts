import { assert, expect, it } from "vitest";
import { execute } from "../../../../src/commands.ts";
import { agentDevelopmentManifest } from "../../../../src/workflows/agent-development/index.ts";
import { genericTaskManifest } from "../../../../src/workflows/generic-task/index.ts";
import {
	createGitHubTracker,
	validateGitHubTrackerCapabilities,
	type GitHubTrackerApi,
	type GitHubTrackerIssue,
} from "../../../../src/trackers/github/index.ts";
import { CorruptWorkflowProjectionError } from "../../../../src/workflow/projection.ts";

const PROJECT_COMMENT_AND_TWO_LOGS = 3;

it("should project workflow fields to reserved GitHub labels and singleton metadata", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});

	const issue = await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	expect(api.issue(1).labels.sort()).toEqual([
		"awf:agent-development:action:implement",
		"awf:agent-development:kind:ticket",
		"awf:agent-development:state:ready",
	]);
	expect(api.issue(1).comments.length).toBe(1);
	expect(
		api
			.issue(1)
			.comments[0]?.body.startsWith(
				'<!-- awf:current v1 agent-development -->\n{"schemaVersion":1,',
			),
	).toBeTruthy();
	expect(issue).not.toHaveProperty("artifacts");
	expect(issue).not.toHaveProperty("changes");
	expect(issue.workflow.kind).toBe("ticket");
	expect(issue.workflow.version).toBe(1);

	await tracker.updateIssue(issue.id, {
		expect: { hash: issue.workflow.hash },
		workflow: { state: "running", activeRunId: "run-1" },
	});

	expect(api.issue(1).labels.sort()).toEqual([
		"awf:agent-development:action:implement",
		"awf:agent-development:kind:ticket",
		"awf:agent-development:state:running",
	]);
	expect(api.issue(1).comments.length).toBe(1);
	expect(
		api
			.issue(1)
			.comments[0]?.body.startsWith(
				'<!-- awf:current v1 agent-development -->\n{"schemaVersion":1,',
			),
	).toBeTruthy();
	const updated = await tracker.getIssue("1");
	expect(updated.workflow.activeRunId).toBe("run-1");
	expect(updated.workflow.version).toBe(2);
});

it("should project Task subkind as metadata without masquerading as GitHub kind label", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: genericTaskManifest,
	});

	const issue = await tracker.createIssue({
		title: "Research task",
		workflow: {
			kind: "task",
			state: "ready",
			action: "work",
			data: { subkind: "research" },
		},
	});

	expect(api.issue(1).labels.sort()).toEqual([
		"awf:agent-workflow:action:work",
		"awf:agent-workflow:kind:task",
		"awf:agent-workflow:state:ready",
	]);
	expect(api.issue(1).labels).not.toContain("awf:agent-workflow:kind:research");
	expect(issue.workflow).toMatchObject({
		kind: "task",
		state: "ready",
		action: "work",
		data: { subkind: "research" },
	});
	expect((await tracker.getIssue(issue.id)).workflow.data).toEqual({
		subkind: "research",
	});
});

it("should project agent-workflow Spec create fields to reserved GitHub labels and log comments", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: genericTaskManifest,
	});

	const created = await execute(["create", "spec", "--input", "-"], {
		tracker,
		manifest: genericTaskManifest,
		stdin: JSON.stringify({
			title: "Generic Spec",
			body: "# Generic Spec\n\nWork this through the generic-task workflow.",
		}),
	});

	if (!created.ok) {
		throw new Error(JSON.stringify(created.error));
	}
	expect(api.issue(1).title).toBe("Generic Spec");
	expect(api.issue(1).body).toBe(
		"# Generic Spec\n\nWork this through the generic-task workflow.",
	);
	expect(api.issue(1).labels.sort()).toEqual([
		"awf:agent-workflow:action:planning",
		"awf:agent-workflow:kind:spec",
		"awf:agent-workflow:state:ready",
	]);
	expect(api.issue(1).comments.map((comment) => comment.body)).toEqual([
		expect.stringContaining("<!-- awf:current v1 agent-workflow -->"),
		expect.stringContaining("<!-- awf:log v1 agent-workflow -->"),
	]);
});

it("should project optional reasons and removes stale canonical labels on update", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});

	const issue = await tracker.createIssue({
		title: "Blocked ticket",
		workflow: {
			kind: "ticket",
			state: "need-human",
			action: "none",
			reason: "dependencies",
		},
	});

	expect(api.issue(1).labels.sort()).toEqual([
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

	expect(api.issue(1).labels.sort()).toEqual([
		"awf:agent-development:action:plan",
		"awf:agent-development:kind:spec",
		"awf:agent-development:state:ready",
	]);
});

it("should ensure that listIssues requires reconciliation for malformed reserved GitHub labels", async () => {
	const api = createMockGitHubApi();
	await api.createIssue({
		title: "Reserved but malformed workflow label",
		labels: ["awf:agent-development"],
	});
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
	await tracker.createIssue({
		title: "Workflow issue",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await expect(tracker.listIssues()).rejects.toThrow(/NEED_RECONCILIATION/);
});

it("should append logs as strict machine comments", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
	const issue = await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await tracker.appendLog(issue.id, { type: "started", runId: "run-1" });
	await tracker.appendLog(issue.id, {
		type: "succeeded",
		message: "ok",
	});

	expect(api.issue(1).comments.length).toBe(PROJECT_COMMENT_AND_TWO_LOGS);
	expect(api.issue(1).comments[1]?.body).toBe(
		'<!-- awf:log v1 agent-development -->\n{"issueId":"1","runId":"run-1","sequence":1,"type":"started"}',
	);
	expect(
		(await tracker.readLogs(issue.id)).map((log) => [log.sequence, log.type]),
	).toEqual([
		[1, "started"],
		[2, "succeeded"],
	]);
});

it("should use native hierarchy and dependency capabilities", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
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

	expect((await tracker.getIssue("1")).relationships.children).toEqual(["2"]);
	expect((await tracker.getIssue("2")).relationships.parent).toBe("1");
	expect((await tracker.getIssue("2")).relationships.dependencies).toEqual([
		"3",
	]);
	expect((await tracker.getIssue("3")).relationships.dependents).toEqual(["2"]);
});

it("should ensure that listIssues ignores unrelated GitHub issues without workflow projection labels", async () => {
	const api = createMockGitHubApi();
	await api.createIssue({ title: "Regular issue", labels: ["project:awf"] });
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
	await tracker.createIssue({
		title: "Workflow issue",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	api.issue(1).comments.push({ id: 99, body: "Human note about awf labels" });

	expect((await tracker.listIssues()).map((issue) => issue.id)).toEqual(["2"]);
});

it("should ensure that capability validation fails when native issue relationships are unavailable", async () => {
	const api = createMockGitHubApi({
		capabilities: { subIssues: false, dependencies: true },
	});
	await expect(validateGitHubTrackerCapabilities(api)).rejects.toThrow(
		/sub-issues/,
	);
});

it("should ensure that manual reserved-label corruption requires reconciliation", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	api.issue(1).labels.push("awf:agent-development:state:running");

	await expect(tracker.getIssue("1")).rejects.toThrow(
		CorruptWorkflowProjectionError,
	);
	await expect(tracker.getIssue("1")).rejects.toThrow(/NEED_RECONCILIATION/);
});

it("should ensure that machine-comment corruption requires reconciliation", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	api.issue(1).comments[0].body =
		"<!-- awf:current v1 agent-development -->\nnot-json";

	await expect(tracker.getIssue("1")).rejects.toThrow(/NEED_RECONCILIATION/);
});

it("should ensure that malformed canonical and legacy workflow-owned machine comments require reconciliation", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
	await tracker.createIssue({
		title: "Implement adapter",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	api.issue(1).comments.push({
		id: 100,
		body: "<!-- awf:log v2 agent-development -->\n{}",
	});
	await expect(tracker.readLogs("1")).rejects.toThrow(/NEED_RECONCILIATION/);

	api.issue(1).comments[1].body = "<!-- awf:agent-development:log -->\n{}";
	await expect(tracker.readLogs("1")).rejects.toThrow(/NEED_RECONCILIATION/);

	api.issue(1).comments[1].body = "<!-- awf:current v1 agent-development -->";
	await expect(tracker.getIssue("1")).rejects.toThrow(/NEED_RECONCILIATION/);
});

it("should ensure that machine-comment markers validate type version and workflow id", async () => {
	const api = createMockGitHubApi();
	const tracker = createGitHubTracker({
		api,
		manifest: agentDevelopmentManifest,
	});
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

	await expect(tracker.getIssue("1")).rejects.toThrow(/NEED_RECONCILIATION/);

	api.issue(1).comments[0].body =
		api
			.issue(1)
			.comments[0]?.body.replace(
				"<!-- awf:log v1 agent-development -->",
				"<!-- awf:current v2 agent-development -->",
			) ?? "";

	await expect(tracker.getIssue("1")).rejects.toThrow(/NEED_RECONCILIATION/);

	api.issue(1).comments[0].body =
		api
			.issue(1)
			.comments[0]?.body.replace(
				"<!-- awf:current v2 agent-development -->",
				"<!-- awf:current v1 other-workflow -->",
			) ?? "";

	await expect(tracker.getIssue("1")).rejects.toThrow(/NEED_RECONCILIATION/);
});

it("should ensure that opt-in smoke: execute create/get/start/succeed/log against a real GitHub repository", {
	skip: process.env.AWF_GITHUB_SMOKE !== "1",
}, async () => {
	const repo = process.env.AWF_GITHUB_SMOKE_REPO;
	assert(repo);
	// Documented fixture contract: point AWF_GITHUB_SMOKE_REPO at a disposable
	// repository with GitHub sub-issues/dependencies enabled and gh authenticated.
	// This path exercises the tracker through command semantics and verifies
	// machine labels/comments, not prose parsing. The default CI run skips it.
	const { createGhCliGitHubTracker } = await import(
		"../../../../src/trackers/github/index.ts"
	);
	const [owner, name] = repo.split("/");
	expect(owner).toBeTruthy();
	expect(name).toBeTruthy();
	const tracker = createGhCliGitHubTracker({
		owner,
		repo: name,
		manifest: agentDevelopmentManifest,
	});
	const created = await execute(["create", "spec", "--input", "-"], {
		tracker,
		stdin: "# Smoke spec\n",
	});
	expect(created.ok).toBe(true);
	if (!created.ok) {
		throw new Error("expected create success");
	}
	const createdData = created.data as { issue: { id: string } };
	const id = createdData.issue.id;
	expect((await execute(["get", id], { tracker })).ok).toBe(true);
	const started = await execute(["run-command", "start", id], { tracker });
	expect(started.ok).toBe(true);
	if (!started.ok) {
		throw new Error("expected start success");
	}
	const startedData = started.data as { run: { id: string } };
	const runId = startedData.run.id;
	expect((await execute(["logs", id], { tracker })).ok).toBe(true);
	expect(
		(
			await execute(
				["run-command", "succeed", id, "--run", runId, "--input", "-"],
				{
					tracker,
					stdin: JSON.stringify({ tickets: [] }),
				},
			)
		).ok,
	).toBe(true);
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
		assert(issue);
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
