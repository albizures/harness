import { expect, it } from "vitest";
import { execute } from "../../../src/commands.ts";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";

it("should ensure that get reads a workflow issue with a stable envelope shape", async () => {
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
					kind: "ticket",
					state: "running",
					action: "implement",
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
