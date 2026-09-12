import { expect, it } from "vitest";
import { execute as rawExecute } from "../../support/execute.ts";
import { agentWorkflowManifest } from "../../../src/workflows/agent-workflow/index.ts";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentWorkflowManifest, ...options });
}

it("should ensure that reconcile leaves active workflow issues clean", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Drifted",
				workflow: { kind: "task", state: "running", action: "work" },
			},
		],
	});

	const envelope = await execute(["reconcile", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	expect((envelope.ok ? envelope.data : {}) as Record<string, unknown>).toEqual(
		{
			id: "123",
			mode: "check",
			status: "clean",
			diagnostics: [],
			issue: await tracker.getIssue("123"),
		},
	);
});

it("should ensure that reconcile --apply leaves idle states unchanged", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Repairable",
				workflow: {
					kind: "task",
					state: "ready",
					action: "work",
				},
			},
		],
	});

	const envelope = await execute(["reconcile", "123", "--apply"], { tracker });

	expect(envelope.ok).toBe(true);
	expect(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ code: string; applied?: boolean }>;
			}
		).diagnostics,
	).toEqual([]);
});

it("should ensure that reconcile does not derive lifecycle drift from logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Ambiguous",
				workflow: { kind: "task", state: "running", action: "work" },
				logs: [],
			},
		],
	});

	const envelope = await execute(["reconcile", "123", "--apply"], { tracker });

	expect(envelope.ok).toBe(true);
	const updated = await tracker.getIssue("123");
	expect(updated.workflow).toMatchObject({
		state: "running",
		action: "work",
	});
	expect(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ repair: string; applied?: boolean }>;
			}
		).diagnostics,
	).toEqual([]);
});

it("should ensure that reconcile reports malformed logs and corrupt current metadata", async () => {
	const malformedLogTracker = createInMemoryTracker({
		issues: [
			{
				id: "logs",
				title: "Bad logs",
				workflow: { kind: "task", state: "ready", action: "work" },
				logs: [{ sequence: 1, type: "" }],
			},
		],
	});
	const duplicateFieldsTracker = createInMemoryTracker({
		issues: [
			{
				id: "dupe",
				title: "Bad labels",
				labels: [
					"awf:agent-workflow:kind:ticket",
					"awf:agent-workflow:kind:spec",
					"awf:agent-workflow:state:ready",
					"awf:agent-workflow:action:implement",
				],
			},
			{
				id: "missing",
				title: "Missing labels",
				labels: [
					"awf:agent-workflow:kind:ticket",
					"awf:agent-workflow:state:ready",
				],
			},
		],
	});

	const malformedEnvelope = await execute(["reconcile", "logs"], {
		tracker: malformedLogTracker,
	});
	expect(malformedEnvelope.ok).toBe(true);
	expect(
		(malformedEnvelope.ok
			? (malformedEnvelope.data as { diagnostics: Array<{ code: string }> })
			: { diagnostics: [] }
		).diagnostics[0]?.code,
	).toBe("MALFORMED_WORKFLOW_LOG");
	for (const [id, code] of [
		["dupe", "DUPLICATE_CURRENT_FIELDS"],
		["missing", "MISSING_CURRENT_METADATA"],
	] as const) {
		const envelope = await execute(["reconcile", id], {
			tracker: duplicateFieldsTracker,
		});
		expect(envelope.ok).toBe(true);
		expect(
			(
				(envelope.ok ? envelope.data : {}) as {
					diagnostics: Array<{ code: string }>;
				}
			).diagnostics[0]?.code,
		).toBe(code);
	}
});
