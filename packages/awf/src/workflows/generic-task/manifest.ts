import { z } from "zod";
import { defineManifest } from "../../manifest/definition.ts";

const states = ["ready", "running", "done", "need-human"] as const;
const actions = ["work", "none"] as const;
const events = ["start", "succeed", "fail"] as const;

const createInput = z
	.strictObject({
		title: z.string().trim().min(1),
		body: z.string().trim().min(1).optional(),
		content: z.string().trim().min(1).optional(),
	})
	.refine(
		(input) => input.body !== undefined || input.content !== undefined,
		"Either body or content is required.",
	);
const taskCreateInput = z.strictObject({
	spec: z.string().trim().min(1),
	title: z.string().trim().min(1),
	description: z.string().trim().min(1),
	profile: z.string().trim().min(1),
	dependsOn: z.array(z.string().trim().min(1)).optional(),
	generatedBy: z.string().trim().min(1).optional(),
});

const createOutput = z.object({
	issue: z.object({ id: z.string() }),
	log: z.object({ type: z.string() }),
});

const workTransitions = [
	{
		from: { state: "ready", action: "work" },
		event: "start",
		to: { state: "running", action: "work" },
	},
	{
		from: { state: "running", action: "work" },
		event: "succeed",
		to: { state: "done", action: "none" },
	},
	{
		from: { state: "running", action: "work" },
		event: "fail",
		to: { state: "need-human", action: "none" },
	},
] as const;

export const genericTaskManifest = defineManifest({
	version: "v1",
	workflow: { id: "generic-task" },
	vocabulary: {
		states: [...states],
		actions: [...actions],
		reasons: [],
		events: [...events],
	},
	github: { reservedPrefix: "awf" },
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { task: 3 } },
	readiness: {
		filters: [
			{ kind: "spec", state: "ready", action: "work" },
			{ kind: "task", state: "ready", action: "work" },
		],
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
	},
	kinds: [
		{
			id: "spec",
			label: "Spec",
			initial: { state: "ready", action: "work" },
			transitions: [...workTransitions],
		},
		{
			id: "task",
			label: "Task",
			initial: { state: "ready", action: "work" },
			transitions: [...workTransitions],
		},
	],
	relationships: [
		{
			id: "spec-task",
			from: "spec",
			to: "task",
			projection: { type: "parent-child" },
		},
		{
			id: "task-blocks-task",
			from: "task",
			to: "task",
			projection: { type: "dependency" },
		},
	],
	commands: [
		{
			id: "spec-create",
			cli: { verb: "create", target: "spec" },
			target: { kind: "spec", action: "work" },
			input: createInput,
			output: createOutput,
		},
		{
			id: "task-create",
			cli: { verb: "create", target: "task" },
			target: { kind: "task", action: "work" },
			input: taskCreateInput,
			output: createOutput,
		},
	],
});
