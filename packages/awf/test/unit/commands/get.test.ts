import { expect, it } from "vitest";
import { execute } from "../../support/execute.ts";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";

it("should ensure that get reads a workflow issue with a stable envelope shape", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "42",
				title: "Implement tracker",
				labels: [
					"awf:agent-workflow:kind:task",
					"awf:agent-workflow:state:ready",
					"awf:agent-workflow:action:work",
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
	});
});

it("should ensure that get returns issue and logs", async () => {
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
				logs: [{ sequence: 1, type: "action_started" }],
			},
		],
	});

	const envelope = await execute(["get", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	expect((envelope as { ok: true; data: { logs: unknown } }).data.logs).toEqual(
		[
			{
				issueId: "123",
				sequence: 1,
				type: "action_started",
			},
		],
	);
});
