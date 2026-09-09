import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	execute as rawExecute,
	type CommandHandlers,
} from "../../../src/commands.ts";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";

import type { WorkflowManifest } from "../../../src/manifest/index.ts";
import {
	NeedReconciliationError,
	type Tracker,
	type TrackerAdapter,
} from "../../../src/tracker.ts";
import { createInMemoryTracker } from "../../../src/trackers/memory.ts";
import type { WorkflowIssue } from "../../../src/workflow/issue.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}
type CreateSpecData = { issue: WorkflowIssue };
type ApplyPlanData = {
	outcome: string;
	tickets: Array<{ key: string }>;
};
type ReadyData = { items: Array<{ id: string }> };
type HandoffData = { log: { type: string } };

it("should ensure that create spec creates a bundled workflow Spec from Markdown input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-spec-"));
	const input = join(dir, "spec.md");
	await writeFile(input, "# Build a thing\n\nDetailed goal.\n", "utf8");
	const tracker = createInMemoryTracker();

	const envelope = await execute(["create", "spec", "--input", input], {
		tracker,
	});

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as CreateSpecData;
	expect(data.issue.title).toBe("Build a thing");
	expect(data.issue.body).toBe("# Build a thing\n\nDetailed goal.\n");
	expect(pickWorkflow(data.issue.workflow)).toEqual({
		kind: "spec",
		state: "ready",
		action: "plan",
	});
	expect(
		(await tracker.readLogs(data.issue.id)).map((log) => log.type),
	).toEqual(["spec_created"]);
});

it("should ensure that create spec records one generic workflow effects intent with initial current fields and log", async () => {
	const intents: Array<string> = [];
	const tracker: Tracker = {
		...createNoTouchTracker(),
		applyWorkflowEffects: async ({ effects }) => {
			intents.push("applyWorkflowEffects");
			expect(effects).toHaveLength(1);
			const effect = effects[0];
			expect(effect?.type).toBe("create-workflow-issue");
			if (effect?.type !== "create-workflow-issue") {
				throw new Error("expected create workflow issue effect");
			}
			expect(effect.input.title).toBe("Build lifecycle intents");
			expect(effect.input.workflow.kind).toBe("spec");
			expect(effect.input.workflow.state).toBe("ready");
			expect(effect.input.workflow.action).toBe("plan");
			expect(effect.input.workflow.semanticVersion).toBe(
				agentDevelopmentManifest.workflow.version,
			);
			expect(effect.initialLog?.type).toBe("spec_created");
			const issue: WorkflowIssue = {
				id: "1",
				title: effect.input.title,
				body: effect.input.body,
				workflow: {
					...effect.input.workflow,
					version: 1,
					hash: "hash",
				},
				relationships: {
					children: [],
					dependencies: [],
					dependents: [],
				},
			};
			return {
				issues: { "1": issue },
				createdIssues: [{ id: "1", issue }],
				logs: [
					{
						...effect.initialLog,
						issueId: "1",
						sequence: 1,
						type: effect.initialLog?.type ?? "missing",
					},
				],
			};
		},
	};

	const envelope = await execute(["create", "spec", "--input", "-"], {
		tracker,
		stdin: "# Build lifecycle intents\n\nUse Tracker intents.",
	});

	expect(envelope.ok).toBe(true);
	expect(intents).toEqual(["applyWorkflowEffects"]);
});

