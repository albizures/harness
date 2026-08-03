import assert from "node:assert/strict";
import test from "node:test";
import {
	NeedReconciliationError,
	ProjectionConflictError,
	type Tracker,
} from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

test("adapter conformance: intent writes reject stale projection preconditions", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	const issue = await tracker.getIssue("1");
	await tracker.advanceWorkflow("1", {
		expect: { version: issue.workflow.version, hash: issue.workflow.hash },
		workflow: { state: "running", activeRunId: "run-1" },
	});

	await assert.rejects(
		tracker.startRun("1", {
			expect: { version: issue.workflow.version, hash: issue.workflow.hash },
			runId: "run-2",
			workflow: { state: "running" },
			log: { type: "action_started", runId: "run-2" },
		}),
		ProjectionConflictError,
	);
});

test("adapter conformance: plan intents verify created projection through Tracker reads", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const spec = await tracker.getIssue("spec-1");

	const result = await tracker.applyPlan({
		specId: "spec-1",
		expect: { version: spec.workflow.version, hash: spec.workflow.hash },
		specWorkflow: { state: "ready", action: "none" },
		tickets: [
			{
				key: "a",
				title: "A",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
			{
				key: "b",
				title: "B",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				dependsOn: ["a"],
			},
		],
		log: { type: "plan_applied", payload: { tickets: [] } },
	});

	assert.deepEqual(
		result.tickets.map((ticket) => ticket.key),
		["a", "b"],
	);
	assert.deepEqual(
		(await tracker.getIssue("spec-1")).relationships.children,
		result.tickets.map((ticket) => ticket.id),
	);
	assert.deepEqual(
		(await tracker.getIssue(result.tickets[1]?.id ?? "missing")).relationships
			.dependencies,
		[result.tickets[0]?.id],
	);
	assert.equal((await tracker.readLogs("spec-1"))[0]?.type, "plan_applied");
});

test("adapter conformance: partial tracker failures return NEED_RECONCILIATION without rollback", async () => {
	const base = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const tracker: Tracker = {
		...base,
		applyPlan: async () => {
			const ticket = await base.createIssue({
				title: "A",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			});
			await base.changeRelationship({
				type: "add-child",
				parentId: "spec-1",
				childId: ticket.id,
			});
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: adapter projection mismatch.",
			);
		},
	};

	await assert.rejects(
		tracker.applyPlan({
			specId: "spec-1",
			expect: { version: 1 },
			specWorkflow: { state: "ready", action: "none" },
			tickets: [
				{
					key: "a",
					title: "A",
					workflow: { kind: "ticket", state: "ready", action: "implement" },
				},
			],
			log: { type: "plan_applied" },
		}),
		NeedReconciliationError,
	);
	assert.deepEqual(
		(await base.listIssues()).map((issue) => issue.id),
		["spec-1", "1"],
	);
	assert.deepEqual((await base.getIssue("spec-1")).relationships.children, [
		"1",
	]);
});
