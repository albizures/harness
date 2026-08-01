import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { execute } from "./commands.ts";
import { defaultManifest } from "./default-manifest.ts";
import type { WorkflowManifest } from "./manifest.ts";
import {
	createInMemoryTracker,
	type Tracker,
	type WorkflowIssue,
} from "./tracker.ts";

type CreateSpecData = { issue: WorkflowIssue };
type ApplyPlanData = { outcome: string; tickets: Array<{ key: string }> };
type ReadyData = { items: Array<{ id: string }> };
type HandoffData = { artifact: { kind: string; uri: string } };

test("create spec creates a bundled workflow Spec from Markdown input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-spec-"));
	const input = join(dir, "spec.md");
	await writeFile(input, "# Build a thing\n\nDetailed goal.\n", "utf8");
	const tracker = createInMemoryTracker();

	const envelope = await execute(["create", "spec", "--input", input], {
		tracker,
	});

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as CreateSpecData;
	assert.equal(data.issue.title, "Build a thing");
	assert.equal(data.issue.body, "# Build a thing\n\nDetailed goal.\n");
	assert.deepEqual(pickWorkflow(data.issue.workflow), {
		kind: "spec",
		state: "ready",
		action: "plan",
	});
	assert.deepEqual(
		(await tracker.readLogs(data.issue.id)).map((log) => log.type),
		["spec_created"],
	);
});

test("create targets dispatch through manifest CLI declarations", async () => {
	const tracker = createInMemoryTracker();
	const manifest: WorkflowManifest = {
		...defaultManifest,
		commands: defaultManifest.commands.map((command) =>
			command.id === "spec-create"
				? { ...command, cli: { verb: "create", target: "brief" } }
				: command,
		),
	};

	const envelope = await execute(["create", "brief", "--input", "-"], {
		tracker,
		manifest,
		stdin: "# Manifest target\n",
	});

	assert.equal(envelope.ok, true);
	assert.equal(
		(envelope as { ok: true; data: CreateSpecData }).data.issue.title,
		"Manifest target",
	);

	const unknown = await execute(["create", "spec", "--input", "-"], {
		tracker,
		manifest,
		stdin: "# Not declared\n",
	});
	assert.equal(unknown.ok, false);
	assert.equal(
		unknown.ok ? undefined : unknown.error.code,
		"UNKNOWN_COMMAND_TARGET",
	);
});

test("create spec validates the bundled manifest-declared input before mutating", async () => {
	const tracker = createInMemoryTracker();
	const manifest = manifestWithCommandSchema("spec-create", {
		input: z.strictObject({ spec: z.number().int() }),
	});

	const envelope = await execute(["create", "spec", "--input", "-"], {
		tracker,
		manifest,
		stdin: "# Build a thing\n",
	});

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.code,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	assert.deepEqual(await tracker.listIssues(), []);
});

test("create handoff validates input and attaches a Handoff artifact to the source issue", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const envelope = await execute(
		["create", "handoff", "--source", "ticket-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ handoff: "Next agent: inspect the retry path." }),
		},
	);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as HandoffData;
	assert.deepEqual(data.artifact, {
		id: "artifact-1",
		kind: "handoff",
		uri: "Next agent: inspect the retry path.",
		name: "Handoff",
	});
	assert.deepEqual((await tracker.getIssue("ticket-1")).artifacts, [
		data.artifact,
	]);
	assert.deepEqual(
		(await tracker.readLogs("ticket-1")).map((log) => log.type),
		["handoff_created"],
	);
});

test("create handoff rejects invalid manifest-declared input before mutating", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const envelope = await execute(
		["create", "handoff", "--source", "ticket-1", "--input", "-"],
		{ tracker, stdin: JSON.stringify({ handoff: "" }) },
	);

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.code,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	assert.deepEqual((await tracker.getIssue("ticket-1")).artifacts, []);
	assert.deepEqual(await tracker.readLogs("ticket-1"), []);
});