it("should ensure that create targets dispatch through manifest CLI declarations", async () => {
	const tracker = createInMemoryTracker();
	const manifest: WorkflowManifest = {
		...agentDevelopmentManifest,
		commands: agentDevelopmentManifest.commands.map((command) =>
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

	expect(envelope.ok).toBe(true);
	expect(
		(envelope as { ok: true; data: CreateSpecData }).data.issue.title,
	).toBe("Manifest target");

	const unknown = await execute(["create", "spec", "--input", "-"], {
		tracker,
		manifest,
		stdin: "# Not declared\n",
	});
	expect(unknown.ok).toBe(false);
	expect(unknown.ok ? undefined : unknown.error.code).toBe(
		"UNKNOWN_COMMAND_TARGET",
	);
});

it("should ensure that create spec validates the bundled manifest-declared input before mutating", async () => {
	const tracker = createInMemoryTracker();
	const manifest = manifestWithCommandSchema("spec-create", {
		input: z.strictObject({ spec: z.number().int() }),
	});

	const envelope = await execute(["create", "spec", "--input", "-"], {
		tracker,
		manifest,
		stdin: "# Build a thing\n",
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should ensure that create command input rejects Zod-parsed values that are not JSON-compatible", async () => {
	const tracker = createInMemoryTracker();
	const manifest = manifestWithCommandSchema("spec-create", {
		input: z.strictObject({
			spec: z.strictObject({
				type: z.literal("markdown"),
				ref: z.string().transform((value) => new Date(value)),
			}),
		}),
	});

	const envelope = await execute(["create", "spec", "--input", "-"], {
		tracker,
		manifest,
		stdin: "2024-01-01T00:00:00.000Z",
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(envelope.ok ? undefined : envelope.error.details?.issues).toEqual([
		{ path: "$input", message: "Invalid input" },
	]);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should ensure that create handoff validates input and records a log on the source issue", async () => {
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
			stdin: JSON.stringify({
				handoff: {
					type: "handoff",
					ref: "Next agent: inspect the retry path.",
				},
			}),
		},
	);

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as HandoffData;
	expect(data.log.type).toBe("handoff_created");
	expect(await tracker.getIssue("ticket-1")).not.toHaveProperty("artifacts");
	expect((await tracker.readLogs("ticket-1")).map((log) => log.type)).toEqual([
		"handoff_created",
	]);
});

it("should ensure that create handoff rejects malformed Handoff reference data before recording", async () => {
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
			manifest: agentDevelopmentManifest,
			stdin: JSON.stringify({
				handoff: { type: "handoff", metadata: { summary: "missing ref" } },
			}),
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(envelope.ok ? undefined : envelope.error.details?.issues).toEqual([
		expect.objectContaining({ path: "$input.handoff" }),
	]);
	expect(await tracker.getIssue("ticket-1")).not.toHaveProperty("artifacts");
	expect(await tracker.readLogs("ticket-1")).toEqual([]);
});

it("should ensure that create handoff records log through one tracker intent", async () => {
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
			expect(id).toBe("123");
			return issue;
		},
		applyWorkflowEffects: async ({ effects }) => {
			intents.push("applyWorkflowEffects");
			expect(effects).toHaveLength(1);
			const effect = effects[0];
			expect(effect?.type).toBe("record-command");
			if (effect?.type !== "record-command") {
				throw new Error("expected record command effect");
			}
			expect(effect.issue).toEqual({ id: "123" });
			expect(effect.log.type).toBe("handoff_created");
			return {
				issues: { "123": issue },
				createdIssues: [],
				logs: [{ ...effect.log, issueId: "123", sequence: 1 }],
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

	expect(envelope.ok).toBe(true);
	expect(intents).toEqual(["applyWorkflowEffects"]);
});

it("should ensure that create handoff rejects invalid manifest-declared input before mutating", async () => {
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
			stdin: JSON.stringify({ handoff: { type: "handoff", ref: "" } }),
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.getIssue("ticket-1")).not.toHaveProperty("artifacts");
	expect(await tracker.readLogs("ticket-1")).toEqual([]);
});

it("should ensure that apply targets dispatch through manifest CLI declarations", async () => {
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
		...agentDevelopmentManifest,
		commands: agentDevelopmentManifest.commands.map((command) =>
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

	expect(envelope.ok).toBe(true);
	expect((await tracker.readLogs("spec-1")).map((log) => log.type)).toEqual([
		"plan_applied",
	]);

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

	expect(unknown.ok).toBe(false);
	expect(unknown.ok ? undefined : unknown.error.code).toBe(
		"UNKNOWN_COMMAND_TARGET",
	);
	expect((await unknownTracker.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-2",
	]);
	expect(await unknownTracker.readLogs("spec-2")).toEqual([]);
});

it("should ensure that apply plan requires the active manifest plan apply declaration before mutating", async () => {
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
		...agentDevelopmentManifest,
		commands: agentDevelopmentManifest.commands.map((command) =>
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

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"UNKNOWN_COMMAND_TARGET",
	);
	expect((await tracker.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-1",
	]);
	expect(await tracker.readLogs("spec-1")).toEqual([]);
});

it("should ensure that apply plan creates tickets, relationships, dependencies, logs application, and leaves the Spec unschedulable", async () => {
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

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as ApplyPlanData;
	expect(data.outcome).toBe("SUCCESS");
	expect(data.tickets.map((ticket) => ticket.key)).toEqual(["setup", "finish"]);
	const spec = await tracker.getIssue("spec-1");
	expect(pickWorkflow(spec.workflow)).toEqual({
		kind: "spec",
		state: "ready",
		action: "none",
	});
	expect(spec.relationships.children).toEqual(["1", "2"]);
	expect(spec).not.toHaveProperty("artifacts");
	expect((await tracker.getIssue("2")).relationships.dependencies).toEqual([
		"1",
	]);
	const ready = await execute(["ready", "--filter", "spec=spec-1"], {
		tracker,
	});
	expect(ready.ok).toBe(true);
	if (!ready.ok) {
		throw new Error("expected success");
	}
	expect((ready.data as ReadyData).items.map((item) => item.id)).toEqual(["1"]);
	expect((await tracker.readLogs("spec-1")).map((log) => log.type)).toEqual([
		"plan_applied",
	]);
});

it("should ensure that apply plan rejects manifest-invalid command input before mutating the tracker", async () => {
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

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect((await tracker.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-1",
	]);
	expect(await tracker.readLogs("spec-1")).toEqual([]);
});

it("should ensure that apply plan rejects invalid bundles before mutating the tracker", async () => {
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

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe("INVALID_PLAN");
	expect((await tracker.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-1",
	]);
	expect(await tracker.readLogs("spec-1")).toEqual([]);
});

it("should ensure that apply plan rejects malformed dependency payloads before applying tracker relationships", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-bad-dependency-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [
				{ key: "a", title: "A", content: "A", dependsOn: "not-an-array" },
			],
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
	let applyWorkflowEffectsCalls = 0;
	const tracker: Tracker = failingTracker(base, {
		applyWorkflowEffects: async () => {
			applyWorkflowEffectsCalls += 1;
			throw new Error("applyWorkflowEffects should not be called");
		},
	});
	const manifest = manifestWithPlanCommandSchema({ input: undefined });

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
		manifest,
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe("INVALID_PLAN");
	expect(envelope.ok ? undefined : envelope.error.details).toEqual({
		issues: [
			{
				path: "$.tickets[0].dependsOn",
				message: "Ticket dependsOn must be an array of ticket keys.",
			},
		],
	});
	expect(applyWorkflowEffectsCalls).toBe(0);
	expect((await base.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-1",
	]);
	expect(await base.readLogs("spec-1")).toEqual([]);
});

it("should ensure that apply plan reports malformed ticket payload paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-malformed-ticket-"));
	const plan = join(dir, "plan.json");
	await writeFile(
		plan,
		JSON.stringify({
			tickets: [{ key: "a", title: "A", content: "A" }, "bad"],
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
	const manifest = manifestWithPlanCommandSchema({ input: undefined });

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
		manifest,
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.details).toEqual({
		issues: [
			{
				path: "$.tickets[1]",
				message: "Ticket must be an object.",
			},
		],
	});
	expect((await tracker.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-1",
	]);
});

it("should ensure that apply plan dispatches the bundle as one tracker-owned workflow intent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-one-intent-"));
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
	let applyWorkflowEffectsCalls = 0;
	const tracker: Tracker = failingTracker(base, {
		applyWorkflowEffects: async (input) => {
			applyWorkflowEffectsCalls += 1;
			expect(input.effects.map((effect) => effect.type)).toEqual([
				"create-workflow-issue",
				"add-child",
				"update-workflow",
				"record-command",
			]);
			return base.applyWorkflowEffects(input);
		},
		createIssue: async () => {
			throw new Error("runtime must not create plan tickets directly");
		},
		addChild: async () => {
			throw new Error("runtime must not create relationships directly");
		},
		addDependency: async () => {
			throw new Error("runtime must not create dependencies directly");
		},
		appendLog: async () => {
			throw new Error("runtime must not log plan application directly");
		},
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
	});

	expect(envelope.ok).toBe(true);
	expect(applyWorkflowEffectsCalls).toBe(1);
});

