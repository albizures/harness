import { z } from "zod";
import { defineManifest } from "../../manifest/definition.ts";

const states = ["ready", "running", "done", "need-human"] as const;
const actions = [
	"planning",
	"work",
	"integration-test",
	"merge",
	"none",
] as const;
const events = ["start", "succeed", "fail"] as const;
const taskSubkinds = ["work", "research", "prototype"] as const;

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
	subkind: z.enum(taskSubkinds).optional(),
	dependsOn: z.array(z.string().trim().min(1)).optional(),
	generatedBy: z.string().trim().min(1).optional(),
});

const createOutput = z.object({
	issue: z.object({ id: z.string() }),
	log: z.object({ type: z.string() }),
});

const specTransitions = [
	{
		from: { state: "ready", action: "planning" },
		event: "start",
		to: { state: "running", action: "planning" },
	},
	{
		from: { state: "ready", action: "planning" },
		event: "succeed",
		to: { state: "ready", action: "none" },
	},
	{
		from: { state: "running", action: "planning" },
		event: "succeed",
		to: { state: "ready", action: "none" },
	},
	{
		from: { state: "ready", action: "integration-test" },
		event: "start",
		to: { state: "running", action: "integration-test" },
	},
	{
		from: { state: "running", action: "integration-test" },
		event: "succeed",
		to: { state: "ready", action: "merge" },
	},
	{
		from: { state: "running", action: "integration-test" },
		event: "fail",
		to: { state: "ready", action: "planning" },
	},
	{
		from: { state: "ready", action: "merge" },
		event: "start",
		to: { state: "running", action: "merge" },
	},
	{
		from: { state: "running", action: "merge" },
		event: "succeed",
		to: { state: "done", action: "none" },
	},
] as const;

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
	workflow: { id: "agent-workflow" },
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
			{ kind: "spec", state: "ready", action: "planning" },
			{ kind: "spec", state: "ready", action: "integration-test" },
			{ kind: "spec", state: "ready", action: "merge" },
			{ kind: "task", state: "ready", action: "work" },
		],
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
		relationshipPolicies: [
			{
				relationship: "children",
				where: { kind: "spec", state: "ready", action: "integration-test" },
				children: {
					all: { kind: "task", state: "done", action: "none" },
					min: 1,
				},
				gate: "tasks-done",
			},
		],
	},
	lifecycle: {
		relationshipPolicies: [
			{
				relationship: "parent",
				child: { kind: "task", state: "done", action: "none" },
				parent: { kind: "spec", state: "ready", action: "none" },
				siblings: { all: { kind: "task", state: "done" }, min: 1 },
				to: { state: "ready", action: "integration-test" },
			},
		],
	},
	kinds: [
		{
			id: "spec",
			label: "Spec",
			initial: { state: "ready", action: "planning" },
			transitions: [...specTransitions],
		},
		{
			id: "task",
			label: "Task",
			initial: { state: "ready", action: "work" },
			subkinds: [...taskSubkinds],
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
			target: { kind: "spec", action: "planning" },
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
