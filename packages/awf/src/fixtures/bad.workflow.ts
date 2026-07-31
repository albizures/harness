import { defineManifest, type WorkflowManifest } from "../manifest.ts";

export const manifest = defineManifest({
	version: "v1",
	workflow: { id: "bad-workflow" },
	vocabulary: {
		states: ["ready", "ready"],
		actions: ["implement"],
		reasons: [],
		events: ["start"],
	},
	github: {
		labelPrefixes: {
			kind: "type:",
			state: "state:",
			action: "action:",
			reason: "reason:",
		},
	},
	concurrency: { perIssue: 1 },
	kinds: [
		{
			id: "ticket",
			label: "type:ticket",
			initial: { state: "ready", action: "implement" },
			transitions: [
				{
					from: { state: "*", action: "implement" },
					event: "start",
					to: { state: "missing", action: "implement" },
				},
			],
			hooks: { onStart: "not allowed" },
		},
	],
	commands: [
		{
			id: "implement",
			target: { kind: "ticket", action: "missing" },
			input: {
				type: "object",
				properties: { pr: { type: "object", artifact: "pull-request" } },
			},
		},
	],
	relationships: [
		{
			id: "bad-rel",
			from: "ticket",
			to: "missing",
			projection: { type: "invalid" },
		},
	],
} as unknown as WorkflowManifest);