it("should ensure that generic create rejects invalid JSON before mutating the tracker", async () => {
	const tracker = createNoTouchTracker();
	const manifest = manifestWithGenericCommands();

	const envelope = await execute(["create", "note", "--input", "-"], {
		tracker,
		manifest,
		stdin: "{not json}",
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
});

it("should ensure that generic create rejects schema-invalid input before creating a Workflow issue", async () => {
	const tracker = createInMemoryTracker();
	const manifest = manifestWithGenericCommands({
		createInput: z.strictObject({ title: z.string(), body: z.string() }),
	});

	const envelope = await execute(["create", "note", "--input", "-"], {
		tracker,
		manifest,
		stdin: JSON.stringify({ title: 123, body: "Body" }),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should ensure that generic create rejects non-JSON-compatible parsed input before creating a Workflow issue", async () => {
	const tracker = createInMemoryTracker();
	const manifest = manifestWithGenericCommands({
		createInput: z
			.strictObject({ title: z.string(), createdAt: z.string() })
			.transform((value) => ({
				...value,
				createdAt: new Date(value.createdAt),
			})),
	});

	const envelope = await execute(["create", "note", "--input", "-"], {
		tracker,
		manifest,
		stdin: JSON.stringify({
			title: "Dated note",
			createdAt: "2024-01-01T00:00:00.000Z",
		}),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should ensure that generic create stores the manifest-parsed JSON-compatible payload", async () => {
	const tracker = createInMemoryTracker();
	const manifest = manifestWithGenericCommands({
		createInput: z
			.strictObject({ name: z.string(), markdown: z.string() })
			.transform((value) => ({
				title: value.name,
				body: value.markdown,
			})),
	});

	const envelope = await execute(["create", "note", "--input", "-"], {
		tracker,
		manifest,
		stdin: JSON.stringify({ name: "Parsed title", markdown: "Parsed body" }),
	});

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const issue = (envelope.data as CreateSpecData).issue;
	expect(issue.title).toBe("Parsed title");
	expect(issue.body).toBe("Parsed body");
	expect(issue.workflow.semanticVersion).toBe(manifest.workflow.version);
	expect(
		JSON.parse((await tracker.readLogs(issue.id))[0]?.message ?? "{}"),
	).toEqual({
		input: { title: "Parsed title", body: "Parsed body" },
	});
});

it("should ensure that generic apply rejects invalid JSON before reading or mutating the tracker", async () => {
	const tracker = createNoTouchTracker();
	const manifest = manifestWithGenericCommands();

	const envelope = await execute(
		["apply", "annotate", "ticket-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: "{not json}",
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
});

it("should ensure that generic apply rejects schema-invalid input before writing logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	const manifest = manifestWithGenericCommands({
		applyInput: z.strictObject({ comment: z.string().min(1) }),
	});

	const envelope = await execute(
		["apply", "annotate", "ticket-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ comment: "" }),
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.readLogs("ticket-1")).toEqual([]);
});

it("should ensure that generic apply rejects non-JSON-compatible parsed input before writing logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	const manifest = manifestWithGenericCommands({
		applyInput: z
			.strictObject({ comment: z.string() })
			.transform((value) => ({ ...value, marker: 1n })),
	});

	const envelope = await execute(
		["apply", "annotate", "ticket-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ comment: "Add context." }),
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.readLogs("ticket-1")).toEqual([]);
});

it("should ensure that generic apply rejects recorded workflow semantic version mismatches before writing logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: {
					kind: "ticket",
					state: "ready",
					action: "implement",
					semanticVersion: "9.0.0",
				},
			},
		],
	});
	const manifest = manifestWithGenericCommands();

	const envelope = await execute(
		["apply", "annotate", "ticket-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ comment: "Add context." }),
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"NEED_RECONCILIATION",
	);
	expect(envelope.ok ? undefined : envelope.error.message).toMatch(
		/Migrate or reconcile/,
	);
	expect(await tracker.readLogs("ticket-1")).toEqual([]);
});

