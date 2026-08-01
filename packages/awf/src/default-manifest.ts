import { z } from "zod";
import { artifacts, defineManifest } from "./manifest.ts";

const states = ["ready", "running", "done", "need-human"] as const;
const actions = [
	"plan",
	"implement",
	"review",
	"fix",
	"merge",
	"integration-test",
	"none",
] as const;

const ticketImplementationInput = artifacts.object({
	implementationPr: artifacts.pullRequest(),
});

const reviewApprovedInput = artifacts.object({
	verdict: z.string(),
});

const reviewChangesInput = artifacts.object({
	verdict: z.string(),
	findings: artifacts.array(artifacts.finding()),
});

const fixInput = artifacts.object({
	summary: z.string(),
});

const integrationPassedInput = artifacts.object({
	verdict: z.string(),
	specPr: artifacts.pullRequest(),
});

const integrationChangesNeededInput = artifacts.object({
	verdict: z.string(),
	findings: artifacts.array(artifacts.finding()),
});

const mergeInput = artifacts.object({
	merged: z.boolean(),
});

const specCreateInput = artifacts.object({
	spec: artifacts.markdown(),
});

const specCreateOutput = z.looseObject({
	issue: z.looseObject({ id: z.string() }),
});

const planTicketInput = artifacts.object({
	key: z.string(),
	title: z.string(),
	content: z.string(),
	dependsOn: z.array(z.string()).optional(),
});

const planApplyInput = artifacts.object({
	tickets: artifacts.array(planTicketInput),
});

const planApplyOutput = z.looseObject({
	tickets: artifacts.array(
		artifacts.object({
			key: z.string(),
			id: z.string(),
		}),
	),
});

const handoffCreateInput = artifacts.object({
	handoff: artifacts.handoff(),
});

const handoffCreateOutput = z.looseObject({
	artifact: z.looseObject({
		id: z.string(),
		kind: z.literal("handoff"),
		uri: artifacts.handoff(),
	}),
});

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
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
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
					to: { state: "ready", action: "implement" },
				},
			],
		},
	],
	commands: [
		{
			id: "spec-create",
			cli: { verb: "create", target: "spec" },
			target: { kind: "spec", action: "plan" },
			input: specCreateInput,
			output: specCreateOutput,
		},
		{
			id: "plan-apply",
			cli: { verb: "apply", target: "plan" },
			target: { kind: "spec", action: "plan" },
			input: planApplyInput,
			output: planApplyOutput,
		},
		{
			id: "handoff-create",
			cli: { verb: "create", target: "handoff" },
			target: { kind: "ticket", action: "review" },
			input: handoffCreateInput,
			output: handoffCreateOutput,
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
