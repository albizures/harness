import { defineManifest } from "./manifest.ts";

const states = ["ready", "running", "blocked", "done", "need-human"] as const;
const actions = [
	"plan",
	"implement",
	"review",
	"fix",
	"merge",
	"integration-test",
	"none",
] as const;

const ticketImplementationInput = {
	type: "object",
	required: ["implementationPr"],
	properties: {
		implementationPr: { type: "string", artifact: "pull-request" },
	},
	additionalProperties: false,
} as const;

const reviewApprovedInput = {
	type: "object",
	required: ["verdict"],
	properties: { verdict: { type: "string" } },
	additionalProperties: false,
} as const;

const reviewChangesInput = {
	type: "object",
	required: ["verdict", "findings"],
	properties: {
		verdict: { type: "string" },
		findings: { type: "array", items: { type: "string", artifact: "finding" } },
	},
	additionalProperties: false,
} as const;

const fixInput = {
	type: "object",
	required: ["summary"],
	properties: { summary: { type: "string" } },
	additionalProperties: false,
} as const;

const integrationPassedInput = {
	type: "object",
	required: ["verdict", "specPr"],
	properties: {
		verdict: { type: "string" },
		specPr: { type: "string", artifact: "pull-request" },
	},
	additionalProperties: false,
} as const;

const integrationChangesNeededInput = {
	type: "object",
	required: ["verdict", "findings"],
	properties: {
		verdict: { type: "string" },
		findings: { type: "array", items: { type: "string", artifact: "finding" } },
	},
	additionalProperties: false,
} as const;

const mergeInput = {
	type: "object",
	required: ["merged"],
	properties: { merged: { type: "boolean" } },
	additionalProperties: false,
} as const;

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
	readiness: {
		filters: [
			{ kind: "spec", state: "ready", action: "plan" },
			{ kind: "spec", state: "ready", action: "integration-test" },
			{ kind: "spec", state: "ready", action: "merge" },
			{ kind: "ticket", state: "ready", action: "implement" },
			{ kind: "ticket", state: "ready", action: "review" },
			{ kind: "ticket", state: "ready", action: "fix" },
			{ kind: "ticket", state: "ready", action: "merge" },
		],
	},
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
					from: { state: "ready", action: "plan" },
					event: "succeed",
					to: { state: "ready", action: "integration-test" },
				},
				{
					from: { state: "running", action: "plan" },
					event: "succeed",
					to: { state: "ready", action: "integration-test" },
				},
				{
					from: { state: "ready", action: "integration-test" },
					event: "start",
					to: { state: "running", action: "integration-test" },
				},
				{
					from: { state: "running", action: "integration-test" },
					event: "succeed",
					input: integrationPassedInput,
					to: { state: "ready", action: "merge" },
				},
				{
					from: { state: "running", action: "integration-test" },
					event: "fail",
					input: integrationChangesNeededInput,
					to: { state: "ready", action: "plan" },
				},
				{
					from: { state: "ready", action: "merge" },
					event: "start",
					to: { state: "running", action: "merge" },
				},
				{
					from: { state: "running", action: "merge" },
					event: "succeed",
					input: mergeInput,
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
					input: ticketImplementationInput,
					to: { state: "ready", action: "review" },
				},
				{
					from: { state: "ready", action: "review" },
					event: "start",
					to: { state: "running", action: "review" },
				},
				{
					from: { state: "running", action: "review" },
					event: "succeed",
					input: reviewApprovedInput,
					to: { state: "ready", action: "merge" },
				},
				{
					from: { state: "running", action: "review" },
					event: "fail",
					input: reviewChangesInput,
					to: { state: "ready", action: "fix" },
				},
				{
					from: { state: "ready", action: "fix" },
					event: "start",
					to: { state: "running", action: "fix" },
				},
				{
					from: { state: "running", action: "fix" },
					event: "succeed",
					input: fixInput,
					to: { state: "ready", action: "review" },
				},
				{
					from: { state: "ready", action: "merge" },
					event: "start",
					to: { state: "running", action: "merge" },
				},
				{
					from: { state: "running", action: "merge" },
					event: "succeed",
					input: mergeInput,
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
