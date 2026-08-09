import { assert, test } from "vitest";
import { z } from "zod";
import { execute } from "./commands.ts";
import { defineManifest } from "./manifest.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

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

test("synthetic workflow dispatches manifest-declared create, apply, and ready commands", async () => {
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
	assert.equal(created.ok, true);
	const issueId = (created as { ok: true; data: { issue: { id: string } } })
		.data.issue.id;
	await tracker.addChild("goal-1", issueId);

	const ready = await execute(["ready", "--filter", "goal=goal-1"], {
		tracker,
		manifest: syntheticManifest,
	});
	assert.deepEqual(
		(
			ready as { ok: true; data: { items: Array<{ id: string }> } }
		).data.items.map((item) => item.id),
		[issueId],
	);

	const applied = await execute(
		["apply", "promotion", issueId, "--input", "-"],
		{
			tracker,
			manifest: syntheticManifest,
			stdin: JSON.stringify({ note: "Promote this idea." }),
		},
	);
	assert.equal(applied.ok, true);
	assert.equal(
		(await tracker.readLogs(issueId)).at(-1)?.type,
		"idea-promote_applied",
	);
});

test("synthetic workflow dispatch rejects undeclared command and filter names", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "goal-1",
				title: "Goal",
				workflow: { kind: "goal", state: "done", action: "none" },
			},
		],
	});

	assert.equal(
		(
			await execute(["create", "ticket", "--input", "-"], {
				tracker,
				manifest: syntheticManifest,
				stdin: JSON.stringify({ title: "Nope", body: "Nope." }),
			})
		).ok,
		false,
	);
	assert.equal(
		(
			await execute(["ready", "--filter", "spec=goal-1"], {
				tracker,
				manifest: syntheticManifest,
			})
		).ok,
		false,
	);
});