it("should ensure that command handlers reject recorded workflow semantic version mismatches before mutating", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "item-1",
				title: "Item",
				workflow: {
					kind: "item",
					state: "ready",
					action: "review",
					semanticVersion: "9.0.0",
				},
			},
		],
	});

	const envelope = await execute(["apply", "memo", "item-1", "--input", "-"], {
		tracker,
		manifest: genericWorkflowManifest(),
		commandHandlers: {
			"memo-apply": async ({ issueId, tracker: handlerTracker }) => {
				await handlerTracker.recordCommand(issueId ?? "", {
					log: { type: "memo_applied" },
				});
				return { applied: true };
			},
		},
		stdin: JSON.stringify({ summary: "Needs more work." }),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"NEED_RECONCILIATION",
	);
	expect(envelope.ok ? undefined : envelope.error.message).toMatch(
		/Migrate or reconcile/,
	);
	expect(await tracker.readLogs("item-1")).toEqual([]);
});

it("should ensure that generic transition commands validate target filters before applying effects", async () => {
	let applyWorkflowEffectsCalls = 0;
	const tracker = failingTracker(
		createInMemoryTracker({
			issues: [
				{
					id: "item-1",
					title: "Item",
					workflow: { kind: "item", state: "ready", action: "draft" },
				},
			],
		}),
		{
			applyWorkflowEffects: async (input) => {
				applyWorkflowEffectsCalls += 1;
				return createInMemoryTracker().applyWorkflowEffects(input);
			},
		},
	);

	const envelope = await execute(["item", "finish", "item-1"], {
		tracker,
		manifest: genericWorkflowManifest({
			transitionTarget: { kind: "item", state: "ready", action: "review" },
			transition: { event: "finished" },
		}),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"UNAVAILABLE_COMMAND",
	);
	expect(applyWorkflowEffectsCalls).toBe(0);
});

it("should ensure that generic transition commands apply matching manifest transitions with plain text logs", async () => {
	const base = createInMemoryTracker({
		issues: [
			{
				id: "item-1",
				title: "Item",
				workflow: { kind: "item", state: "ready", action: "review" },
			},
		],
	});
	let seenEffectTypes: Array<string> = [];
	const tracker = failingTracker(base, {
		applyWorkflowEffects: async (input) => {
			seenEffectTypes = input.effects.map((effect) => effect.type);
			return base.applyWorkflowEffects(input);
		},
		recordCommand: async () => {
			throw new Error("runtime must use generic workflow effects");
		},
		advanceWorkflow: async () => {
			throw new Error("runtime must not advance workflow directly");
		},
	});

	const envelope = await execute(["item", "finish", "item-1"], {
		tracker,
		manifest: genericWorkflowManifest({
			transitionTarget: { kind: "item", state: "ready", action: "review" },
			transition: { event: "finished" },
		}),
	});

	expect(envelope.ok).toBe(true);
	expect(seenEffectTypes).toEqual(["update-workflow", "record-command"]);
	expect((await tracker.getIssue("item-1")).workflow).toMatchObject({
		kind: "item",
		state: "done",
	});
	expect((await tracker.readLogs("item-1"))[0]).toMatchObject({
		type: "command",
		message: "Applied finished.",
	});
});

it("should ensure that generic transition commands reject missing matching transitions", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "item-1",
				title: "Item",
				workflow: { kind: "item", state: "ready", action: "draft" },
			},
		],
	});

	const envelope = await execute(["item", "finish", "item-1"], {
		tracker,
		manifest: genericWorkflowManifest({
			transitionTarget: { kind: "item", state: "ready", action: "draft" },
			transition: { event: "finished" },
		}),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"INVALID_TRANSITION",
	);
	expect(await tracker.readLogs("item-1")).toEqual([]);
});

