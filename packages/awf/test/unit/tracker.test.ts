import { expect, it } from "vitest";
import {
	CorruptWorkflowProjectionError,
	ProjectionConflictError,
} from "../../src/workflow/projection.ts";
import { createInMemoryTracker } from "../../src/trackers/memory.ts";

it("should ensure that conditional updates advance the projection version and reject stale expectations", async () => {
	const tracker = createInMemoryTracker();
	const issue = await tracker.createIssue({
		title: "Implement tracker",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	});

	const updated = await tracker.updateIssue(issue.id, {
		expect: { version: issue.workflow.version, hash: issue.workflow.hash },
		workflow: { state: "running", activeRunId: "run-1" },
	});

	expect(updated.workflow.version).toBe(issue.workflow.version + 1);
	expect(updated.workflow.state).toBe("running");
	expect(updated.workflow.activeRunId).toBe("run-1");
	await expect(
		tracker.updateIssue(issue.id, {
			expect: { version: issue.workflow.version, hash: issue.workflow.hash },
			workflow: { state: "done" },
		}),
	).rejects.toThrow(ProjectionConflictError);
});

it("should ensure that workflow logs are append-only and read back in append order", async () => {
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
	expect(logs.map((log) => log.sequence)).toEqual([1, 2]);
	expect(logs.map((log) => log.type)).toEqual(["started", "succeeded"]);
});

it("should ensure that hierarchy and dependency relationships are projected on reads", async () => {
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

	expect((await tracker.getIssue(spec.id)).relationships.children).toEqual([
		ticket.id,
	]);
	expect((await tracker.getIssue(ticket.id)).relationships.parent).toBe(
		spec.id,
	);
	expect(
		(await tracker.getIssue(ticket.id)).relationships.dependencies,
	).toEqual([blocker.id]);
	expect((await tracker.getIssue(blocker.id)).relationships.dependents).toEqual(
		[ticket.id],
	);
});

it("should ensure that generated-by provenance is normalized separately from blocking relationships", async () => {
	const tracker = createInMemoryTracker();
	const source = await tracker.createIssue({
		title: "Source",
		workflow: { kind: "task", state: "ready", action: "work" },
	});
	const generated = await tracker.createIssue({
		title: "Generated",
		workflow: { kind: "task", state: "ready", action: "work" },
		relationships: { generatedBy: source.id },
	});

	expect((await tracker.getIssue(generated.id)).relationships).toMatchObject({
		dependencies: [],
		dependents: [],
		generatedBy: source.id,
	});
	expect((await tracker.getIssue(source.id)).relationships.dependents).toEqual(
		[],
	);
});

it("should ensure that artifact and change registrations are returned with the normalized issue", async () => {
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
	expect(read.artifacts).toEqual([
		{
			id: "artifact-1",
			kind: "file",
			uri: "docs/plan.md",
			name: "Plan",
			type: "file",
			path: "docs/plan.md",
		},
	]);
	expect(read.changes).toEqual([
		{
			id: "change-1",
			kind: "git-ref",
			uri: "abc123",
			summary: "Implementation commit",
		},
	]);
});

it("should ensure that duplicate or malformed workflow projection fields are corruption", async () => {
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
	await expect(duplicate.getIssue("1")).rejects.toThrow(
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
	await expect(missing.getIssue("2")).rejects.toThrow(
		CorruptWorkflowProjectionError,
	);
	expect(() =>
		createInMemoryTracker({
			issues: [
				{
					id: "3",
					title: "Bad",
					labels: "awf:agent-development:kind:ticket",
				} as never,
			],
		}),
	).toThrow(CorruptWorkflowProjectionError);
});
