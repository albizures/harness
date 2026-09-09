import { expect, it } from "vitest";
import { execute } from "../../../src/commands.ts";
import {
	defineManifest,
	type WorkflowManifest,
} from "../../../src/manifest/index.ts";
import type { Tracker } from "../../../src/tracker.ts";
import { createInMemoryTracker } from "../../../src/trackers/memory.ts";

const defaultTicketOnlyReadyManifest = defineManifest({
	version: "v1",
	workflow: { id: "test-workflow", version: "1.0.0" },
	vocabulary: {
		states: ["ready", "running", "done"],
		actions: ["plan", "implement", "none"],
		events: ["start", "succeed"],
	},
	github: { reservedPrefix: "awf" },
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { ticket: 3 } },
	lifecycle: { activeStates: ["running"], terminalStates: ["done"] },
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

it("should ensure that runtime commands reject unsupported workflow manifest relationship projection types", async () => {
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

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "MANIFEST_VALIDATION_FAILED",
			message: "Workflow manifest validation failed.",
			details: {
				issues: [
					{
						path: "$.relationships[0].projection.type",
						message:
							"Relationship projection type must be parent-child, dependency, or generated-by.",
					},
				],
			},
		},
	});
});

it("should ensure that ready returns legal executable work after dependency, concurrency, active-run, and manifest filters", async () => {
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

	expect(envelope.ok).toBe(true);
	expect(envelope.ok ? envelope.data : undefined).toEqual({
		items: [
			{
				id: "10",
				title: "Ready ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				suggestedCommand: {
					argv: ["run-command", "start", "10"],
					display: "awf run-command start 10",
				},
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

it("should ensure that ready reports dependency-gated Tickets as blocked context while keeping durable fields ready", async () => {
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

	const envelope = await execute(["ready"], {
		tracker,
		manifest: {
			...defaultTicketOnlyReadyManifest,
			vocabulary: {
				...defaultTicketOnlyReadyManifest.vocabulary,
				actions: [
					...defaultTicketOnlyReadyManifest.vocabulary.actions,
					"review",
				],
			},
			readiness: {
				filters: [
					{ kind: "ticket", state: "ready", action: "implement" },
					{ kind: "ticket", state: "ready", action: "review" },
				],
			},
		},
	});

	expect(envelope.ok).toBe(true);
	expect((envelope.ok ? envelope.data : {}) as Record<string, unknown>).toEqual(
		{
			items: [
				{
					id: "blocker",
					title: "Open blocker",
					workflow: { kind: "ticket", state: "ready", action: "review" },
					suggestedCommand: {
						argv: ["run-command", "start", "blocker"],
						display: "awf run-command start blocker",
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
	expect(
		cleanTestWorkflow((await tracker.getIssue("blocked")).workflow),
	).toEqual({
		kind: "ticket",
		state: "ready",
		action: "implement",
	});
});

it("should ensure that ready applies generic manifest relationship policies without bundled Spec special cases", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "goal-ready",
				title: "Goal ready",
				workflow: { kind: "spec", state: "ready", action: "plan" },
				relationships: { children: ["done-task"] },
			},
			{
				id: "goal-blocked",
				title: "Goal blocked",
				workflow: { kind: "spec", state: "ready", action: "plan" },
				relationships: { children: ["open-task"] },
			},
			{
				id: "goal-waiting",
				title: "Goal waiting",
				workflow: { kind: "spec", state: "ready", action: "plan" },
				relationships: { children: ["waiting-task"] },
			},
			{
				id: "done-task",
				title: "Done task",
				workflow: { kind: "ticket", state: "done", action: "none" },
				relationships: { parent: "goal-ready" },
			},
			{
				id: "open-task",
				title: "Open task",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				relationships: { parent: "goal-blocked" },
			},
			{
				id: "waiting-task",
				title: "Waiting task",
				workflow: { kind: "ticket", state: "waiting-human", action: "none" },
				relationships: { parent: "goal-waiting" },
			},
		],
	});

	const envelope = await execute(["ready"], {
		tracker,
		manifest: {
			...defaultTicketOnlyReadyManifest,
			readiness: {
				filters: [{ kind: "spec", state: "ready", action: "plan" }],
				relationshipPolicies: [
					{
						relationship: "children",
						where: { kind: "spec", state: "ready", action: "plan" },
						children: { all: { kind: "ticket", state: "done" }, min: 1 },
						gate: "children-done",
					},
				],
			},
		},
	});

	expect(envelope.ok).toBe(true);
	expect(envelope.ok ? envelope.data : undefined).toEqual({
		items: [
			{
				id: "goal-ready",
				title: "Goal ready",
				workflow: { kind: "spec", state: "ready", action: "plan" },
				suggestedCommand: {
					argv: ["run-command", "start", "goal-ready"],
					display: "awf run-command start goal-ready",
				},
			},
		],
		blocked: [
			{
				id: "goal-blocked",
				title: "Goal blocked",
				workflow: { kind: "spec", state: "ready", action: "plan" },
				blocking: [
					{
						gate: "children-done",
						relationship: "children",
						minimum: 1,
						blockedBy: [
							{
								id: "open-task",
								title: "Open task",
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
			{
				id: "goal-waiting",
				title: "Goal waiting",
				workflow: { kind: "spec", state: "ready", action: "plan" },
				blocking: [
					{
						gate: "children-done",
						relationship: "children",
						minimum: 1,
						blockedBy: [
							{
								id: "waiting-task",
								title: "Waiting task",
								workflow: {
									kind: "ticket",
									state: "waiting-human",
									action: "none",
								},
							},
						],
					},
				],
			},
		],
	});
});

it("should ensure that ready excludes ready/none Specs as unschedulable waiting work", async () => {
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

	const envelope = await execute(["ready"], {
		tracker,
		manifest: defaultTicketOnlyReadyManifest,
	});

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	expect(
		(envelope.data as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
	).toEqual(["ticket"]);
});

it("should ensure that ready excludes candidates blocked by manifest concurrency limits", async () => {
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

	expect(envelope.ok).toBe(true);
	expect(envelope.ok ? envelope.data : undefined).toEqual({
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

it("should ensure that ready blocks tasks when applicable subkind concurrency is saturated", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "running-research",
				title: "Running research ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-research",
					data: { subkind: "research" },
				},
			},
			{
				id: "ready-research",
				title: "Ready research ticket",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					data: { subkind: "research" },
				},
			},
			{
				id: "ready-work",
				title: "Ready work ticket",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					data: { subkind: "work" },
				},
			},
		],
	});

	const envelope = await execute(["ready"], {
		tracker,
		manifest: {
			...defaultTicketOnlyReadyManifest,
			concurrency: {
				perIssue: 1,
				perWorkflow: 3,
				perKind: { ticket: 3 },
				perSubkind: { ticket: { research: 1 } },
			},
			kinds: defaultTicketOnlyReadyManifest.kinds.map((kind) =>
				kind.id === "ticket"
					? { ...kind, subkinds: ["research", "work"] }
					: kind,
			),
		},
	});

	expect(envelope.ok).toBe(true);
	expect(envelope.ok ? envelope.data : undefined).toEqual({
		items: [
			{
				id: "ready-work",
				title: "Ready work ticket",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					subkind: "work",
				},
				suggestedCommand: {
					argv: ["run-command", "start", "ready-work"],
					display: "awf run-command start ready-work",
				},
			},
		],
		blocked: [
			{
				id: "ready-research",
				title: "Ready research ticket",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					subkind: "research",
				},
				blocking: [
					{
						gate: "concurrency",
						scope: "subkind",
						kind: "ticket",
						subkind: "research",
						limit: 1,
						active: 1,
					},
				],
			},
		],
	});
});

it("should ensure that ready treats a missing subkind as the kind default for concurrency", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "running-work",
				title: "Running default work ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-work",
				},
			},
			{
				id: "ready-work",
				title: "Ready default work ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const envelope = await execute(["ready"], {
		tracker,
		manifest: {
			...defaultTicketOnlyReadyManifest,
			concurrency: {
				perIssue: 1,
				perWorkflow: 3,
				perKind: { ticket: 3 },
				perSubkind: { ticket: { work: 1 } },
			},
			kinds: defaultTicketOnlyReadyManifest.kinds.map((kind) =>
				kind.id === "ticket" ? { ...kind, subkinds: ["work"] } : kind,
			),
		},
	});

	expect(envelope.ok).toBe(true);
	expect(envelope.ok ? envelope.data : undefined).toEqual({
		items: [],
		blocked: [
			{
				id: "ready-work",
				title: "Ready default work ticket",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					subkind: "work",
				},
				blocking: [
					{
						gate: "concurrency",
						scope: "subkind",
						kind: "ticket",
						subkind: "work",
						limit: 1,
						active: 1,
					},
				],
			},
		],
	});
});