it("should ensure that generic apply logs the manifest-parsed JSON-compatible payload", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	const manifest = manifestWithGenericCommands({
		applyInput: z
			.strictObject({ comment: z.string() })
			.transform((value) => ({ note: value.comment })),
	});

	const envelope = await execute(
		["apply", "annotate", "ticket-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ comment: "Add context." }),
		},
	);

	expect(envelope.ok).toBe(true);
	expect(
		JSON.parse((await tracker.readLogs("ticket-1"))[0]?.message ?? "{}"),
	).toEqual({
		input: { note: "Add context." },
	});
});

it("should ensure that command handlers receive manifest-validated input", async () => {
	const tracker = createInMemoryTracker();
	const manifest = genericWorkflowManifest({
		createInput: z
			.strictObject({ name: z.string(), text: z.string() })
			.transform((value) => ({ title: value.name, body: value.text })),
	});
	const seen: Array<unknown> = [];
	const commandHandlers: CommandHandlers = {
		"memo-create": async ({ input, command, tracker: handlerTracker }) => {
			const record = input as Record<string, unknown>;
			seen.push({
				input,
				command: command.id,
				sameTracker: handlerTracker === tracker,
			});
			return { externalId: "memo-1", title: record.title as string };
		},
	};

	const envelope = await execute(["create", "memo", "--input", "-"], {
		tracker,
		manifest,
		commandHandlers,
		stdin: JSON.stringify({ name: "Meeting", text: "Notes" }),
	});

	expect(envelope).toEqual({
		ok: true,
		data: { externalId: "memo-1", title: "Meeting" },
	});
	expect(seen).toEqual([
		{
			input: { title: "Meeting", body: "Notes" },
			command: "memo-create",
			sameTracker: false,
		},
	]);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should ensure that command handlers are not invoked when input validation fails", async () => {
	let calls = 0;
	const envelope = await execute(["create", "memo", "--input", "-"], {
		tracker: createInMemoryTracker(),
		manifest: genericWorkflowManifest({
			createInput: z.strictObject({ title: z.string() }),
		}),
		commandHandlers: {
			"memo-create": async () => {
				calls += 1;
				return { ignored: true };
			},
		},
		stdin: JSON.stringify({ title: 123 }),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(calls).toBe(0);
});

it("should ensure that handler success output is not schema-validated", async () => {
	const envelope = await execute(["create", "memo", "--input", "-"], {
		tracker: createInMemoryTracker(),
		manifest: genericWorkflowManifest({
			createInput: z.strictObject({ title: z.string() }),
		}),
		commandHandlers: {
			"memo-create": async () => ({ externalId: 42 }),
		},
		stdin: JSON.stringify({ title: "Meeting" }),
	});

	expect(envelope).toEqual({ ok: true, data: { externalId: 42 } });
});

it("should ensure that handler failure envelopes pass through without output validation", async () => {
	const envelope = await execute(["apply", "memo", "item-1", "--input", "-"], {
		tracker: createInMemoryTracker({
			issues: [
				{
					id: "item-1",
					title: "Item",
					workflow: { kind: "item", state: "ready", action: "review" },
				},
			],
		}),
		manifest: genericWorkflowManifest({
			applyInput: z.strictObject({ summary: z.string() }),
		}),
		commandHandlers: {
			"memo-apply": async ({ issueId, input }) => {
				const record = input as Record<string, unknown>;
				return {
					ok: false,
					error: {
						code: "REMOTE_REJECTED",
						message: "Remote rejected the update.",
						details: {
							issueId: issueId ?? "",
							summary: record.summary as string,
						},
					},
				};
			},
		},
		stdin: JSON.stringify({ summary: "Needs more work." }),
	});

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "REMOTE_REJECTED",
			message: "Remote rejected the update.",
			details: { issueId: "item-1", summary: "Needs more work." },
		},
	});
});

