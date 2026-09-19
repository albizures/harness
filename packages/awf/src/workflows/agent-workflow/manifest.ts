import { z } from "zod";
import { defineManifest } from "../../domain/manifest/define.ts";

const states = [
	"ready",
	"running",
	"in-discussion",
	"done",
	"need-human",
	"waiting-human",
] as const;
const actions = ["planning", "work", "discuss", "none"] as const;
const events = [
	"start",
	"succeed",
	"fail",
	"recover",
	"escalate",
	"pause",
	"resume",
] as const;
const taskKinds = [
	"task:work",
	"task:research",
	"task:prototype",
	"task:work:integration-test",
	"task:work:merge",
] as const;

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
const taskBaseCreateInputShape = {
	spec: z.string().trim().min(1).optional(),
	parent: z.string().trim().min(1).optional(),
	title: z.string().trim().min(1),
	description: z.string().trim().min(1),
	profile: z.string().trim().min(1),
	dependsOn: z.array(z.string().trim().min(1)).optional(),
	generatedBy: z.string().trim().min(1).optional(),
} as const;
const directTaskCreateInput = z
	.strictObject(taskBaseCreateInputShape)
	.refine(
		(input) => input.spec !== undefined || input.parent !== undefined,
		"Either spec or parent is required.",
	);
const taskCreateInput = z
	.strictObject({
		...taskBaseCreateInputShape,
		kind: z.enum(taskKinds),
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
const wayfinderCompletionInput = z.strictObject({
	summary: z.string().trim().min(1),
});
const anyJsonObjectInput = z.record(z.string(), z.unknown());

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
	{
		from: { state: "need-human", action: "none" },
		event: "recover",
		to: { state: "ready", action: "work" },
	},
	{
		from: { state: "running", action: "work" },
		event: "escalate",
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

export const agentWorkflowManifest = defineManifest({
	version: "v1",
	workflow: { id: "w1", version: "1.0.0" },
	vocabulary: {
		states: [...states],
		actions: [...actions],
		events: [...events],
	},
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { task: 3 } },
	readiness: {
		filters: [
			{ kind: "spec", state: "ready", action: "planning" },
			{ kind: "task", state: "ready", action: "work" },
		],
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
		kindGroups: [
			{
				name: "implementation-gate",
				kinds: ["task:work"],
			},
		],
		relationshipPolicies: [
			{
				relationship: "siblings",
				where: {
					kind: "task:work:integration-test",
					state: "ready",
					action: "work",
				},
				siblings: {
					all: {
						kindGroup: "implementation-gate",
						state: "done",
						action: "none",
					},
				},
				gate: "implementation-gate",
			},
			{
				relationship: "siblings",
				where: {
					kind: "task:work:merge",
					state: "ready",
					action: "work",
				},
				siblings: {
					all: {
						kindGroup: "implementation-gate",
						state: "done",
						action: "none",
					},
				},
				gate: "implementation-gate",
			},
			{
				relationship: "siblings",
				where: {
					kind: "task:work:merge",
					state: "ready",
					action: "work",
				},
				siblings: {
					all: {
						kind: "task:work:integration-test",
						state: "done",
						action: "none",
					},
					min: 1,
				},
				gate: "integration-test-done",
			},
		],
	},
	lifecycle: {
		activeStates: ["running", "in-discussion"],
		terminalStates: ["done"],
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
			transitions: [...workTransitions],
		},
		{
			id: "task:work",
			label: "Work Task",
		},
		{
			id: "task:research",
			label: "Research Task",
		},
		{
			id: "task:prototype",
			label: "Prototype Task",
		},
		{
			id: "task:work:integration-test",
			label: "Integration-test Task",
		},
		{
			id: "task:work:merge",
			label: "Merge Task",
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
			id: "spec-planned",
			cli: { verb: "spec", target: "planned", input: "none" },
			target: { kind: "spec", action: "planning" },
		},
		{
			id: "spec-complete",
			cli: { verb: "spec", target: "complete" },
			target: { kind: "spec", state: "ready", action: "none" },
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
			id: "task-work-create",
			cli: { verb: "create", target: "task:work" },
			target: { kind: "task:work", action: "work" },
			input: directTaskCreateInput,
		},
		{
			id: "task-research-create",
			cli: { verb: "create", target: "task:research" },
			target: { kind: "task:research", action: "work" },
			input: directTaskCreateInput,
		},
		{
			id: "task-prototype-create",
			cli: { verb: "create", target: "task:prototype" },
			target: { kind: "task:prototype", action: "work" },
			input: directTaskCreateInput,
		},
		{
			id: "task-work-integration-test-create",
			cli: { verb: "create", target: "task:work:integration-test" },
			target: { kind: "task:work:integration-test", action: "work" },
			input: directTaskCreateInput,
		},
		{
			id: "task-work-merge-create",
			cli: { verb: "create", target: "task:work:merge" },
			target: { kind: "task:work:merge", action: "work" },
			input: directTaskCreateInput,
		},
		{
			id: "grilling-create",
			cli: { verb: "create", target: "grilling" },
			target: { kind: "grilling", action: "discuss" },
			input: grillingCreateInput,
		},
		{ id: "start", target: { kind: "task", action: "work" } },
		{ id: "succeed", target: { kind: "task", action: "work" } },
		{ id: "fail", target: { kind: "task", action: "work" } },
		{ id: "pause", target: { kind: "task", action: "work" } },
		{ id: "escalate", target: { kind: "task", action: "work" } },
		{ id: "resume", target: { kind: "task", action: "none" } },
		{
			id: "task-start",
			cli: { verb: "task", target: "start", input: "none" },
			target: { kind: "task", state: "ready", action: "work" },
			transition: { event: "start", attempt: "start" },
		},
		{
			id: "task-succeed",
			cli: { verb: "task", target: "succeed", input: "json" },
			target: { kind: "task", state: "running", action: "work" },
			transition: { event: "succeed", attempt: "complete" },
			input: anyJsonObjectInput,
		},
		{
			id: "task-fail",
			cli: { verb: "task", target: "fail", input: "none" },
			target: { kind: "task", state: "running", action: "work" },
			transition: { event: "fail", attempt: "complete" },
		},
		{
			id: "task-recover",
			cli: { verb: "task", target: "recover", input: "none" },
			target: { kind: "task", state: "need-human", action: "none" },
			transition: { event: "recover", attempt: "none" },
		},
		{
			id: "task-escalate",
			cli: { verb: "task", target: "escalate", input: "none" },
			target: { kind: "task", state: "running", action: "work" },
			transition: { event: "escalate", attempt: "complete" },
		},
		{
			id: "wayfinder-start",
			cli: { verb: "wayfinder", target: "start", input: "none" },
			target: { kind: "wayfinder", state: "ready", action: "planning" },
			transition: { event: "start", attempt: "start" },
		},
		{
			id: "wayfinder-succeed",
			cli: { verb: "wayfinder", target: "succeed", input: "json" },
			target: { kind: "wayfinder", action: "planning" },
			transition: { event: "succeed", attempt: "complete" },
			input: wayfinderCompletionInput,
		},
		{
			id: "grilling-start",
			cli: { verb: "grilling", target: "start", input: "none" },
			target: { kind: "grilling", state: "ready", action: "discuss" },
			transition: { event: "start", attempt: "start" },
		},
		{
			id: "grilling-succeed",
			cli: { verb: "grilling", target: "succeed", input: "json" },
			target: { kind: "grilling", state: "in-discussion", action: "discuss" },
			transition: { event: "succeed", attempt: "complete" },
			input: anyJsonObjectInput,
		},
	],
});
