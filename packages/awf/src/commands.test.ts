import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./commands.ts";
import { defaultManifest } from "./default-manifest.ts";
import { serializeEnvelope } from "./envelope.ts";
import { defineManifest, type WorkflowManifest } from "./manifest.ts";
import { createInMemoryTracker, type Tracker } from "./tracker.ts";

test("help returns a stable success envelope", async () => {
	const envelope = await execute(["--help"]);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		name: string;
		description: string;
		commands: Array<{ name: string; usage: string }>;
	};
	assert.equal(data.name, "awf");
	assert.equal(data.description, "Agent workflow CLI.");
	assert.ok(Array.isArray(data.commands));
	assert.ok(
		data.commands.some((command) => command.usage === "awf start <id>"),
	);
	assert.ok(
		data.commands.some(
			(command) =>
				command.usage ===
				"awf create handoff --source <issue> --input <file|->",
		),
	);
	assert.ok(data.commands.every((command) => command.name !== "handoff"));
	assert.ok(
		data.commands.every((command) => !command.usage.startsWith("awf handoff")),
	);
});

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

test("help combines runtime commands with manifest CLI targets and readiness filters", async () => {
	const envelope = await execute(["--help"], {
		manifest: {
			...defaultTicketOnlyReadyManifest,
			commands: [
				{
					id: "ticket-create",
					cli: { verb: "create", target: "ticket" },
					target: { kind: "ticket", action: "implement" },
				},
				{
					id: "plan-apply",
					cli: { verb: "apply", target: "brief" },
					target: { kind: "ticket", action: "implement" },
				},
			],
		},
	});

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		commands: Array<{ usage: string }>;
		readiness: {
			filters: Array<{ kind?: string; state?: string; action?: string }>;
			namedFilters: Array<{ name: string; usage: string }>;
		};
	};
	assert.ok(data.commands.some((command) => command.usage === "awf get <id>"));
	assert.ok(
		data.commands.some(
			(command) => command.usage === "awf create ticket --input <file|->",
		),
	);
	assert.ok(
		data.commands.some(
			(command) => command.usage === "awf apply brief <issue> --input <file|->",
		),
	);
	assert.deepEqual(data.readiness.filters, [
		{ kind: "ticket", state: "ready", action: "implement" },
	]);
	assert.deepEqual(data.readiness.namedFilters, [
		{
			name: "spec",
			kind: "spec",
			relationship: "parent",
			usage: "awf ready --filter spec=<spec>",
		},
	]);
});

test("runtime commands reject unsupported workflow manifest relationship projection types", async () => {
	const envelope = await execute(["ready"], {
		manifest: {
			...defaultTicketOnlyReadyManifest,
			relationships: [
				{
					id: "generic-link",
					from: "ticket",
					to: "ticket",
					projection: { type: "link" },
				},
			],
		} as unknown as WorkflowManifest,
	});

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "MANIFEST_VALIDATION_FAILED",
			message: "Workflow manifest validation failed.",
			details: {
				issues: [
					{
						path: "$.relationships[0].projection.type",
						message:
							"Relationship projection type must be parent-child or dependency.",
					},
				],
			},
		},
	});
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
		blocked: [
			{
				id: "20",
				title: "Dependency blocked ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				blocking: [
					{
						gate: "dependency",
						blockedBy: [
							{
								id: "10",
								title: "Ready ticket",
								workflow: {
									kind: "ticket",
									state: "ready",
									action: "implement",
								},
							},
						],
					},
				],
			},
		],
	});
});

test("ready reports dependency-gated Tickets as blocked context while keeping durable fields ready", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "blocker",
				title: "Open blocker",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
			{
				id: "blocked",
				title: "Blocked ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	await tracker.addDependency("blocked", "blocker");

	const envelope = await execute(["ready"], { tracker });

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual(envelope.data, {
		items: [
			{
				id: "blocker",
				title: "Open blocker",
				workflow: { kind: "ticket", state: "ready", action: "review" },
				suggestedCommand: {
					argv: ["start", "blocker"],
					display: "awf start blocker",
				},
			},
		],
		blocked: [
			{
				id: "blocked",
				title: "Blocked ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				blocking: [
					{
						gate: "dependency",
						blockedBy: [
							{
								id: "blocker",
								title: "Open blocker",
								workflow: {
									kind: "ticket",
									state: "ready",
									action: "review",
								},
							},
						],
					},
				],
			},
		],
	});
	assert.deepEqual(
		cleanTestWorkflow((await tracker.getIssue("blocked")).workflow),
		{
			kind: "ticket",
			state: "ready",
			action: "implement",
		},
	);
});

