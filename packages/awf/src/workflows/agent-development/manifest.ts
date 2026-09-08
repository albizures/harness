import { z } from "zod";
import { defineManifest } from "../../manifest/definition.ts";

const states = [
	"ready",
	"running",
	"done",
	"need-human",
	"waiting-human",
] as const;
const actions = [
	"plan",
	"implement",
	"review",
	"fix",
	"merge",
	"integration-test",
	"none",
] as const;

const markdownReferenceInput = z.union([
	z.string().min(1),
	z.strictObject({ type: z.literal("markdown"), ref: z.string().min(1) }),
]);

const handoffReferenceInput = z.union([
	z.string().min(1),
	z.strictObject({ type: z.literal("handoff"), ref: z.string().min(1) }),
	z.strictObject({ type: z.literal("handoff"), url: z.url() }),
	z.strictObject({ type: z.literal("handoff"), path: z.string().min(1) }),
]);

const specCreateInput = z.strictObject({ spec: markdownReferenceInput });

const planTicketInput = z.strictObject({
	key: z.string(),
	title: z.string(),
	content: z.string(),
	dependsOn: z.array(z.string()).optional(),
});

const planApplyInput = z.strictObject({
	tickets: z.array(planTicketInput),
});

const handoffCreateInput = z.strictObject({ handoff: handoffReferenceInput });

export const agentDevelopmentManifest = defineManifest({
	version: "v1",
	workflow: { id: "agent-development", version: "1.0.0" },
	vocabulary: {
		states: [...states],
		actions: [...actions],
		reasons: ["dependencies"],
		events: ["start", "succeed", "fail", "pause", "respond"],
	},
	github: { reservedPrefix: "awf" },
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
		relationshipPolicies: [
			{
				relationship: "children",
				where: { kind: "spec", state: "ready", action: "integration-test" },
				children: { all: { kind: "ticket", state: "done" }, min: 1 },
				gate: "children",
			},
		],
	},
	lifecycle: {
		activeStates: ["running"],
		terminalStates: ["done"],
		relationshipPolicies: [
			{
				relationship: "parent",
				child: { kind: "ticket", state: "done", action: "none" },
				parent: { kind: "spec", state: "ready", action: "none" },
				siblings: { all: { kind: "ticket", state: "done" }, min: 1 },
				to: { state: "ready", action: "integration-test" },
			},
		],
	},
	kinds: [
		{
			id: "spec",
			label: "Spec",
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
					to: { state: "ready", action: "none" },
				},
				{
					from: { state: "running", action: "plan" },
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
					to: { state: "done", action: "none" },
				},
			],
		},
		{
			id: "ticket",
			label: "Ticket",
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
					to: { state: "ready", action: "merge" },
				},
				{
					from: { state: "running", action: "review" },
					event: "fail",
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
		},
		{
			id: "plan-apply",
			cli: { verb: "apply", target: "plan" },
			target: { kind: "spec", action: "plan" },
			input: planApplyInput,
		},
		{
			id: "handoff-create",
			cli: { verb: "create", target: "handoff", source: true },
			target: { kind: "ticket", action: "review" },
			input: handoffCreateInput,
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
