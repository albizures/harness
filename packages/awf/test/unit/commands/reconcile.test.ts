import { expect, it } from "vitest";
import { execute as rawExecute } from "../../../src/commands.ts";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}

it("should ensure that reconcile leaves active workflow issues clean", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Drifted",
				workflow: { kind: "ticket", state: "running", action: "implement" },
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
					kind: "ticket",
					state: "ready",
					action: "implement",
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
				workflow: { kind: "ticket", state: "running", action: "implement" },
				logs: [],
			},
		],
	});

	const envelope = await execute(["reconcile", "123", "--apply"], { tracker });

	expect(envelope.ok).toBe(true);
	const updated = await tracker.getIssue("123");
	expect(updated.workflow).toMatchObject({
		state: "running",
		action: "implement",
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
				workflow: { kind: "ticket", state: "ready", action: "implement" },
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
					"awf:agent-development:kind:ticket",
					"awf:agent-development:kind:spec",
					"awf:agent-development:state:ready",
					"awf:agent-development:action:implement",
				],
			},
			{
				id: "missing",
				title: "Missing labels",
				labels: [
					"awf:agent-development:kind:ticket",
					"awf:agent-development:state:ready",
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