it("should ensure that ready returns deterministic ordering, supports --limit 1, and manifest-named filtering", async () => {
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

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	expect(
		(envelope.data as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
	).toEqual(["1"]);
});

it("should ensure that ready accepts repeated manifest-named filters", async () => {
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

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	expect(
		(envelope.data as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
	).toEqual(["ticket-1"]);
});

it("should ensure that unknown readiness filter names are rejected before tracker reads", async () => {
	const envelope = await execute(["ready", "--filter", "milestone=spec-1"], {
		tracker: createNoTouchTracker(),
		manifest: defaultTicketOnlyReadyManifest,
	});

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "INVALID_READY_FILTER",
			message: "Readiness filter is not declared by the manifest.",
			details: { filter: "milestone" },
		},
	});
});

it("should ensure that malformed readiness filter expressions return a clear parse error", async () => {
	const envelope = await execute(["ready", "--filter", "spec"], {
		tracker: createNoTouchTracker(),
		manifest: defaultTicketOnlyReadyManifest,
	});

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "INVALID_ARGUMENTS",
			message: "Invalid arguments for ready.",
			details: { usage: "awf ready [--filter <name=value>] [--limit <n>]" },
		},
	});
});

it("should ensure that invalid readiness filter values report the value problem", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket 1",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	expect(
		await execute(["ready", "--filter", "spec=missing"], {
			tracker,
			manifest: defaultTicketOnlyReadyManifest,
		}),
	).toEqual({
		ok: false,
		error: {
			code: "INVALID_READY_FILTER",
			message: "Readiness filter value does not resolve to a workflow issue.",
			details: { filter: "spec", value: "missing" },
		},
	});
	expect(
		await execute(["ready", "--filter", "spec=ticket-1"], {
			tracker,
			manifest: defaultTicketOnlyReadyManifest,
		}),
	).toEqual({
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
	});
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
		escalateWorkflow: touched,
		resumeWorkflow: touched,
		changeRelationship: touched,
		applyWorkflowEffects: touched,
		recordCommand: touched,
		advanceWorkflow: touched,
		repairIssue: touched,
		getIssue: touched,
		listIssues: touched,
		readLogs: touched,
	};
}
