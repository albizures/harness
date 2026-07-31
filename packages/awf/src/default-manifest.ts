import { defineManifest } from "./manifest.ts";

const states = ["ready", "running", "blocked", "done"] as const;
const actions = ["plan", "implement", "none"] as const;

export const defaultManifest = defineManifest({
	version: "v1",
	workflow: { id: "agent-development" },
	vocabulary: {
		states: [...states],
		actions: [...actions],
		reasons: ["dependencies"],
		events: ["start", "succeed", "fail"],
	},
	github: {
		labelPrefixes: {
			kind: "type:",
			state: "state:",
			action: "action:",
			reason: "reason:",
		},
	},
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { ticket: 3 } },
	kinds: [
		{
			id: "spec",
			label: "type:spec",
			initial: { state: "ready", action: "plan" },
			transitions: [
				{
					from: { state: "ready", action: "plan" },
					event: "start",
					to: { state: "running", action: "plan" },
				},
				{
					from: { state: "running", action: "plan" },
					event: "succeed",
					to: { state: "done", action: "none" },
				},
			],
		},
		{
			id: "ticket",
			label: "type:ticket",
			initial: { state: "ready", action: "implement" },
			transitions: [
				{
					from: { state: "ready", action: "implement" },
					event: "start",
					to: { state: "running", action: "implement" },
				},
				{
					from: { state: "running", action: "implement" },
					event: "succeed",
					to: { state: "done", action: "none" },
				},
				{
					from: { state: "running", action: "implement" },
					event: "fail",
					to: { state: "blocked", action: "implement", reason: "dependencies" },
				},
			],
		},
	],
	commands: [
		{
			id: "plan-apply",
			target: { kind: "spec", action: "plan" },
			input: {
				type: "object",
				required: ["plan"],
				properties: { plan: { type: "string", artifact: "file" } },
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: {
					tickets: {
						type: "array",
						items: { type: "string", artifact: "issue" },
					},
				},
			},
		},
	],
	relationships: [
		{
			id: "spec-tickets",
			from: "spec",
			to: "ticket",
			projection: { type: "parent-child", direction: "outbound" },
		},
		{
			id: "ticket-dependencies",
			from: "ticket",
			to: "ticket",
			projection: { type: "dependency", direction: "outbound" },
		},
	],
});