test("ready excludes ready/none Specs as unschedulable waiting work", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec",
				title: "Waiting spec",
				workflow: { kind: "spec", state: "ready", action: "none" },
			},
			{
				id: "ticket",
				title: "Ready ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const envelope = await execute(["ready"], { tracker });

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	assert.deepEqual(
		(envelope.data as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
		["ticket"],
	);
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
	assert.deepEqual(envelope.data, {
		items: [],
		blocked: [
			{
				id: "ready",
				title: "Ready ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				blocking: [
					{
						gate: "concurrency",
						scope: "kind",
						kind: "ticket",
						limit: 1,
						active: 1,
					},
				],
			},
		],
	});
});

test("ready returns deterministic ordering, supports --limit 1, and manifest-named filtering", async () => {
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
		["ready", "--filter", "spec=spec-1", "--limit", "1"],
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

test("ready accepts repeated manifest-named filters", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec 1",
				workflow: { kind: "spec", state: "done", action: "none" },
			},
			{
				id: "ticket-1",
				title: "Ticket 1",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	await tracker.addChild("spec-1", "ticket-1");

	const envelope = await execute(
		["ready", "--filter", "spec=spec-1", "--filter", "parent-spec=spec-1"],
		{
			tracker,
			manifest: {
				...defaultTicketOnlyReadyManifest,
				readiness: {
					filters: [{ kind: "ticket", state: "ready", action: "implement" }],
					namedFilters: [
						{ name: "spec", kind: "spec", relationship: "parent" },
						{ name: "parent-spec", kind: "spec", relationship: "parent" },
					],
				},
			},
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
		["ticket-1"],
	);
});

test("unknown readiness filter names are rejected before tracker reads", async () => {
	const envelope = await execute(["ready", "--filter", "milestone=spec-1"], {
		tracker: createNoTouchTracker(),
		manifest: defaultTicketOnlyReadyManifest,
	});

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "INVALID_READY_FILTER",
			message: "Readiness filter is not declared by the manifest.",
			details: { filter: "milestone" },
		},
	});
});

test("malformed readiness filter expressions return a clear parse error", async () => {
	const envelope = await execute(["ready", "--filter", "spec"], {
		tracker: createNoTouchTracker(),
		manifest: defaultTicketOnlyReadyManifest,
	});

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments for ready.",
			details: { usage: "awf ready [--filter <name=value>] [--limit <n>]" },
		},
	});
});

test("invalid readiness filter values report the value problem", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket 1",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	assert.deepEqual(
		await execute(["ready", "--filter", "spec=missing"], {
			tracker,
			manifest: defaultTicketOnlyReadyManifest,
		}),
		{
			ok: false,
			error: {
				code: "INVALID_READY_FILTER",
				message: "Readiness filter value does not resolve to a workflow issue.",
				details: { filter: "spec", value: "missing" },
			},
		},
	);
	assert.deepEqual(
		await execute(["ready", "--filter", "spec=ticket-1"], {
			tracker,
			manifest: defaultTicketOnlyReadyManifest,
		}),
		{
			ok: false,
			error: {
				code: "INVALID_READY_FILTER",
				message: "Readiness filter value has the wrong workflow kind.",
				details: {
					filter: "spec",
					value: "ticket-1",
					expectedKind: "spec",
					actualKind: "ticket",
				},
			},
		},
	);
});

test("unknown manifest command targets are rejected before tracker mutation", async () => {
	const envelope = await execute(["create", "ticket", "--input", "-"], {
		tracker: createNoTouchTracker(),
		manifest: defaultTicketOnlyReadyManifest,
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
					},
				],
				changes: [],
				log: { ...input.log, issueId: id, sequence: 1 },
			};
		},
	};

	const envelope = await execute(
		["create", "handoff", "--source", "123", "--input", "-"],
		{ tracker, stdin: JSON.stringify({ handoff: "handoff.md" }) },
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

test("failed running actions retry the same ready action by default", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Merge lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "merge",
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["fail", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				verdict: "changes-requested",
				findings: ["bug"],
			}),
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
		{ state: "ready", action: "merge", reason: undefined },
	);
	assert.deepEqual((await tracker.readLogs("123"))[0]?.payload, {
		event: "fail",
		input: { verdict: "changes-requested", findings: ["bug"] },
		to: { state: "ready", action: "merge" },
	});
});

test("explicit escalation moves work to need-human none and logs the reason", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Escalate lifecycle",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const envelope = await execute(["escalate", "123", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({ reason: "review requires product decision" }),
	});

	assert.equal(envelope.ok, true);
	assert.deepEqual(
		(await tracker.getIssue("123")).workflow.state,
		"need-human",
	);
	assert.deepEqual((await tracker.getIssue("123")).workflow.action, "none");
	assert.deepEqual((await tracker.readLogs("123"))[0]?.payload, {
		event: "escalate",
		input: { reason: "review requires product decision" },
		from: { state: "ready", action: "review" },
		to: { state: "need-human", action: "none" },
	});
});

