import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./commands.ts";
import { serializeEnvelope } from "./envelope.ts";
import { defineManifest } from "./manifest.ts";
import { createInMemoryTracker } from "./tracker.ts";

test("help returns a stable success envelope", async () => {
	const envelope = await execute(["--help"]);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		name: string;
		description: string;
		commands: Array<{ usage: string }>;
	};
	assert.equal(data.name, "awf");
	assert.equal(data.description, "Agent workflow CLI.");
	assert.ok(Array.isArray(data.commands));
	assert.ok(
		data.commands.some((command) => command.usage === "awf start <id>"),
	);
});

test("ready returns legal executable work after dependency, concurrency, active-run, and manifest filters", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "30",
				title: "Running ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-30",
				},
			},
			{
				id: "10",
				title: "Ready ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
			{
				id: "20",
				title: "Dependency blocked ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
			{
				id: "40",
				title: "Done blocker",
				workflow: { kind: "ticket", state: "done", action: "none" },
			},
			{
				id: "50",
				title: "Spec is not executable by this manifest filter",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
			{
				id: "60",
				title: "Ready-looking ticket with an active run",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					activeRunId: "run-60",
				},
			},
		],
	});
	await tracker.addDependency("20", "10");
	await tracker.addDependency("10", "40");

	const envelope = await execute(["ready"], {
		tracker,
		manifest: {
			...defaultTicketOnlyReadyManifest,
			concurrency: { perIssue: 1, perWorkflow: 3, perKind: { ticket: 3 } },
		},
	});

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual(envelope.data, {
		items: [
			{
				id: "10",
				title: "Ready ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				suggestedCommand: { argv: ["start", "10"], display: "awf start 10" },
			},
		],
	});
});

test("ready excludes candidates blocked by manifest concurrency limits", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "running",
				title: "Running ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
			{
				id: "ready",
				title: "Ready ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const envelope = await execute(["ready"], {
		tracker,
		manifest: {
			...defaultTicketOnlyReadyManifest,
			concurrency: { perIssue: 1, perKind: { ticket: 1 } },
		},
	});

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual(envelope.data, { items: [] });
});

test("ready returns deterministic ordering, supports --limit 1, and --spec filtering", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec 1",
				workflow: { kind: "spec", state: "done", action: "none" },
			},
			{
				id: "2",
				title: "Second",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
			{
				id: "1",
				title: "First",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	await tracker.addChild("spec-1", "2");
	await tracker.addChild("spec-1", "1");

	const envelope = await execute(
		["ready", "--spec", "spec-1", "--limit", "1"],
		{
			tracker,
			manifest: defaultTicketOnlyReadyManifest,
		},
	);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual(
		(envelope.data as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
		["1"],
	);
});

test("start moves a ready issue to running, stores one active run, and appends an action_started log", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const envelope = await execute(["start", "123"], { tracker });

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		issue: { workflow: { state: string; activeRunId: string } };
		run: { id: string };
	};
	assert.equal(data.issue.workflow.state, "running");
	assert.equal(data.issue.workflow.activeRunId, data.run.id);
	const logs = await tracker.readLogs("123");
	assert.deepEqual(
		logs.map((log) => log.type),
		["action_started"],
	);
	assert.equal(logs[0]?.runId, data.run.id);
});

test("succeed applies the manifest terminal transition for the active run", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
			}),
		},
	);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		issue: {
			workflow: { state: string; action: string; activeRunId?: string };
		};
	};
	assert.equal(data.issue.workflow.state, "ready");
	assert.equal(data.issue.workflow.action, "review");
	assert.equal(data.issue.workflow.activeRunId, undefined);
	assert.deepEqual(
		(await tracker.readLogs("123")).map((log) => log.type),
		["action_succeeded"],
	);
});

