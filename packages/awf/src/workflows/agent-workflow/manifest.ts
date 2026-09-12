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
const actions = [
	"planning",
	"work",
	"discuss",
	"integration-test",
	"merge",
	"none",
] as const;
const events = [
	"start",
	"succeed",
	"fail",
	"recover",
	"escalate",
	"pause",
	"resume",
] as const;
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
	workflow: { id: "agent-workflow", version: "1.0.0" },
	vocabulary: {
		states: [...states],
		actions: [...actions],
		events: [...events],
	},
	github: { reservedPrefix: "awf" },
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { task: 3 } },
	readiness: {
		filters: [
			{ kind: "spec", state: "ready", action: "planning" },
			{ kind: "task", state: "ready", action: "work" },
		],
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
		profileGroups: [
			{
				name: "implementation-gate",
				profiles: ["implement", "implementation", "engineering", "review"],
			},
		],
		relationshipPolicies: [
			{
				relationship: "siblings",
				where: {
					kind: "task",
					state: "ready",
					action: "work",
					profile: "integration-test",
				},
				siblings: {
					all: {
						kind: "task",
						state: "done",
						action: "none",
						profileGroup: "implementation-gate",
					},
				},
				gate: "implementation-gate",
			},
			{
				relationship: "siblings",
				where: {
					kind: "task",
					state: "ready",
					action: "work",
					profile: "merge",
				},
				siblings: {
					all: {
						kind: "task",
						state: "done",
						action: "none",
						profileGroup: "implementation-gate",
					},
				},
				gate: "implementation-gate",
			},
			{
				relationship: "siblings",
				where: {
					kind: "task",
					state: "ready",
					action: "work",
					profile: "merge",
				},
				siblings: {
					all: {
						kind: "task",
						state: "done",
						action: "none",
						profile: "integration-test",
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
			id: "spec-complete",
			cli: { verb: "spec", target: "complete", input: "none" },
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
			cli: { verb: "task", target: "start" },
			target: { kind: "task", state: "ready", action: "work" },
			transition: { event: "start", attempt: "start" },
		},
		{
			id: "task-fail",
			cli: { verb: "task", target: "fail" },
			target: { kind: "task", state: "running", action: "work" },
			transition: { event: "fail", attempt: "complete" },
		},
		{
			id: "task-recover",
			cli: { verb: "task", target: "recover" },
			target: { kind: "task", state: "need-human", action: "none" },
			transition: { event: "recover", attempt: "none" },
		},
		{
			id: "task-escalate",
			cli: { verb: "task", target: "escalate" },
			target: { kind: "task", state: "running", action: "work" },
			transition: { event: "escalate", attempt: "complete" },
		},
	],
});