test("explicit resume chooses a valid next ready action", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Resume lifecycle",
				workflow: { kind: "ticket", state: "need-human", action: "none" },
			},
		],
	});

	const envelope = await execute(["resume", "123", "--action", "fix"], {
		tracker,
	});

	assert.equal(envelope.ok, true);
	const issue = await tracker.getIssue("123");
	assert.equal(issue.workflow.state, "ready");
	assert.equal(issue.workflow.action, "fix");
});

test("manifest lifecycle policy constrains retry escalation and resume", async () => {
	const manifest = {
		...defaultManifest,
		lifecycle: {
			retry: { allow: [{ kind: "ticket", action: "implement" }] },
			escalation: { allow: [{ kind: "ticket", action: "implement" }] },
			resume: { allow: [{ kind: "ticket", actions: ["implement"] }] },
		},
	};
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Constrained",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "merge",
					activeRunId: "run-1",
				},
			},
			{
				id: "human",
				title: "Human",
				workflow: { kind: "ticket", state: "need-human", action: "none" },
			},
		],
	});

	assert.equal(
		(
			await execute(["fail", "123", "--run", "run-1", "--input", "-"], {
				tracker,
				manifest,
				stdin: "{}",
			})
		).ok,
		false,
	);
	assert.equal(
		(
			await execute(["escalate", "123", "--input", "-"], {
				tracker,
				manifest,
				stdin: JSON.stringify({ reason: "blocked" }),
			})
		).ok,
		false,
	);
	assert.equal(
		(
			await execute(["resume", "human", "--action", "fix"], {
				tracker,
				manifest,
			})
		).ok,
		false,
	);
});

test("bundled workflow vocabulary and transitions do not include durable blocked", () => {
	assert.ok(!defaultManifest.vocabulary.states.includes("blocked"));
	assert.ok(
		defaultManifest.kinds.every((kind) =>
			kind.transitions.every(
				(transition) =>
					transition.from.state !== "blocked" &&
					transition.to.state !== "blocked",
			),
		),
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

	assert.equal(envelope.ok, true);
	assert.equal((await tracker.getIssue("123")).workflow.activeRunId, undefined);
	assert.deepEqual(
		(envelope.ok ? envelope.data : {}) as Record<string, unknown>,
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

	assert.equal(envelope.ok, true);
	assert.equal((await tracker.getIssue("123")).workflow.activeRunId, "run-1");
	assert.equal(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ applied?: boolean }>;
			}
		).diagnostics[0]?.applied,
		true,
	);
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

	assert.equal(envelope.ok, true);
	assert.equal((await tracker.getIssue("123")).workflow.activeRunId, undefined);
	assert.equal(
		(
			(envelope.ok ? envelope.data : {}) as {
				diagnostics: Array<{ repair: string }>;
			}
		).diagnostics[0]?.repair,
		"need-human",
	);
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
				labels: ["type:ticket", "type:spec", "state:ready", "action:implement"],
			},
			{
				id: "missing",
				title: "Missing labels",
				labels: ["type:ticket", "state:ready"],
			},
		],
	});

	const malformedEnvelope = await execute(["reconcile", "logs"], {
		tracker: malformedLogTracker,
	});
	assert.equal(malformedEnvelope.ok, true);
	assert.equal(
		(malformedEnvelope.ok
			? (malformedEnvelope.data as { diagnostics: Array<{ code: string }> })
			: { diagnostics: [] }
		).diagnostics[0]?.code,
		"MALFORMED_WORKFLOW_LOG",
	);
	for (const [id, code] of [
		["dupe", "DUPLICATE_CURRENT_FIELDS"],
		["missing", "MISSING_CURRENT_METADATA"],
	] as const) {
		const envelope = await execute(["reconcile", id], {
			tracker: duplicateFieldsTracker,
		});
		assert.equal(envelope.ok, true);
		assert.equal(
			(
				(envelope.ok ? envelope.data : {}) as {
					diagnostics: Array<{ code: string }>;
				}
			).diagnostics[0]?.code,
			code,
		);
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
			stdin: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
			}),
		},
	);
	assert.equal(before.ok, false);
	assert.equal(before.ok ? undefined : before.error.code, "RUN_MISMATCH");
	await execute(["reconcile", "123", "--apply"], { tracker });
	const after = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
			}),
		},
	);
	assert.equal(after.ok, true);
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
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
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

function cleanTestWorkflow(workflow: {
	kind: string;
	state: string;
	action?: string;
	reason?: string;
}): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			kind: workflow.kind,
			state: workflow.state,
			action: workflow.action,
			reason: workflow.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
}

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
		createIssue: touched,
		getIssue: touched,
		listIssues: touched,
		updateIssue: touched,
		appendLog: touched,
		readLogs: touched,
		addChild: touched,
		removeChild: touched,
		addDependency: touched,
		removeDependency: touched,
		deleteIssue: touched,
		registerArtifact: touched,
		registerChange: touched,
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

test("envelopes serialize as one JSON stdout line", () => {
	assert.equal(
		serializeEnvelope({ ok: true, data: { smoke: true } }),
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});
