import { assert, test } from "vitest";
import { execute } from "../commands.ts";
import { defineManifest, type WorkflowManifest } from "../manifest.ts";
import type { Tracker } from "../tracker.ts";
import { createInMemoryTracker } from "../trackers/memory.ts";

const defaultTicketOnlyReadyManifest = defineManifest({
	version: "v1",
	workflow: { id: "test-workflow" },
	vocabulary: {
		states: ["ready", "running", "done"],
		actions: ["plan", "implement", "none"],
		events: ["start", "succeed"],
	},
	github: { reservedPrefix: "awf" },
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { ticket: 3 } },
	readiness: {
		filters: [{ kind: "ticket", state: "ready", action: "implement" }],
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
	},
	kinds: [
		{
			id: "spec",
			label: "Spec",
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
			label: "Ticket",
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
	assert.deepEqual(envelope.ok ? envelope.data : undefined, {
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
	assert.deepEqual(
		(envelope.ok ? envelope.data : {}) as Record<string, unknown>,
		{
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
		},
	);
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
	assert.deepEqual(
		(envelope.ok ? envelope.data : { items: [] }).items.map(
			(item: { id: string }) => item.id,
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
	assert.deepEqual(envelope.ok ? envelope.data : undefined, {
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
		{ tracker, manifest: defaultTicketOnlyReadyManifest },
	);

	assert.equal(envelope.ok, true);
	assert.deepEqual(
		(envelope.ok ? envelope.data : { items: [] }).items.map(
			(item: { id: string }) => item.id,
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
	assert.deepEqual(
		(envelope.ok ? envelope.data : { items: [] }).items.map(
			(item: { id: string }) => item.id,
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
		recordCommand: touched,
		advanceWorkflow: touched,
		repairIssue: touched,
		getIssue: touched,
		listIssues: touched,
		readLogs: touched,
	};
}
