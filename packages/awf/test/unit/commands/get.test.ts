import { expect, it } from "vitest";
import { execute } from "../../support/execute.ts";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";
import type { Tracker } from "../../../src/ports/tracker.ts";
import { CorruptWorkflowProjectionError } from "../../../src/domain/workflow/projection.ts";
import {
	IssueNotFoundError,
	type SeedIssueInput,
	type WorkflowIssue,
} from "../../../src/domain/workflow/issue.ts";

const TOTAL_LOG_COUNT = 6;

it("should ensure that get reads a workflow issue with a stable envelope shape", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "42",
				title: "Implement tracker",
				labels: [
					"awf:w1:kind:task",
					"awf:w1:state:ready",
					"awf:w1:action:work",
				],
			},
		],
	});

	const envelope = await execute(["get", "42"], { tracker });

	expect(envelope.ok).toBe(true);
	expect((envelope as { ok: true; data: unknown }).data).toEqual({
		issue: {
			id: "42",
			title: "Implement tracker",
			workflow: {
				kind: "task",
				state: "ready",
				action: "work",
				version: 1,
				hash: "8c35dbf3fa9a0cb50a4e571bf63aa8a364aaf4fb3928594087ddffd1cce69f9f",
			},
			relationships: { children: [], dependencies: [], dependents: [] },
		},
		logs: [],
		recentLogs: [],
		relationships: {
			children: [],
			dependencies: [],
			dependents: [],
		},
	});
});

it("should ensure that get returns issue, logs, and recent logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Crash-like",
				workflow: {
					kind: "task",
					state: "running",
					action: "work",
				},
				logs: [
					{ sequence: 1, type: "created" },
					{ sequence: 2, type: "action_started" },
					{ sequence: 3, type: "checkpoint" },
					{ sequence: 4, type: "checkpoint" },
					{ sequence: 5, type: "checkpoint" },
					{ sequence: 6, type: "action_succeeded" },
				],
			},
		],
	});

	const envelope = await execute(["get", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: { logs: Array<unknown>; recentLogs: Array<unknown> };
		}
	).data;
	expect(data.logs).toHaveLength(TOTAL_LOG_COUNT);
	expect(data.recentLogs).toEqual([
		{ issueId: "123", sequence: 2, type: "action_started" },
		{ issueId: "123", sequence: 3, type: "checkpoint" },
		{ issueId: "123", sequence: 4, type: "checkpoint" },
		{ issueId: "123", sequence: 5, type: "checkpoint" },
		{ issueId: "123", sequence: 6, type: "action_succeeded" },
	]);
});

it("should expand one-hop relationship summaries while preserving raw relationship ids", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			issue({ id: "parent", title: "Parent", kind: "spec" }),
			issue({
				id: "target",
				title: "Target",
				kind: "task",
				relationships: {
					parent: "parent",
					children: ["child-a", "child-b"],
					dependencies: ["dependency"],
					dependents: ["dependent"],
					generatedBy: "generator",
				},
			}),
			issue({ id: "child-a", title: "Child A", kind: "task" }),
			issue({ id: "child-b", title: "Child B", kind: "task" }),
			issue({ id: "dependency", title: "Dependency", kind: "task" }),
			issue({ id: "dependent", title: "Dependent", kind: "task" }),
			issue({ id: "generator", title: "Generator", kind: "task" }),
		],
	});

	const envelope = await execute(["get", "target"], { tracker });

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: { issue: WorkflowIssue; relationships: unknown };
		}
	).data;
	expect(data.issue.relationships).toEqual({
		parent: "parent",
		children: ["child-a", "child-b"],
		dependencies: ["dependency"],
		dependents: ["dependent"],
		generatedBy: "generator",
	});
	expect(data.relationships).toMatchObject({
		parent: { id: "parent", title: "Parent", workflow: { kind: "spec" } },
		children: [
			{ id: "child-a", title: "Child A", workflow: { kind: "task" } },
			{ id: "child-b", title: "Child B", workflow: { kind: "task" } },
		],
		dependencies: [
			{ id: "dependency", title: "Dependency", workflow: { kind: "task" } },
		],
		dependents: [
			{ id: "dependent", title: "Dependent", workflow: { kind: "task" } },
		],
		generatedBy: {
			id: "generator",
			title: "Generator",
			workflow: { kind: "task" },
		},
	});
});

it("should render missing related issues without hiding a missing target issue", async () => {
	const target = issue({
		id: "target",
		title: "Target",
		kind: "task",
		relationships: { children: ["missing-child"] },
	});
	const tracker = createRelationshipTracker([target]);

	const envelope = await execute(["get", "target"], { tracker });

	expect(envelope.ok).toBe(true);
	expect(
		(envelope as { ok: true; data: { relationships: unknown } }).data
			.relationships,
	).toEqual({
		children: [{ id: "missing-child", missing: true }],
		dependencies: [],
		dependents: [],
	});

	await expect(
		execute(["get", "missing-target"], { tracker }),
	).resolves.toEqual({
		ok: false,
		error: {
			code: "NOT_FOUND",
			message: "Workflow issue 'missing-target' was not found.",
			details: { id: "missing-target" },
		},
	});
});

it("should fail get when related workflow projection data is corrupt", async () => {
	const tracker = createRelationshipTracker([
		issue({
			id: "target",
			title: "Target",
			kind: "task",
			relationships: { dependencies: ["corrupt"] },
		}),
	]);

	const envelope = await execute(["get", "target"], { tracker });

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "CORRUPT_WORKFLOW_PROJECTION",
			message: "Issue 'corrupt' has corrupt state projection data.",
			details: { id: "target" },
		},
	});
});

function issue(input: {
	id: string;
	title: string;
	kind: string;
	relationships?: Partial<WorkflowIssue["relationships"]>;
}): SeedIssueInput {
	return {
		id: input.id,
		title: input.title,
		workflow: {
			kind: input.kind,
			state: "ready",
			action: input.kind === "spec" ? "planning" : "work",
		},
		relationships: input.relationships,
	};
}

function createRelationshipTracker(issues: Array<SeedIssueInput>): Tracker {
	const base = createInMemoryTracker({
		issues: issues.map((seed) => ({ ...seed, relationships: undefined })),
	});
	const tracker = Object.create(base) as Tracker;
	tracker.getIssue = async (id) => {
		if (id === "corrupt") {
			throw new CorruptWorkflowProjectionError(
				"Issue 'corrupt' has corrupt state projection data.",
			);
		}
		const found = issues.find((seed) => seed.id === id);
		if (found === undefined) {
			throw new IssueNotFoundError(id);
		}
		const healthy = await base.getIssue(id);
		return found.relationships === undefined
			? healthy
			: {
					...healthy,
					relationships: {
						...healthy.relationships,
						...found.relationships,
					},
				};
	};
	return tracker;
}
