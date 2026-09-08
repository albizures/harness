import { expect, it } from "vitest";
import { z } from "zod";
import { ManifestValidationError } from "../../src/manifest/manifest.ts";
import {
	defineManifest,
	validateManifest,
} from "../../src/manifest/definition.ts";
import { loadManifest, loadWorkflowModule } from "../../src/workflow-module.ts";

const validFixture = new URL("../fixtures/valid.workflow.ts", import.meta.url)
	.pathname;
const linkFixture = new URL("../fixtures/link.workflow.ts", import.meta.url)
	.pathname;
const moduleFixture = new URL("../fixtures/module.workflow.ts", import.meta.url)
	.pathname;
const missingManifestFixture = new URL(
	"../fixtures/missing-manifest.workflow.ts",
	import.meta.url,
).pathname;
const invalidTrackerFixture = new URL(
	"../fixtures/invalid-tracker.workflow.ts",
	import.meta.url,
).pathname;

it("should load a TypeScript-authored workflow manifest as declarative data", async () => {
	const manifest = await loadManifest(validFixture);

	expect(manifest.workflow.id).toBe("agent-development");
	expect(manifest.kinds.map((kind) => kind.id)).toEqual(["spec", "ticket"]);
	expect(
		manifest.commands.every(
			(command) =>
				command.input === undefined || command.input instanceof z.ZodType,
		),
	).toBe(true);
});

it("should load a Workflow module manifest and optional concrete tracker binding", async () => {
	const workflowModule = await loadWorkflowModule(moduleFixture);

	expect(workflowModule.manifest.workflow.id).toBe("agent-development");
	expect(typeof workflowModule.tracker?.getIssue).toBe("function");
	expect(
		typeof workflowModule.lifecycleHandlers?.[
			"ticket:running/implement:succeed"
		],
	).toBe("function");
});

it("should ensure that Workflow module loading requires a manifest export", async () => {
	await expect(loadWorkflowModule(missingManifestFixture)).rejects.toThrow(
		/Workflow module must export 'manifest'/,
	);
});

it("should ensure that Workflow module loading rejects non-concrete tracker exports", async () => {
	await expect(loadWorkflowModule(invalidTrackerFixture)).rejects.toThrow(
		/'tracker' must be a concrete Tracker instance/,
	);
});

it("should ensure that manifest loading validates the manifest export without requiring or checking tracker", async () => {
	const manifest = await loadManifest(invalidTrackerFixture);

	expect(manifest.workflow.id).toBe("agent-development");
});

it("should reject loaded TypeScript workflow manifests with Zod-owned shape errors", async () => {
	await expect(loadManifest(linkFixture)).rejects.toSatisfy(
		(error: unknown) => {
			expect(error instanceof ManifestValidationError).toBe(true);
			const issues = (error as ManifestValidationError).issues;
			expect(
				issues
					.map((issue) => issue.path)
					.filter((path) => path.includes("projection.type")),
			).toEqual(["$.relationships[2].projection.type"]);
			expect(issues.map((issue) => issue.message).join("\n")).toMatch(
				/parent-child, dependency, or generated-by/,
			);
			return true;
		},
	);
});

it("should ensure that defineManifest defaults the canonical GitHub reserved prefix and keeps Zod payload schemas as runtime contracts", () => {
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "tiny" },
		vocabulary: {
			states: ["ready", "running"],
			actions: ["implement"],
			reasons: [],
			events: ["start"],
		},
		concurrency: { perIssue: 1 },
		kinds: [
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
				],
			},
		],
		commands: [
			{
				id: "start",
				target: { kind: "ticket", action: "implement" },
				input: z.strictObject({
					pullRequest: z.strictObject({
						type: z.literal("pull-request"),
						url: z.string().trim().pipe(z.url()),
					}),
				}),
			},
		],
	});

	expect(validateManifest(manifest)).toEqual([]);
	expect(manifest.github.reservedPrefix).toBe("awf");
	expect(typeof manifest.kinds[0]?.transitions[0]?.event).toBe("string");
	expect(manifest.commands[0]?.input instanceof z.ZodType).toBe(true);
	expect(
		manifest.commands[0]?.input?.parse({
			pullRequest: {
				type: "pull-request",
				url: " https://github.com/albizures/harness/pull/52 ",
			},
		}),
	).toEqual({
		pullRequest: {
			type: "pull-request",
			url: "https://github.com/albizures/harness/pull/52",
		},
	});
});

