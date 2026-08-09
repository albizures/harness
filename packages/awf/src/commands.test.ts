import { assert, test } from "vitest";
import { z } from "zod";
import { execute } from "./commands.ts";
import { defaultManifest } from "./default-manifest.ts";
import { defineManifest } from "./manifest.ts";
import type { Tracker } from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

test("fixed handoff runtime command is not publicly accepted", async () => {
	const envelope = await execute(["handoff", "ticket-1", "--input", "-"]);

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "handoff ticket-1 --input -" },
		},
	});
});

test("unknown manifest command targets are rejected before tracker mutation", async () => {
	const envelope = await execute(["create", "ticket", "--input", "-"], {
		tracker: createNoTouchTracker(),
		manifest: defaultManifest,
		stdin: "# Ticket\n",
	});

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND_TARGET",
			message: "Workflow command target is not declared by the manifest.",
			details: { command: "create ticket" },
		},
	});
});

test("create spec records one high-level tracker intent with initial current fields and log", async () => {
	const intents: Array<string> = [];
	const tracker: Tracker = {
		...createNoTouchTracker(),
		createWorkflowIssue: async (input) => {
			intents.push("createWorkflowIssue");
			assert.equal(input.title, "Build lifecycle intents");
			assert.equal(input.workflow.kind, "spec");
			assert.equal(input.workflow.state, "ready");
			assert.equal(input.workflow.action, "plan");
			assert.equal(input.initialLog?.type, "spec_created");
			return {
				issue: {
					id: "1",
					title: input.title,
					body: input.body,
					workflow: {
						...input.workflow,
						version: 1,
						hash: "hash",
					},
					relationships: {
						children: [],
						dependencies: [],
						dependents: [],
					},
					artifacts: [],
					changes: [],
				},
				log: {
					...input.initialLog,
					issueId: "1",
					sequence: 1,
					type: input.initialLog?.type ?? "missing",
				},
			};
		},
	};

	const envelope = await execute(["create", "spec", "--input", "-"], {
		tracker,
		stdin: "# Build lifecycle intents\n\nUse Tracker intents.",
	});

	assert.equal(envelope.ok, true);
	assert.deepEqual(intents, ["createWorkflowIssue"]);
});

test("create handoff records artifact and log through one tracker intent", async () => {
	const seed = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});
	const issue = await seed.getIssue("123");
	const intents: Array<string> = [];
	const tracker: Tracker = {
		...createNoTouchTracker(),
		getIssue: async (id) => {
			assert.equal(id, "123");
			return issue;
		},
		recordArtifacts: async (id, input) => {
			intents.push("recordArtifacts");
			assert.equal(id, "123");
			assert.deepEqual(input.artifacts, [
				{
					kind: "handoff",
					uri: "handoff.md",
					name: "Handoff",
					type: "handoff",
					ref: "handoff.md",
				},
			]);
			assert.equal(input.log.type, "handoff_created");
			return {
				issue,
				artifacts: [
					{
						id: "artifact-1",
						kind: "handoff",
						uri: "handoff.md",
						name: "Handoff",
						type: "handoff",
						ref: "handoff.md",
					},
				],
				changes: [],
				log: { ...input.log, issueId: id, sequence: 1 },
			};
		},
	};

	const envelope = await execute(
		["create", "handoff", "--source", "123", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				handoff: { type: "handoff", ref: "handoff.md" },
			}),
		},
	);

	assert.equal(envelope.ok, true);
	assert.deepEqual(intents, ["recordArtifacts"]);
});

test("start records one high-level tracker intent instead of low-level writes", async () => {
	const seed = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	const issue = await seed.getIssue("123");
	const intents: Array<string> = [];
	const tracker: Tracker = {
		...createNoTouchTracker(),
		getIssue: async (id) => {
			assert.equal(id, "123");
			return issue;
		},
		startRun: async (id, input) => {
			intents.push("startRun");
			assert.equal(id, "123");
			assert.deepEqual(input.expect, {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			});
			assert.equal(input.workflow.state, "running");
			assert.equal(input.workflow.action, "implement");
			assert.equal(input.log.type, "action_started");
			assert.equal(input.log.runId, input.runId);
			return {
				issue: {
					...issue,
					workflow: {
						...issue.workflow,
						state: "running",
						activeRunId: input.runId,
					},
				},
				log: { ...input.log, issueId: id, sequence: 1 },
			};
		},
	};

	const envelope = await execute(["start", "123"], { tracker });

	assert.equal(envelope.ok, true);
	assert.deepEqual(intents, ["startRun"]);
});

