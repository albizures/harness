import { expect, test } from "vitest";
import { execute } from "../commands.ts";
import { createInMemoryTracker } from "../trackers/memory.ts";

const prArtifact = (n: number) => ({
	type: "pull-request",
	url: `https://github.com/albizures/harness/pull/${n}`,
});

test("reconcile reports diagnostics read-only by default", async () => {
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

test("reconcile --apply performs deterministic safe active-run repair", async () => {
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

test("reconcile leaves ambiguous active-run drift for humans", async () => {
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
	expect((await tracker.getIssue("123")).workflow.activeRunId).toBe(undefined);
	expect(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ repair: string }>;
			}
		).diagnostics[0]?.repair,
	).toBe("need-human");
});

test("reconcile reports malformed logs and corrupt current metadata", async () => {
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

test("normal commands do not silently repair drift before reconciliation", async () => {
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
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		},
	);
	expect(before.ok).toBe(false);
	expect(before.ok ? undefined : before.error.code).toBe("RUN_MISMATCH");
	await execute(["reconcile", "123", "--apply"], { tracker });
	const after = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		},
	);
	expect(after.ok).toBe(true);
});
