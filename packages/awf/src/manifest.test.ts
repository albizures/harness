import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
	artifacts,
	defineManifest,
	loadManifest,
	ManifestValidationError,
	validateManifest,
} from "./manifest.ts";

const validFixture = new URL("./fixtures/valid.workflow.ts", import.meta.url)
	.pathname;
const linkFixture = new URL("./fixtures/link.workflow.ts", import.meta.url)
	.pathname;

test("loads a TypeScript-authored workflow manifest as declarative data", async () => {
	const manifest = await loadManifest(validFixture);

	assert.equal(manifest.workflow.id, "agent-development");
	assert.deepEqual(
		manifest.kinds.map((kind) => kind.id),
		["spec", "ticket"],
	);
	assert.equal(
		manifest.commands.every(
			(command) =>
				command.input === undefined || command.input instanceof z.ZodType,
		),
		true,
	);
});

test("rejects loaded TypeScript workflow manifests with Zod-owned shape errors", async () => {
	await assert.rejects(loadManifest(linkFixture), (error: unknown) => {
		assert.equal(error instanceof ManifestValidationError, true);
		const issues = (error as ManifestValidationError).issues;
		assert.deepEqual(
			issues
				.map((issue) => issue.path)
				.filter((path) => path.includes("projection.type")),
			["$.relationships[2].projection.type"],
		);
		assert.match(
			issues.map((issue) => issue.message).join("\n"),
			/parent-child or dependency/,
		);
		return true;
	});
});

test("defineManifest gives TypeScript authoring ergonomics and keeps Zod payload schemas as runtime contracts", () => {
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
			{
				id: "start",
				target: { kind: "ticket", action: "implement" },
				input: artifacts.object({ pullRequest: artifacts.pullRequest() }),
			},
		],
	});

	assert.deepEqual(validateManifest(manifest), []);
	assert.equal(typeof manifest.kinds[0]?.transitions[0]?.event, "string");
	assert.equal(manifest.commands[0]?.input instanceof z.ZodType, true);
	assert.deepEqual(
		manifest.commands[0]?.input?.parse({
			pullRequest: " https://github.com/albizures/harness/pull/52 ",
		}),
		{ pullRequest: "https://github.com/albizures/harness/pull/52" },
	);
});

test("public Zod authoring helpers declare and validate artifact payload schemas", () => {
	const zodOutput = artifacts.object({
		url: artifacts.url(),
		file: artifacts.file(),
		issue: artifacts.issue(),
		pullRequest: artifacts.pullRequest(),
		gitRef: artifacts.gitRef(),
		inlineMarkdown: artifacts.inlineMarkdown(),
		handoff: artifacts.handoff(),
		finding: artifacts.finding(),
	});
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "artifact-payloads" },
		vocabulary: {
			states: ["ready"],
			actions: ["implement"],
			reasons: [],
			events: ["succeed"],
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
				transitions: [],
			},
		],
		commands: [
			{
				id: "complete",
				target: { kind: "ticket", action: "implement" },
				output: zodOutput,
			},
		],
	});

	assert.deepEqual(validateManifest(manifest), []);
	assert.equal(manifest.commands[0]?.output, zodOutput);

	const representativeValues = {
		url: "https://example.com/spec",
		file: "docs/spec.md",
		issue: "https://github.com/albizures/harness/issues/51",
		pullRequest: "https://github.com/albizures/harness/pull/52",
		gitRef: "feature/awf-artifacts",
		inlineMarkdown: "# Summary\n\nReady.",
		handoff: "Next agent should run the focused tests.",
		finding: "Missing coverage for invalid declarations.",
	};
	assert.equal(
		artifacts
			.object({ issue: artifacts.issue() })
			.safeParse({ issue: representativeValues.issue }).success,
		true,
	);
	assert.deepEqual(zodOutput.parse(representativeValues), representativeValues);

	const invalid = zodOutput.safeParse({
		...representativeValues,
		url: "ftp://example.com/spec",
		file: "/tmp/spec.md",
		issue: "not-an-issue",
		pullRequest: "https://github.com/albizures/harness/issues/51",
		gitRef: "bad ref",
		inlineMarkdown: "",
		handoff: "",
		finding: "",
	});
	const invalidArtifactReferenceCount =
		Object.keys(representativeValues).length;
	assert.equal(invalid.success, false);
	assert.equal(invalid.error.issues.length, invalidArtifactReferenceCount);
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
	assert.match(messages, /Payload schema must be a Zod schema/);
	assert.match(messages, /Relationship target/);
	assert.match(messages, /projection type/);
});
