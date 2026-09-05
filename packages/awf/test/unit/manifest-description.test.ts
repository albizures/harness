import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeWorkflow } from "../../src/manifest/description.ts";
import { defineManifest } from "../../src/manifest/index.ts";

const stringInput = z.object({ value: z.string() });
const objectOutput = z.object({ ok: z.boolean() });

function descriptionManifest() {
	return defineManifest({
		version: "v1",
		workflow: { id: "description-test" },
		vocabulary: {
			states: ["backlog", "ready", "running", "need-human", "done"],
			actions: ["plan", "implement", "review", "none"],
			reasons: ["blocked", "answered"],
			events: ["schedule", "start", "succeed", "escalate"],
		},
		github: { reservedPrefix: "secret-prefix" },
		concurrency: {
			perIssue: 1,
			perWorkflow: 2,
			perKind: { spec: 1, ticket: 3 },
		},
		readiness: {
			filters: [
				{ kind: "spec", state: "ready", action: "plan" },
				{ kind: "ticket", reason: "answered" },
			],
			namedFilters: [
				{ name: "for-spec", kind: "spec", relationship: "parent" },
			],
			relationshipPolicies: [
				{
					relationship: "children",
					where: { kind: "spec", state: "ready" },
					children: { all: { kind: "ticket", state: "done" }, min: 1 },
					gate: "all-tickets-done",
				},
			],
		},
		lifecycle: {
			retry: { allow: [{ kind: "ticket", action: "implement" }] },
			escalation: {
				allow: [{ kind: "spec", action: "plan" }],
				input: stringInput,
			},
			resume: { allow: [{ kind: "spec", actions: ["plan", "review"] }] },
			relationshipPolicies: [
				{
					relationship: "parent",
					child: { kind: "ticket", state: "done" },
					parent: { kind: "spec", state: "running" },
					siblings: { all: { kind: "ticket", state: "done" }, min: 2 },
					to: { state: "ready", action: "review" },
				},
			],
		},
		kinds: [
			{
				id: "spec",
				label: "Spec",
				initial: { state: "backlog", action: "plan" },
				transitions: [
					{
						from: { state: "backlog", action: "plan" },
						event: "schedule",
						input: stringInput,
						to: { state: "ready", action: "plan" },
					},
					{
						from: { state: "ready", action: "plan" },
						event: "start",
						to: { state: "running", action: "plan" },
					},
				],
			},
			{
				id: "ticket",
				label: "Ticket",
				initial: { state: "ready", action: "implement" },
				transitions: [],
			},
		],
		commands: [
			{
				id: "createSpec",
				cli: { verb: "create", target: "spec" },
				target: { kind: "spec", action: "plan" },
				input: stringInput,
				output: objectOutput,
			},
			{
				id: "createTicketFromSpec",
				cli: { verb: "create", target: "ticket", source: true },
				target: { kind: "ticket", action: "implement" },
			},
			{
				id: "applyPlan",
				cli: { verb: "apply", target: "plan" },
				target: { kind: "spec", action: "review" },
				input: stringInput,
			},
		],
		relationships: [
			{
				id: "spec-tickets",
				from: "spec",
				to: "ticket",
				projection: { type: "parent-child", direction: "outbound" },
			},
		],
	});
}

describe("when building a Workflow description DTO", () => {
	it("should expose v1 declarative manifest data in manifest order", () => {
		const description = describeWorkflow(descriptionManifest());

		expect(description.version).toBe("v1");
		expect(description.workflow).toEqual({ id: "description-test" });
		expect(description.vocabulary.states).toEqual([
			"backlog",
			"ready",
			"running",
			"need-human",
			"done",
		]);
		expect(description.kinds.map((kind) => kind.id)).toEqual([
			"spec",
			"ticket",
		]);
		expect(
			description.kinds[0]?.transitions.map((transition) => transition.event),
		).toEqual(["schedule", "start"]);
		expect(description.commands.map((command) => command.id)).toEqual([
			"createSpec",
			"createTicketFromSpec",
			"applyPlan",
		]);
		expect(description.readiness?.filters).toEqual([
			{ kind: "spec", state: "ready", action: "plan" },
			{ kind: "ticket", reason: "answered" },
		]);
		expect(description.lifecycle?.relationshipPolicies?.[0]?.to).toEqual({
			state: "ready",
			action: "review",
		});
		expect(
			description.relationships?.map((relationship) => relationship.id),
		).toEqual(["spec-tickets"]);
	});

	it("should use schema presence markers and generated manifest CLI usage", () => {
		const description = describeWorkflow(descriptionManifest());

		expect(description.kinds[0]?.transitions).toMatchObject([
			{ event: "schedule", input: { required: true } },
			{ event: "start", input: { required: false } },
		]);
		expect(description.commands).toMatchObject([
			{
				id: "createSpec",
				cli: { usage: "awf create spec --input <file|->" },
				input: { required: true },
				output: { declared: true },
			},
			{
				id: "createTicketFromSpec",
				cli: { usage: "awf create ticket --source <issue> --input <file|->" },
				input: { required: false },
				output: { declared: false },
			},
			{
				id: "applyPlan",
				cli: { usage: "awf apply plan <issue> --input <file|->" },
				input: { required: true },
				output: { declared: false },
			},
		]);
		expect(description.lifecycle?.escalation?.input).toEqual({
			required: true,
		});
		expect(JSON.stringify(description)).not.toContain("_def");
		expect(JSON.stringify(description)).not.toContain("secret-prefix");
	});

	it("should exclude runtime, live, config-only, and raw schema details", () => {
		const workflowModule = {
			manifest: descriptionManifest(),
			tracker: { getIssue: () => undefined },
			commandHandlers: { createSpec: () => undefined },
			lifecycleHandlers: { "spec:running/plan:succeed": () => undefined },
			configPath: "/tmp/awf.config.ts",
		};

		const description = describeWorkflow(workflowModule.manifest);
		const serialized = JSON.stringify(description);

		expect(serialized).not.toContain("tracker");
		expect(serialized).not.toContain("commandHandlers");
		expect(serialized).not.toContain("lifecycleHandlers");
		expect(serialized).not.toContain("configPath");
		expect(serialized).not.toContain("_def");
		expect(description.scopeNotes).toEqual([
			"Describes the loaded Workflow manifest only.",
			"Does not inspect Tracker API state, issue counts, active runs, actual dependencies, runtime handlers, config paths, raw Zod schemas, or parsed schema structures.",
		]);
	});
});
