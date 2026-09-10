import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeWorkflow } from "../../src/domain/manifest/describe.ts";
import { defineManifest } from "../../src/manifest/index.ts";

const stringInput = z.object({ value: z.string() });

function descriptionManifest() {
	return defineManifest({
		version: "v1",
		workflow: { id: "description-test", version: "1.2.3" },
		vocabulary: {
			states: ["backlog", "ready", "running", "need-human", "done"],
			actions: ["plan", "implement", "review", "none"],
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
				{ kind: "ticket", state: "ready" },
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
			activeStates: ["running"],
			terminalStates: ["done"],
			retry: { allow: [{ kind: "ticket", action: "implement" }] },
			escalation: {
				allow: [{ kind: "spec", action: "plan" }],
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
			},
			{
				id: "createTicket",
				cli: { verb: "create", target: "ticket" },
				target: { kind: "ticket", action: "implement" },
			},
			{
				id: "scorePlan",
				cli: { verb: "score", target: "plan" },
				target: { kind: "spec", action: "review" },
				input: stringInput,
			},
		],
		relationships: [
			{
				id: "spec-tickets",
				from: "spec",
				to: "ticket",
				projection: { type: "parent-child" },
			},
		],
	});
}

describe("when building a Workflow description DTO", () => {
	it("should expose v1 declarative manifest data in manifest order", () => {
		const description = describeWorkflow(descriptionManifest());

		expect(description.version).toBe("v1");
		expect(description.workflow).toEqual({
			id: "description-test",
			version: "1.2.3",
		});
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
			"createTicket",
			"scorePlan",
		]);
		expect(description.readiness?.filters).toEqual([
			{ kind: "spec", state: "ready", action: "plan" },
			{ kind: "ticket", state: "ready" },
		]);
		expect(description.lifecycle?.activeStates).toEqual(["running"]);
		expect(description.lifecycle?.terminalStates).toEqual(["done"]);
		expect(description.lifecycle?.relationshipPolicies?.[0]?.to).toEqual({
			state: "ready",
			action: "review",
		});
		expect(description.relationships).toEqual([
			{
				id: "spec-tickets",
				from: "spec",
				to: "ticket",
				projection: { type: "parent-child" },
			},
		]);
	});

	it("should use command input schema presence markers and generated manifest CLI usage", () => {
		const description = describeWorkflow(descriptionManifest());

		expect(description.kinds[0]?.transitions).toMatchObject([
			{ event: "schedule" },
			{ event: "start" },
		]);
		expect(description.commands).toMatchObject([
			{
				id: "createSpec",
				cli: { usage: "awf create spec --input <file|->" },
				input: { required: true },
			},
			{
				id: "createTicket",
				cli: { usage: "awf create ticket --input <file|->" },
				input: { required: false },
			},
			{
				id: "scorePlan",
				cli: { usage: "awf score plan <issue> --input <file|->" },
				input: { required: true },
			},
		]);
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
			"Does not inspect Tracker API state, issue counts, active attempts, actual dependencies, runtime handlers, config paths, raw Zod schemas, or parsed schema structures.",
		]);
	});
});
