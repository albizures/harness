import { expect, it } from "vitest";
import { z } from "zod";
import { execute } from "../support/execute.ts";
import { defineManifest } from "../../src/manifest/index.ts";
import { createInMemoryTracker } from "../../src/adapters/trackers/memory.ts";

const syntheticManifest = defineManifest({
	version: "v1",
	workflow: { id: "synthetic", version: "1.0.0" },
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
			id: "idea-score",
			cli: { verb: "score", target: "idea" },
			target: { kind: "idea", action: "promote" },
			input: z.strictObject({ score: z.number().int() }),
		},
		{
			id: "hidden-maintenance",
			target: { kind: "idea", action: "promote" },
			input: z.strictObject({ note: z.string().min(1) }),
		},
	],
	relationships: [
		{
			id: "goal-ideas",
			from: "goal",
			to: "idea",
			projection: { type: "parent-child" },
		},
	],
});

it("should ensure that synthetic workflow dispatches manifest-declared create and ready commands while rejecting generic apply", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "goal-1",
				title: "Goal",
				workflow: { kind: "goal", state: "done", action: "none" },
			},
		],
	});

	const created = await execute(["create", "idea", "--input", "-"], {
		tracker,
		manifest: syntheticManifest,
		stdin: JSON.stringify({ title: "Promotable idea", body: "Try it." }),
	});
	expect(created.ok).toBe(true);
	const issueId = (created as { ok: true; data: { issue: { id: string } } })
		.data.issue.id;
	await tracker.addChild("goal-1", issueId);

	const ready = await execute(["ready", "--filter", "goal=goal-1"], {
		tracker,
		manifest: syntheticManifest,
	});
	expect(
		(
			ready as { ok: true; data: { items: Array<{ id: string }> } }
		).data.items.map((item) => item.id),
	).toEqual([issueId]);

	const applied = await execute(
		["apply", "promotion", issueId, "--input", "-"],
		{
			tracker,
			manifest: syntheticManifest,
			stdin: JSON.stringify({ note: "Promote this idea." }),
		},
	);
	expect(applied).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: `apply promotion ${issueId} --input -` },
		},
	});
});

it("should ensure that synthetic workflow dispatches arbitrary manifest CLI verbs to command handlers", async () => {
	const calls: Array<{ commandId: string; issueId?: string; input: unknown }> =
		[];
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "idea-1",
				title: "Idea",
				workflow: { kind: "idea", state: "ready", action: "promote" },
			},
		],
	});

	const envelope = await execute(["score", "idea", "idea-1", "--input", "-"], {
		tracker,
		manifest: syntheticManifest,
		stdin: JSON.stringify({ score: 7 }),
		commandHandlers: {
			"idea-score": ({ command, issueId, input }) => {
				if (issueId === undefined) {
					throw new Error("expected issue id");
				}
				calls.push({ commandId: command.id, issueId, input });
				return { scored: issueId, input };
			},
		},
	});

	expect(envelope).toEqual({
		ok: true,
		data: { scored: "idea-1", input: { score: 7 } },
	});
	expect(calls).toEqual([
		{ commandId: "idea-score", issueId: "idea-1", input: { score: 7 } },
	]);
});

it("should ensure that run-command dispatches by stable command id and remains hidden from help", async () => {
	const calls: Array<string> = [];
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "idea-1",
				title: "Idea",
				workflow: { kind: "idea", state: "ready", action: "promote" },
			},
		],
	});

	const envelope = await execute(
		["run-command", "hidden-maintenance", "idea-1", "--input", "-"],
		{
			tracker,
			manifest: syntheticManifest,
			stdin: JSON.stringify({ note: "Sweep." }),
			commandHandlers: {
				"hidden-maintenance": ({ command, issueId, input }) => {
					if (issueId === undefined) {
						throw new Error("expected issue id");
					}
					calls.push(command.id);
					return { maintained: issueId, input };
				},
			},
		},
	);
	const created = await execute(
		["run-command", "idea-create", "--input", "-"],
		{
			tracker,
			manifest: syntheticManifest,
			stdin: JSON.stringify({ title: "By id", body: "Created by id." }),
		},
	);
	const help = await execute(["--help"], { manifest: syntheticManifest });

	expect(envelope).toEqual({
		ok: true,
		data: { maintained: "idea-1", input: { note: "Sweep." } },
	});
	expect(created.ok).toBe(true);
	expect(calls).toEqual(["hidden-maintenance"]);
	expect(
		(
			help as { ok: true; data: { commands: Array<{ name: string }> } }
		).data.commands.map((command) => command.name),
	).not.toContain("run-command");
});

it("should ensure that runtime lifecycle verbs are not accepted as top-level built-ins", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "idea-1",
				title: "Idea",
				workflow: { kind: "idea", state: "ready", action: "promote" },
			},
		],
	});

	const envelope = await execute(["start", "idea-1"], {
		tracker,
		manifest: syntheticManifest,
	});

	expect(envelope).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "start idea-1" },
		},
	});
});

it("should ensure that synthetic workflow dispatch rejects undeclared command and filter names", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "goal-1",
				title: "Goal",
				workflow: { kind: "goal", state: "done", action: "none" },
			},
		],
	});

	expect(
		(
			await execute(["create", "ticket", "--input", "-"], {
				tracker,
				manifest: syntheticManifest,
				stdin: JSON.stringify({ title: "Nope", body: "Nope." }),
			})
		).ok,
	).toBe(false);
	expect(
		(
			await execute(["ready", "--filter", "spec=goal-1"], {
				tracker,
				manifest: syntheticManifest,
			})
		).ok,
	).toBe(false);
});
