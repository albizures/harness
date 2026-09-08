import { expect, it } from "vitest";
import { execute as rawExecute } from "../../../src/commands.ts";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";
import { createInMemoryTracker } from "../../../src/trackers/memory.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}

const prArtifact = (n: number) => ({
	type: "pull-request",
	url: `https://github.com/albizures/harness/pull/${n}`,
});

it("should ensure that reconcile reports diagnostics read-only by default", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Drifted",
				workflow: { kind: "ticket", state: "running", action: "implement" },
				logs: [{ sequence: 1, type: "action_started", runId: "run-1" }],
			},
		],
	});

	const envelope = await execute(["reconcile", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	expect((await tracker.getIssue("123")).workflow.activeRunId).toBe(undefined);
	expect((envelope.ok ? envelope.data : {}) as Record<string, unknown>).toEqual(
		{
			id: "123",
			mode: "check",
			status: "diagnosed",
			diagnostics: [
				{
					code: "MISSING_ACTIVE_RUN",
					severity: "drift",
					message: "Current fields are missing active run 'run-1'.",
					repair: "safe",
					runId: "run-1",
				},
			],
			issue: await tracker.getIssue("123"),
		},
	);
});

it("should ensure that reconcile --apply performs deterministic safe active-run repair", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Repairable",
				workflow: { kind: "ticket", state: "running", action: "implement" },
				logs: [{ sequence: 1, type: "action_started", runId: "run-1" }],
			},
		],
	});

	const envelope = await execute(["reconcile", "123", "--apply"], { tracker });

	expect(envelope.ok).toBe(true);
	expect((await tracker.getIssue("123")).workflow.activeRunId).toBe("run-1");
	expect(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ applied?: boolean }>;
			}
		).diagnostics[0]?.applied,
	).toBe(true);
});

it("should ensure that reconcile applies ambiguous active-run drift as need-human intervention", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Ambiguous",
				workflow: { kind: "ticket", state: "running", action: "implement" },
				logs: [
					{ sequence: 1, type: "action_started", runId: "run-1" },
					{ sequence: 2, type: "action_started", runId: "run-2" },
				],
			},
		],
	});

	const envelope = await execute(["reconcile", "123", "--apply"], { tracker });

	expect(envelope.ok).toBe(true);
	const updated = await tracker.getIssue("123");
	expect(updated.workflow).toMatchObject({
		state: "need-human",
		action: "none",
	});
	expect(updated.workflow.activeRunId).toBeUndefined();
	expect(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ repair: string; applied?: boolean }>;
			}
		).diagnostics[0],
	).toMatchObject({ repair: "need-human", applied: true });
});

it("should ensure that reconcile reports malformed logs and corrupt current metadata", async () => {
	const malformedLogTracker = createInMemoryTracker({
		issues: [
			{
				id: "logs",
				title: "Bad logs",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				logs: [{ sequence: 1, type: "action_started", runId: "" }],
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

it("should ensure that normal commands do not silently repair drift before reconciliation", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Smoke repair",
				workflow: { kind: "ticket", state: "running", action: "implement" },
				logs: [{ sequence: 1, type: "action_started", runId: "run-1" }],
			},
		],
	});

	const before = await execute(
		["run-command", "succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		},
	);
	expect(before.ok).toBe(false);
	expect(before.ok ? undefined : before.error.code).toBe("RUN_MISMATCH");
	await execute(["reconcile", "123", "--apply"], { tracker });
	const after = await execute(
		["run-command", "succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		},
	);
	expect(after.ok).toBe(true);
});
