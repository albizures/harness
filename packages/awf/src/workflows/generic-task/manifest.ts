import { z } from "zod";
import { defineManifest } from "../../manifest/definition.ts";

const states = [
	"ready",
	"running",
	"in-discussion",
	"done",
	"need-human",
	"waiting-human",
] as const;
const actions = [
	"planning",
	"work",
	"discuss",
	"integration-test",
	"merge",
	"none",
] as const;
const events = ["start", "succeed", "fail", "pause", "respond"] as const;
const taskSubkinds = ["work", "research", "prototype"] as const;

const createInput = z
	.strictObject({
		title: z.string().trim().min(1),
		body: z.string().trim().min(1).optional(),
		content: z.string().trim().min(1).optional(),
		parent: z.string().trim().min(1).optional(),
	})
	.refine(
		(input) => input.body !== undefined || input.content !== undefined,
		"Either body or content is required.",
	);
const taskCreateInput = z
	.strictObject({
		spec: z.string().trim().min(1).optional(),
		parent: z.string().trim().min(1).optional(),
		title: z.string().trim().min(1),
		description: z.string().trim().min(1),
		profile: z.string().trim().min(1),
		subkind: z.enum(taskSubkinds).optional(),
		dependsOn: z.array(z.string().trim().min(1)).optional(),
		generatedBy: z.string().trim().min(1).optional(),
	})
	.refine(
		(input) => input.spec !== undefined || input.parent !== undefined,
		"Either spec or parent is required.",
	);
const grillingCreateInput = z.strictObject({
	title: z.string().trim().min(1),
	description: z.string().trim().min(1),
	parent: z.string().trim().min(1).optional(),
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

const wayfinderTransitions = [
	{
		from: { state: "ready", action: "planning" },
		event: "start",
		to: { state: "running", action: "planning" },
	},
	{
		from: { state: "ready", action: "planning" },
		event: "succeed",
		to: { state: "done", action: "none" },
	},
	{
		from: { state: "running", action: "planning" },
		event: "succeed",
		to: { state: "done", action: "none" },
	},
] as const;

const grillingTransitions = [
	{
		from: { state: "ready", action: "discuss" },
		event: "start",
		to: { state: "in-discussion", action: "discuss" },
	},
	{
		from: { state: "in-discussion", action: "discuss" },
		event: "succeed",
		to: { state: "done", action: "none" },
	},
] as const;

export const genericTaskManifest = defineManifest({
	version: "v1",
	workflow: { id: "agent-workflow", version: "1.0.0" },
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
		activeStates: ["running"],
		terminalStates: ["done"],
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
			id: "wayfinder",
			label: "Wayfinder",
			initial: { state: "ready", action: "planning" },
			transitions: [...wayfinderTransitions],
		},
		{
			id: "task",
			label: "Task",
			initial: { state: "ready", action: "work" },
			subkinds: [...taskSubkinds],
			transitions: [...workTransitions],
		},
		{
			id: "grilling",
			label: "Grilling",
			initial: { state: "ready", action: "discuss" },
			transitions: [...grillingTransitions],
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
		{
			id: "task-generated-by-task",
			from: "task",
			to: "task",
			projection: { type: "generated-by" },
		},
		{
			id: "spec-grilling",
			from: "spec",
			to: "grilling",
			projection: { type: "parent-child" },
		},
		{
			id: "wayfinder-task",
			from: "wayfinder",
			to: "task",
			projection: { type: "parent-child" },
		},
		{
			id: "wayfinder-spec",
			from: "wayfinder",
			to: "spec",
			projection: { type: "parent-child" },
		},
		{
			id: "wayfinder-grilling",
			from: "wayfinder",
			to: "grilling",
			projection: { type: "parent-child" },
		},
	],
	commands: [
		{
			id: "spec-create",
			cli: { verb: "create", target: "spec" },
			target: { kind: "spec", action: "planning" },
			input: createInput,
		},
		{
			id: "wayfinder-create",
			cli: { verb: "create", target: "wayfinder" },
			target: { kind: "wayfinder", action: "planning" },
			input: createInput,
		},
		{
			id: "task-create",
			cli: { verb: "create", target: "task" },
			target: { kind: "task", action: "work" },
			input: taskCreateInput,
		},
		{
			id: "grilling-create",
			cli: { verb: "create", target: "grilling" },
			target: { kind: "grilling", action: "discuss" },
			input: grillingCreateInput,
		},
	],
});
