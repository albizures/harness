import assert from "node:assert/strict";
import test from "node:test";
import { defineManifest, loadManifest, validateManifest } from "./manifest.ts";

const validFixture = new URL("./fixtures/valid.workflow.ts", import.meta.url)
	.pathname;

test("loads a TypeScript-authored workflow manifest as declarative data", async () => {
	const manifest = await loadManifest(validFixture);

	assert.equal(manifest.workflow.id, "agent-development");
	assert.deepEqual(
		manifest.kinds.map((kind) => kind.id),
		["spec", "ticket"],
	);
	assert.equal(containsFunction(manifest), false);
});

test("defineManifest gives TypeScript authoring ergonomics without adding behavior", () => {
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "tiny" },
		vocabulary: {
			states: ["ready", "running"],
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
						from: { state: "ready", action: "implement" },
						event: "start",
						to: { state: "running", action: "implement" },
					},
				],
			},
		],
		commands: [
			{ id: "start", target: { kind: "ticket", action: "implement" } },
		],
	});

	assert.deepEqual(validateManifest(manifest), []);
	assert.equal(typeof manifest.kinds[0]?.transitions[0]?.event, "string");
});

test("rejects non-declarative hooks, wildcards, unknown references, and malformed schemas", () => {
	const issues = validateManifest({
		version: "v1",
		workflow: { id: "bad" },
		vocabulary: {
			states: ["ready", "ready"],
			actions: ["implement", "review"],
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
	assert.match(messages, /Duplicate vocabulary id 'ready'/);
	assert.match(messages, /wildcard/);
	assert.match(messages, /known state/);
	assert.match(messages, /Executable hooks/);
	assert.match(messages, /target action/);
	assert.match(messages, /local states or transitions/);
	assert.match(messages, /Artifact reference/);
	assert.match(messages, /Relationship target/);
	assert.match(messages, /projection type/);
});

function containsFunction(value: unknown): boolean {
	if (typeof value === "function") {
		return true;
	}
	if (Array.isArray(value)) {
		return value.some(containsFunction);
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).some(containsFunction);
	}
	return false;
}
