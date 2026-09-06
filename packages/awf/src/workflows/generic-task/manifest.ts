import { z } from "zod";
import { defineManifest } from "../../manifest/definition.ts";

const states = ["ready", "running", "done", "need-human"] as const;
const actions = ["work", "none"] as const;
const events = ["start", "succeed", "fail"] as const;

const createInput = z.looseObject({
	title: z.string().optional(),
	body: z.string().optional(),
	content: z.string().optional(),
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
	commands: [
		{
			id: "spec-create",
			cli: { verb: "create", target: "spec" },
			target: { kind: "spec", action: "work" },
			input: createInput,
		},
		{
			id: "task-create",
			cli: { verb: "create", target: "task" },
			target: { kind: "task", action: "work" },
			input: createInput,
		},
	],
});
