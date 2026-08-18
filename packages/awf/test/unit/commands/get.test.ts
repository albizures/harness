import { expect, test } from "vitest";
import { execute } from "../../../src/commands.ts";
import { createInMemoryTracker } from "../../../src/trackers/memory.ts";

test("get reads a workflow issue with a stable envelope shape", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "42",
				title: "Implement tracker",
				labels: [
					"awf:agent-development:kind:ticket",
					"awf:agent-development:state:ready",
					"awf:agent-development:action:implement",
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
				kind: "ticket",
				state: "ready",
				action: "implement",
				version: 1,
				hash: "e9812f9a37bab3fda6fab06bf276533986787191c9d806cb01aff52b3d0c0e07",
			},
			relationships: { children: [], dependencies: [], dependents: [] },
			artifacts: [],
			changes: [],
		},
		runs: { activeRunId: undefined, attempts: [] },
	});
});

test("get returns derived run attempts even for crash-like running state", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Crash-like",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-crash",
				},
			},
		],
	});

	const envelope = await execute(["get", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	expect((envelope as { ok: true; data: { runs: unknown } }).data.runs).toEqual(
		{
			activeRunId: "run-crash",
			attempts: [{ runId: "run-crash", status: "running" }],
		},
	);
});