it("should ensure that commands without handlers continue to use generic behavior", async () => {
	const tracker = createInMemoryTracker();
	const manifest = genericWorkflowManifest({
		createInput: z.strictObject({ title: z.string(), body: z.string() }),
	});

	const envelope = await execute(["create", "memo", "--input", "-"], {
		tracker,
		manifest,
		commandHandlers: {},
		stdin: JSON.stringify({ title: "Fallback", body: "Generic body" }),
	});

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	expect((envelope.data as CreateSpecData).issue.title).toBe("Fallback");
});

it("should ensure that apply command handlers receive the parsed issue id", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "item-1",
				title: "Item",
				workflow: { kind: "item", state: "ready", action: "review" },
			},
		],
	});
	const manifest = genericWorkflowManifest({
		applyInput: z
			.strictObject({ note: z.string() })
			.transform((value) => ({ comment: value.note })),
	});

	const envelope = await execute(["apply", "memo", "item-1", "--input", "-"], {
		tracker,
		manifest,
		commandHandlers: {
			"memo-apply": async ({ issueId, input }) => {
				const record = input as Record<string, unknown>;
				return {
					issueId: issueId ?? "",
					comment: record.comment as string,
				};
			},
		},
		stdin: JSON.stringify({ note: "Looks good." }),
	});

	expect(envelope).toEqual({
		ok: true,
		data: { issueId: "item-1", comment: "Looks good." },
	});
	expect(await tracker.readLogs("item-1")).toEqual([]);
});