it("should validate per-subkind concurrency against declared kind subkinds", () => {
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "subkind-concurrency" },
		vocabulary: {
			states: ["ready", "running"],
			actions: ["implement"],
			reasons: [],
			events: ["start"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: {
			perIssue: 1,
			perSubkind: { ticket: { bug: 1, feature: 2 } },
		},
		kinds: [
			{
				id: "ticket",
				label: "Ticket",
				initial: { state: "ready", action: "implement" },
				subkinds: ["bug", "feature"],
				transitions: [],
			},
		],
		commands: [],
	});

	expect(validateManifest(manifest)).toEqual([]);

	const invalid = {
		...manifest,
		concurrency: {
			perIssue: 1,
			perSubkind: {
				ticket: { bug: 0, feature: 1.5, missing: 1 },
				missing: { bug: 1 },
			},
		},
	};
	const messages = validateManifest(invalid)
		.map((issue) => `${issue.path} ${issue.message}`)
		.join("\n");
	expect(messages).toMatch(/perSubkind kind must reference a known kind/);
	expect(messages).toMatch(/perSubkind subkind must reference a known subkind/);
	expect(messages).toMatch(/perSubkind concurrency must be a positive integer/);
});

it("should validate manifest-declared CLI targets and named readiness filters", () => {
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "command-declarations" },
		vocabulary: {
			states: ["ready"],
			actions: ["implement"],
			reasons: [],
			events: ["start"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		readiness: {
			filters: [{ kind: "ticket", state: "ready", action: "implement" }],
			namedFilters: [{ name: "spec", kind: "ticket", relationship: "parent" }],
		},
		kinds: [
			{
				id: "ticket",
				label: "Ticket",
				initial: { state: "ready", action: "implement" },
				transitions: [],
			},
		],
		commands: [
			{
				id: "ticket-create",
				cli: { verb: "create", target: "ticket" },
				target: { kind: "ticket", action: "implement" },
			},
		],
	});

	expect(validateManifest(manifest)).toEqual([]);

	const invalid = {
		...manifest,
		readiness: {
			filters: [
				{ kind: "ticket", state: "ready", action: "implement" },
				{ kind: "ticket", state: "ready", action: "implement" },
			],
			namedFilters: [
				{ name: "spec", kind: "missing", relationship: "parent" },
				{ name: "spec", kind: "ticket", relationship: "parent" },
			],
		},
		commands: [
			...manifest.commands,
			{
				id: "ticket-create",
				cli: { verb: "create", target: "ticket" },
				target: { kind: "missing", action: "implement" },
			},
			{
				id: "bad-target",
				cli: { verb: "apply", target: "Bad Target" },
				target: { kind: "ticket", action: "missing" },
			},
		],
	};

	const messages = validateManifest(invalid)
		.map((issue) => `${issue.path} ${issue.message}`)
		.join("\n");
	expect(messages).toMatch(
		/Duplicate command target declaration 'create ticket'/,
	);
	expect(messages).toMatch(/Duplicate id 'ticket-create'/);
	expect(messages).toMatch(/Identifier must use lowercase/);
	expect(messages).toMatch(/Command target kind must reference a known kind/);
	expect(messages).toMatch(
		/Command target action must reference a known action/,
	);
	expect(messages).toMatch(/Duplicate readiness filter declaration/);
	expect(messages).toMatch(/Duplicate readiness filter name 'spec'/);
	expect(messages).toMatch(/Named readiness filter kind must be known/);
});

it("should reject executable hook fields embedded in workflow semantic declarations", () => {
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "semantic-hooks" },
		vocabulary: {
			states: ["ready", "running", "waiting-human", "done"],
			actions: ["planning", "work", "none"],
			reasons: [],
			events: ["start", "succeed", "respond"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		readiness: {
			filters: [{ kind: "task", state: "ready", action: "work" }],
		},
		kinds: [
			{
				id: "wayfinder",
				label: "Wayfinder",
				initial: { state: "ready", action: "planning" },
				transitions: [
					{
						from: { state: "ready", action: "planning" },
						event: "start",
						to: { state: "running", action: "planning" },
					},
				],
			},
			{
				id: "task",
				label: "Task",
				initial: { state: "ready", action: "work" },
				subkinds: ["research"],
				transitions: [],
			},
		],
		commands: [],
	});
	const invalid = {
		...manifest,
		readiness: {
			filters: [
				{
					kind: "task",
					state: "ready",
					action: "work",
					handler: () => undefined,
				},
			],
		},
		kinds: manifest.kinds.map((kind) =>
			kind.id === "task"
				? { ...kind, subkinds: ["research", { id: "prototype", run() {} }] }
				: {
						...kind,
						transitions: kind.transitions.map((transition) => ({
							...transition,
							hooks: { onSucceed() {} },
						})),
					},
		),
		lifecycle: {
			resume: {
				allow: [{ kind: "task", actions: ["work"], execute() {} }],
			},
		},
	};

	const messages = validateManifest(invalid)
		.map((issue) => `${issue.path} ${issue.message}`)
		.join("\n");
	expect(messages).toMatch(/\.subkinds\[1\]\.run/);
	expect(messages).toMatch(/\.readiness\.filters\[0\]\.handler/);
	expect(messages).toMatch(/\.transitions\[0\]\.hooks/);
	expect(messages).toMatch(/\.lifecycle\.resume\.allow\[0\]\.execute/);
	expect(messages).toMatch(/Executable hook fields/);
	expect(messages).toMatch(/Executable hooks are not allowed/);
});