test("apply targets dispatch through manifest CLI declarations", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const manifest: WorkflowManifest = {
		...defaultManifest,
		commands: defaultManifest.commands.map((command) =>
			command.id === "plan-apply"
				? { ...command, cli: { verb: "apply", target: "roadmap" } }
				: command,
		),
	};

	const envelope = await execute(
		["apply", "roadmap", "spec-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({
				tickets: [{ key: "a", title: "A", content: "Do A." }],
			}),
		},
	);

	assert.equal(envelope.ok, true);
	assert.deepEqual(
		(await tracker.readLogs("spec-1")).map((log) => log.type),
		["plan_applied"],
	);

	const unknownTracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-2",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const unknown = await execute(["apply", "plan", "spec-2", "--input", "-"], {
		tracker: unknownTracker,
		manifest,
		stdin: JSON.stringify({
			tickets: [{ key: "b", title: "B", content: "Do B." }],
		}),
	});

	assert.equal(unknown.ok, false);
	assert.equal(
		unknown.ok ? undefined : unknown.error.code,
		"UNKNOWN_COMMAND_TARGET",
	);
	assert.deepEqual(
		(await unknownTracker.listIssues()).map((issue) => issue.id),
		["spec-2"],
	);
	assert.deepEqual(await unknownTracker.readLogs("spec-2"), []);
});

test("apply plan requires the active manifest plan apply declaration before mutating", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const manifest: WorkflowManifest = {
		...defaultManifest,
		commands: defaultManifest.commands.map((command) =>
			command.id === "plan-apply" ? { ...command, cli: undefined } : command,
		),
	};

	const envelope = await execute(["apply", "plan", "spec-1", "--input", "-"], {
		tracker,
		manifest,
		stdin: JSON.stringify({
			tickets: [{ key: "a", title: "A", content: "Do A." }],
		}),
	});

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.code,
		"UNKNOWN_COMMAND_TARGET",
	);
	assert.deepEqual(
		(await tracker.listIssues()).map((issue) => issue.id),
		["spec-1"],
	);
	assert.deepEqual(await tracker.readLogs("spec-1"), []);
});

test("apply plan creates tickets, relationships, dependencies, logs application, and leaves the Spec unschedulable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-plan-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [
				{ key: "setup", title: "Set up", content: "Create foundation." },
				{
					key: "finish",
					title: "Finish",
					content: "Complete work.",
					dependsOn: ["setup"],
				},
			],
		}),
		"utf8",
	);
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
	});

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as ApplyPlanData;
	assert.equal(data.outcome, "SUCCESS");
	assert.deepEqual(
		data.tickets.map((ticket) => ticket.key),
		["setup", "finish"],
	);
	const spec = await tracker.getIssue("spec-1");
	assert.deepEqual(pickWorkflow(spec.workflow), {
		kind: "spec",
		state: "ready",
		action: "none",
	});
	assert.deepEqual(spec.relationships.children, ["1", "2"]);
	assert.deepEqual((await tracker.getIssue("2")).relationships.dependencies, [
		"1",
	]);
	const ready = await execute(["ready", "--filter", "spec=spec-1"], {
		tracker,
	});
	assert.equal(ready.ok, true);
	if (!ready.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual(
		(ready.data as ReadyData).items.map((item) => item.id),
		["1"],
	);
	assert.deepEqual(
		(await tracker.readLogs("spec-1")).map((log) => log.type),
		["plan_applied"],
	);
});

test("apply plan rejects manifest-invalid command input before mutating the tracker", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const manifest = manifestWithPlanCommandSchema({
		input: z.strictObject({ tickets: z.number().int() }),
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", "-"], {
		tracker,
		manifest,
		stdin: JSON.stringify({ tickets: [] }),
	});

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.code,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	assert.deepEqual(
		(await tracker.listIssues()).map((issue) => issue.id),
		["spec-1"],
	);
	assert.deepEqual(await tracker.readLogs("spec-1"), []);
});