it("should ensure that apply plan reports need-reconciliation instead of rolling back partial adapter drift", async () => {
	const dir = await mkdtemp(join(tmpdir(), "awf-reconcile-"));
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
		applyWorkflowEffects: async () => {
			const ticket = await base.createIssue({
				title: "A",
				body: "A",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			});
			await base.addChild("spec-1", ticket.id);
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: adapter projection mismatch.",
			);
		},
	});

	const envelope = await execute(["apply", "plan", "spec-1", "--input", plan], {
		tracker,
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"NEED_RECONCILIATION",
	);
	expect((await base.listIssues()).map((issue) => issue.id)).toEqual([
		"spec-1",
		"1",
	]);
	expect((await base.getIssue("spec-1")).relationships.children).toEqual(["1"]);
	expect(pickWorkflow((await base.getIssue("spec-1")).workflow)).toEqual({
		kind: "spec",
		state: "ready",
		action: "plan",
	});
});

function manifestWithPlanCommandSchema(
	schemas: Pick<WorkflowManifest["commands"][number], "input">,
): WorkflowManifest {
	return manifestWithCommandSchema("plan-apply", schemas);
}

function manifestWithGenericCommands(
	options: {
		createInput?: WorkflowManifest["commands"][number]["input"];
		applyInput?: WorkflowManifest["commands"][number]["input"];
	} = {},
): WorkflowManifest {
	return {
		...agentDevelopmentManifest,
		commands: [
			...agentDevelopmentManifest.commands,
			{
				id: "note-create",
				cli: { verb: "create", target: "note" },
				target: { kind: "ticket", action: "implement" },
				input: options.createInput,
			},
			{
				id: "ticket-annotate",
				cli: { verb: "apply", target: "annotate" },
				target: { kind: "ticket", action: "implement" },
				input: options.applyInput,
			},
		],
	};
}

function genericWorkflowManifest(
	options: {
		createInput?: WorkflowManifest["commands"][number]["input"];
		applyInput?: WorkflowManifest["commands"][number]["input"];
		transition?: WorkflowManifest["commands"][number]["transition"];
		transitionTarget?: WorkflowManifest["commands"][number]["target"];
	} = {},
): WorkflowManifest {
	return {
		version: "v1",
		workflow: { id: "handler-seam", version: "1.0.0" },
		vocabulary: {
			states: ["ready", "done"],
			actions: ["draft", "review"],
			events: ["finished"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		kinds: [
			{
				id: "item",
				label: "Item",
				initial: { state: "ready", action: "draft" },
				transitions: [
					{
						from: { state: "ready", action: "review" },
						event: "finished",
						to: { state: "done" },
					},
				],
			},
		],
		commands: [
			{
				id: "memo-create",
				cli: { verb: "create", target: "memo" },
				target: { kind: "item", action: "draft" },
				input: options.createInput,
			},
			{
				id: "memo-apply",
				cli: { verb: "apply", target: "memo" },
				target: { kind: "item", action: "review" },
				input: options.applyInput,
			},
			{
				id: "item-finish",
				cli: { verb: "item", target: "finish" },
				target: options.transitionTarget ?? {
					kind: "item",
					state: "ready",
					action: "review",
				},
				...(options.transition === undefined
					? {}
					: { transition: options.transition }),
			},
		],
	};
}

function manifestWithCommandSchema(
	id: string,
	schemas: Pick<WorkflowManifest["commands"][number], "input">,
): WorkflowManifest {
	return {
		...agentDevelopmentManifest,
		commands: agentDevelopmentManifest.commands.map((command) =>
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

function failingTracker(
	base: TrackerAdapter,
	overrides: Partial<TrackerAdapter>,
): TrackerAdapter {
	const tracker: TrackerAdapter = {
		createWorkflowIssue: base.createWorkflowIssue.bind(base),
		startRun: base.startRun.bind(base),
		completeRun: base.completeRun.bind(base),
		recordCommand: base.recordCommand.bind(base),
		escalateWorkflow: base.escalateWorkflow.bind(base),
		resumeWorkflow: base.resumeWorkflow.bind(base),
		advanceWorkflow: base.advanceWorkflow.bind(base),
		repairIssue: base.repairIssue.bind(base),
		changeRelationship: base.changeRelationship.bind(base),
		applyWorkflowEffects: base.applyWorkflowEffects.bind(base),
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
	};
	return Object.assign(tracker, overrides);
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