it("should reject payload schemas outside command input declarations", () => {
	const manifest = {
		version: "v1",
		workflow: { id: "payload-boundaries" },
		vocabulary: {
			states: ["ready", "running"],
			actions: ["implement", "none"],
			reasons: [],
			events: ["start", "succeed"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		lifecycle: { escalation: { input: z.object({ reason: z.string() }) } },
		kinds: [
			{
				id: "ticket",
				label: "Ticket",
				initial: { state: "ready", action: "implement" },
				transitions: [
					{
						from: { state: "running", action: "implement" },
						event: "succeed",
						input: z.object({ summary: z.string() }),
						to: { state: "ready", action: "none" },
					},
				],
			},
		],
		commands: [
			{
				id: "create-ticket",
				target: { kind: "ticket", action: "implement" },
				input: z.object({ title: z.string() }),
				output: z.object({ id: z.string() }),
			},
		],
	};

	const messages = validateManifest(manifest)
		.map((issue) => `${issue.path} ${issue.message}`)
		.join("\n");
	expect(messages).toMatch(/Command output schemas are not supported/);
	expect(messages).toMatch(/Transition input schemas are not supported/);
	expect(messages).toMatch(/lifecycle\.escalation/);
	expect(messages).not.toMatch(/commands\[0\]\.input.*not supported/);
});

it("should reject tracker as a manifest field inside defineManifest data", () => {
	const manifestWithTracker = {
		version: "v1",
		workflow: { id: "tracker-field" },
		vocabulary: {
			states: ["ready"],
			actions: ["implement"],
			reasons: [],
			events: ["start"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		kinds: [
			{
				id: "ticket",
				label: "Ticket",
				initial: { state: "ready", action: "implement" },
				transitions: [],
			},
		],
		commands: [],
		tracker: {},
	};

	const messages = validateManifest(manifestWithTracker)
		.map((issue) => `${issue.path} ${issue.message}`)
		.join("\n");
	expect(messages).toMatch(/tracker/);
});

it("should reject non-declarative hooks, wildcards, unknown references, and malformed schemas", () => {
	const issues = validateManifest({
		version: "v1",
		workflow: { id: "bad" },
		vocabulary: {
			states: ["ready", "ready"],
			actions: ["implement", "review"],
			reasons: [],
			events: ["start"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		kinds: [
			{
				id: "ticket",
				label: "Ticket",
				initial: { state: "ready", action: "implement" },
				transitions: [
					{
						from: { state: "*", action: "implement" },
						event: "start",
						to: { state: "missing", action: "implement" },
					},
				],
				hooks: { onStart() {} },
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
			{
				id: "wrong-local-target",
				target: { kind: "ticket", action: "review" },
			},
		],
		relationships: [
			{
				id: "rel",
				from: "ticket",
				to: "missing",
				projection: { type: "columns" },
			},
		],
	});

	const messages = issues
		.map((issue) => `${issue.path} ${issue.message}`)
		.join("\n");
	expect(messages).toMatch(/Duplicate vocabulary id 'ready'/);
	expect(messages).toMatch(/wildcard/);
	expect(messages).toMatch(/known state/);
	expect(messages).toMatch(/Executable hooks/);
	expect(messages).toMatch(/target action/);
	expect(messages).toMatch(/local states or transitions/);
	expect(messages).toMatch(/Payload schema must be a Zod schema/);
	expect(messages).toMatch(/Relationship target/);
	expect(messages).toMatch(/projection type/);
});