test("apply plan reports manifest-invalid command output instead of returning success", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-bad-output-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [{ key: "a", title: "A", content: "A" }],
		}),
		"utf8",
	);
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const manifest = manifestWithPlanCommandSchema({
		output: z.object({ tickets: z.number().int() }),
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
		manifest,
	});

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.code,
		"WORKFLOW_COMMAND_OUTPUT_VALIDATION_FAILED",
	);
	assert.equal((await tracker.getIssue("spec-1")).workflow.action, "none");
	assert.deepEqual(
		(await tracker.readLogs("spec-1")).map((log) => log.type),
		["plan_applied"],
	);
});

test("apply plan rejects invalid bundles before mutating the tracker", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-bad-plan-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [
				{ key: "a", title: "A", content: "A" },
				{ key: "a", title: "Duplicate", content: "Duplicate" },
			],
		}),
		"utf8",
	);
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
	});

	assert.equal(envelope.ok, false);
	assert.equal(envelope.ok ? undefined : envelope.error.code, "INVALID_PLAN");
	assert.deepEqual(
		(await tracker.listIssues()).map((issue) => issue.id),
		["spec-1"],
	);
	assert.deepEqual(await tracker.readLogs("spec-1"), []);
});

test("apply plan rolls back created tickets when a later mutation fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-rollback-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [{ key: "a", title: "A", content: "A" }],
		}),
		"utf8",
	);
	const base = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const tracker: Tracker = failingTracker(base, {
		appendLog: async () => {
			throw new Error("log failed");
		},
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
	});

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.details?.outcome,
		"ROLLED_BACK",
	);
	assert.deepEqual(
		(await base.listIssues()).map((issue) => issue.id),
		["spec-1"],
	);
	assert.deepEqual(pickWorkflow((await base.getIssue("spec-1")).workflow), {
		kind: "spec",
		state: "ready",
		action: "plan",
	});
});

test("apply plan escalates to need-human/none when rollback is partial", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-partial-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [{ key: "a", title: "A", content: "A" }],
		}),
		"utf8",
	);
	const base = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const tracker: Tracker = failingTracker(base, {
		appendLog: async () => {
			throw new Error("log failed");
		},
		deleteIssue: async () => {
			throw new Error("delete failed");
		},
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
	});

	assert.equal(envelope.ok, false);
	assert.equal(
		envelope.ok ? undefined : envelope.error.details?.outcome,
		"PARTIAL_ROLLBACK",
	);
	assert.deepEqual(pickWorkflow((await base.getIssue("spec-1")).workflow), {
		kind: "spec",
		state: "need-human",
		action: "none",
	});
});

function manifestWithPlanCommandSchema(
	schemas: Pick<WorkflowManifest["commands"][number], "input" | "output">,
): WorkflowManifest {
	return manifestWithCommandSchema("plan-apply", schemas);
}

function manifestWithCommandSchema(
	id: string,
	schemas: Pick<WorkflowManifest["commands"][number], "input" | "output">,
): WorkflowManifest {
	return {
		...defaultManifest,
		commands: defaultManifest.commands.map((command) =>
			command.id === id ? { ...command, ...schemas } : command,
		),
	};
}

function pickWorkflow(workflow: {
	kind: string;
	state: string;
	action: string;
}): { kind: string; state: string; action: string } {
	return {
		kind: workflow.kind,
		state: workflow.state,
		action: workflow.action,
	};
}

function failingTracker(base: Tracker, overrides: Partial<Tracker>): Tracker {
	return {
		createIssue: base.createIssue.bind(base),
		getIssue: base.getIssue.bind(base),
		listIssues: base.listIssues.bind(base),
		updateIssue: base.updateIssue.bind(base),
		appendLog: base.appendLog.bind(base),
		readLogs: base.readLogs.bind(base),
		addChild: base.addChild.bind(base),
		removeChild: base.removeChild.bind(base),
		addDependency: base.addDependency.bind(base),
		removeDependency: base.removeDependency.bind(base),
		deleteIssue: base.deleteIssue.bind(base),
		registerArtifact: base.registerArtifact.bind(base),
		registerChange: base.registerChange.bind(base),
		...overrides,
	};
}
