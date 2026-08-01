import assert from "node:assert/strict";
import test from "node:test";
import {
	CorruptWorkflowProjectionError,
	ProjectionConflictError,
} from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

test("conditional updates advance the projection version and reject stale expectations", async () => {
	const tracker = createInMemoryTracker();
	const issue = await tracker.createIssue({
		title: "Implement tracker",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	const updated = await tracker.updateIssue(issue.id, {
		expect: { version: issue.workflow.version, hash: issue.workflow.hash },
		workflow: { state: "running", activeRunId: "run-1" },
	});

	assert.equal(updated.workflow.version, issue.workflow.version + 1);
	assert.equal(updated.workflow.state, "running");
	assert.equal(updated.workflow.activeRunId, "run-1");
	await assert.rejects(
		tracker.updateIssue(issue.id, {
			expect: { version: issue.workflow.version, hash: issue.workflow.hash },
			workflow: { state: "done" },
		}),
		ProjectionConflictError,
	);
});

test("workflow logs are append-only and read back in append order", async () => {
	const tracker = createInMemoryTracker();
	const issue = await tracker.createIssue({
		title: "Log me",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await tracker.appendLog(issue.id, {
		type: "started",
		runId: "run-1",
		payload: { action: "implement" },
	});
	await tracker.appendLog(issue.id, {
		type: "succeeded",
		runId: "run-1",
		payload: { result: "ok" },
	});

	const logs = await tracker.readLogs(issue.id);
	assert.deepEqual(
		logs.map((log) => log.sequence),
		[1, 2],
	);
	assert.deepEqual(
		logs.map((log) => log.type),
		["started", "succeeded"],
	);
});

test("hierarchy and dependency relationships are projected on reads", async () => {
	const tracker = createInMemoryTracker();
	const spec = await tracker.createIssue({
		title: "Spec",
		workflow: { kind: "spec", state: "ready", action: "plan" },
	});
	const ticket = await tracker.createIssue({
		title: "Ticket",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});
	const blocker = await tracker.createIssue({
		title: "Blocker",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await tracker.addChild(spec.id, ticket.id);
	await tracker.addDependency(ticket.id, blocker.id);

	assert.deepEqual((await tracker.getIssue(spec.id)).relationships.children, [
		ticket.id,
	]);
	assert.equal(
		(await tracker.getIssue(ticket.id)).relationships.parent,
		spec.id,
	);
	assert.deepEqual(
		(await tracker.getIssue(ticket.id)).relationships.dependencies,
		[blocker.id],
	);
	assert.deepEqual(
		(await tracker.getIssue(blocker.id)).relationships.dependents,
		[ticket.id],
	);
});

test("artifact and change registrations are returned with the normalized issue", async () => {
	const tracker = createInMemoryTracker();
	const issue = await tracker.createIssue({
		title: "Artifacts",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	await tracker.registerArtifact(issue.id, {
		kind: "file",
		uri: "docs/plan.md",
		name: "Plan",
	});
	await tracker.registerChange(issue.id, {
		kind: "git-ref",
		uri: "abc123",
		summary: "Implementation commit",
	});

	const read = await tracker.getIssue(issue.id);
	assert.deepEqual(read.artifacts, [
		{ id: "artifact-1", kind: "file", uri: "docs/plan.md", name: "Plan" },
	]);
	assert.deepEqual(read.changes, [
		{
			id: "change-1",
			kind: "git-ref",
			uri: "abc123",
			summary: "Implementation commit",
		},
	]);
});

test("duplicate or malformed workflow projection fields are corruption", async () => {
	const duplicate = createInMemoryTracker({
		issues: [
			{
				id: "1",
				title: "Bad",
				labels: [
					"awf:agent-development:kind:ticket",
					"awf:agent-development:kind:spec",
					"awf:agent-development:state:ready",
					"awf:agent-development:action:implement",
				],
			},
		],
	});
	await assert.rejects(
		() => duplicate.getIssue("1"),
		CorruptWorkflowProjectionError,
	);
	const missing = createInMemoryTracker({
		issues: [
			{
				id: "2",
				title: "Bad",
				labels: [
					"awf:agent-development:kind:ticket",
					"awf:agent-development:state:ready",
				],
			},
		],
	});
	await assert.rejects(
		() => missing.getIssue("2"),
		CorruptWorkflowProjectionError,
	);
	assert.throws(
		() =>
			createInMemoryTracker({
				issues: [
					{
						id: "3",
						title: "Bad",
						labels: "awf:agent-development:kind:ticket",
					} as never,
				],
			}),
		CorruptWorkflowProjectionError,
	);
});