const syntheticManifest = defineManifest({
	version: "v1",
	workflow: { id: "synthetic" },
	vocabulary: {
		states: ["draft", "ready", "running", "done"],
		actions: ["refine", "promote", "none"],
		events: ["start", "succeed"],
	},
	github: { reservedPrefix: "awf" },
	concurrency: { perIssue: 1, perWorkflow: 4 },
	readiness: {
		filters: [{ kind: "idea", state: "ready", action: "promote" }],
		namedFilters: [{ name: "goal", kind: "goal", relationship: "parent" }],
	},
	kinds: [
		{
			id: "goal",
			label: "Goal",
			initial: { state: "done", action: "none" },
			transitions: [],
		},
		{
			id: "idea",
			label: "Idea",
			initial: { state: "ready", action: "promote" },
			transitions: [
				{
					from: { state: "ready", action: "promote" },
					event: "start",
					to: { state: "running", action: "promote" },
				},
				{
					from: { state: "running", action: "promote" },
					event: "succeed",
					to: { state: "done", action: "none" },
				},
			],
		},
	],
	commands: [
		{
			id: "idea-create",
			cli: { verb: "create", target: "idea" },
			target: { kind: "idea", action: "promote" },
			input: z.strictObject({
				title: z.string().min(1),
				body: z.string().min(1),
			}),
		},
		{
			id: "idea-promote",
			cli: { verb: "apply", target: "promotion" },
			target: { kind: "idea", action: "promote" },
			input: z.strictObject({ note: z.string().min(1) }),
		},
	],
	relationships: [
		{
			id: "goal-ideas",
			from: "goal",
			to: "idea",
			projection: { type: "parent-child", direction: "outbound" },
		},
	],
});

test("synthetic workflow command surface dispatches only declared create/apply targets and readiness filters", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "goal-1",
				title: "Goal",
				workflow: { kind: "goal", state: "done", action: "none" },
			},
			{
				id: "idea-1",
				title: "Promotable idea",
				workflow: { kind: "idea", state: "ready", action: "promote" },
			},
		],
	});
	await tracker.addChild("goal-1", "idea-1");

	const ready = await execute(["ready", "--filter", "goal=goal-1"], {
		tracker,
		manifest: syntheticManifest,
	});
	assert.equal(ready.ok, true);
	assert.deepEqual(
		(
			ready as { ok: true; data: { items: Array<{ id: string }> } }
		).data.items.map((item) => item.id),
		["idea-1"],
	);
	assert.deepEqual(
		await execute(["ready", "--filter", "spec=goal-1"], {
			tracker,
			manifest: syntheticManifest,
		}),
		{
			ok: false,
			error: {
				code: "INVALID_READY_FILTER",
				message: "Readiness filter is not declared by the manifest.",
				details: { filter: "spec" },
			},
		},
	);

	const created = await execute(["create", "idea", "--input", "-"], {
		tracker,
		manifest: syntheticManifest,
		stdin: JSON.stringify({ title: "New idea", body: "Explore it." }),
	});
	assert.equal(created.ok, true);
	assert.equal(
		(created as { ok: true; data: { issue: { title: string } } }).data.issue
			.title,
		"New idea",
	);
	assert.deepEqual(
		(
			await tracker.readLogs(
				(created as { ok: true; data: { issue: { id: string } } }).data.issue
					.id,
			)
		).map((log) => log.type),
		["idea-create_created"],
	);

	const applied = await execute(
		["apply", "promotion", "idea-1", "--input", "-"],
		{
			tracker,
			manifest: syntheticManifest,
			stdin: JSON.stringify({ note: "Promote this idea." }),
		},
	);
	assert.equal(applied.ok, true);
	assert.deepEqual(
		(await tracker.readLogs("idea-1")).map((log) => log.type),
		["idea-promote_applied"],
	);

	assert.equal(
		(
			await execute(["create", "spec", "--input", "-"], {
				tracker,
				manifest: syntheticManifest,
				stdin: JSON.stringify({ title: "Wrong", body: "Wrong" }),
			})
		).ok,
		false,
	);
	assert.equal(
		(
			await execute(["apply", "plan", "idea-1", "--input", "-"], {
				tracker,
				manifest: syntheticManifest,
				stdin: JSON.stringify({ note: "Wrong" }),
			})
		).ok,
		false,
	);
});

function createNoTouchTracker(): Tracker {
	const touched = () => {
		throw new Error("tracker should not be touched");
	};
	return {
		createWorkflowIssue: touched,
		startRun: touched,
		completeRun: touched,
		recordArtifacts: touched,
		escalateWorkflow: touched,
		resumeWorkflow: touched,
		changeRelationship: touched,
		applyPlan: touched,
		recordCommand: touched,
		advanceWorkflow: touched,
		repairIssue: touched,
		getIssue: touched,
		listIssues: touched,
		readLogs: touched,
	};
}

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
