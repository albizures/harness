import assert from "node:assert/strict";
import test from "node:test";
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
	github: {
		labelPrefixes: {
			kind: "kind:",
			state: "state:",
			action: "action:",
			reason: "reason:",
		},
	},
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

	const help = await execute(["--help"], { manifest: syntheticManifest });
	assert.equal(help.ok, true);
	if (!help.ok) {
		throw new Error("expected help success");
	}
	const helpData = help.data as {
		commands: Array<{ usage: string }>;
		readiness: {
			filters: Array<unknown>;
			namedFilters: Array<{ name: string }>;
		};
	};
	assert.ok(
		helpData.commands.some(
			(command) => command.usage === "awf create idea --input <file|->",
		),
	);
	assert.ok(
		helpData.commands.some(
			(command) =>
				command.usage === "awf apply promotion <issue> --input <file|->",
		),
	);
	assert.ok(
		helpData.commands.every(
			(command) =>
				!command.usage.includes("create spec") &&
				!command.usage.includes("apply plan"),
		),
	);
	assert.deepEqual(helpData.readiness.filters, [
		{ kind: "idea", state: "ready", action: "promote" },
	]);
	assert.deepEqual(helpData.readiness.namedFilters, [
		{
			name: "goal",
			kind: "goal",
			relationship: "parent",
			usage: "awf ready --filter goal=<goal>",
		},
	]);

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