test("fail applies the manifest terminal transition with its reason", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["fail", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ reason: "dependencies" }),
		},
	);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		issue: { workflow: { state: string; action: string; reason?: string } };
	};
	assert.deepEqual(
		{
			state: data.issue.workflow.state,
			action: data.issue.workflow.action,
			reason: data.issue.workflow.reason,
		},
		{ state: "blocked", action: "implement", reason: "dependencies" },
	);
});

test("lifecycle commands reject invalid manifest transitions and run mismatches", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "done",
				title: "Done",
				workflow: { kind: "ticket", state: "done", action: "none" },
			},
			{
				id: "running",
				title: "Running",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
		],
	});

	assert.deepEqual(await execute(["start", "done"], { tracker }), {
		ok: false,
		error: {
			code: "INVALID_TRANSITION",
			message:
				"No manifest transition matches the current workflow fields for this event.",
			details: { id: "done", event: "start" },
		},
	});
	assert.deepEqual(
		await execute(["succeed", "running", "--run", "other", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
			}),
		}),
		{
			ok: false,
			error: {
				code: "RUN_MISMATCH",
				message: "Command run id does not match the active workflow run.",
				details: { id: "running", activeRunId: "run-1", runId: "other" },
			},
		},
	);
});

test("terminal retries are idempotent for identical outcomes and reject conflicts", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Terminal",
				workflow: { kind: "ticket", state: "done", action: "none" },
			},
		],
	});
	await tracker.appendLog("123", {
		type: "action_succeeded",
		runId: "run-1",
		payload: { event: "succeed", to: { state: "done", action: "none" } },
	});

	const retry = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ merged: true }),
		},
	);
	assert.equal(retry.ok, true);
	assert.equal((await tracker.readLogs("123")).length, 1);
	assert.deepEqual(
		await execute(["fail", "123", "--run", "run-1", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ merged: true }),
		}),
		{
			ok: false,
			error: {
				code: "CONFLICTING_TERMINAL_OUTCOME",
				message: "Workflow run already has a different terminal outcome.",
				details: { id: "123", runId: "run-1" },
			},
		},
	);
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

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual((envelope.data as { runs: unknown }).runs, {
		activeRunId: "run-crash",
		attempts: [{ runId: "run-crash", status: "running" }],
	});
});

const defaultTicketOnlyReadyManifest = defineManifest({
	version: "v1",
	workflow: { id: "test-workflow" },
	vocabulary: {
		states: ["ready", "running", "done"],
		actions: ["plan", "implement", "none"],
		events: ["start", "succeed"],
	},
	github: {
		labelPrefixes: {
			kind: "type:",
			state: "state:",
			action: "action:",
			reason: "reason:",
		},
	},
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { ticket: 3 } },
	readiness: {
		filters: [{ kind: "ticket", state: "ready", action: "implement" }],
	},
	kinds: [
		{
			id: "spec",
			label: "type:spec",
			initial: { state: "ready", action: "plan" },
			transitions: [
				{
					from: { state: "ready", action: "plan" },
					event: "start",
					to: { state: "running", action: "plan" },
				},
				{
					from: { state: "running", action: "plan" },
					event: "succeed",
					to: { state: "done", action: "none" },
				},
			],
		},
		{
			id: "ticket",
			label: "type:ticket",
			initial: { state: "ready", action: "implement" },
			transitions: [
				{
					from: { state: "ready", action: "implement" },
					event: "start",
					to: { state: "running", action: "implement" },
				},
				{
					from: { state: "running", action: "implement" },
					event: "succeed",
					to: { state: "done", action: "none" },
				},
			],
		},
	],
	commands: [],
});

test("invalid arguments return a stable parse error envelope", async () => {
	const envelope = await execute(["succeed", "123"]);

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "INVALID_ARGUMENTS",
			message: "Invalid command arguments.",
			details: { usage: "awf succeed <id> --run <run> --input <file|->" },
		},
	});
});

test("envelopes serialize as one JSON stdout line", () => {
	assert.equal(
		serializeEnvelope({ ok: true, data: { smoke: true } }),
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});
