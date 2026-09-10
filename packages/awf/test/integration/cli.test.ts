import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const cliPath = new URL("../../src/cli.ts", import.meta.url);
const validManifestPath = new URL(
	"../fixtures/valid.workflow.ts",
	import.meta.url,
).pathname;
const badManifestPath = new URL("../fixtures/bad.workflow.ts", import.meta.url)
	.pathname;
const linkManifestPath = new URL(
	"../fixtures/link.workflow.ts",
	import.meta.url,
).pathname;
const envMemoryWorkflowPath = new URL(
	"../fixtures/env-memory.workflow.ts",
	import.meta.url,
).pathname;
const missingManifestPath = new URL(
	"../fixtures/missing-manifest.workflow.ts",
	import.meta.url,
).pathname;
const agentWorkflowSourcePath = new URL(
	"../../src/workflows/agent-workflow/index.ts",
	import.meta.url,
).pathname;
const memoryTrackerSourcePath = new URL(
	"../../src/adapters/trackers/memory.ts",
	import.meta.url,
).pathname;
const filesystemTrackerSourcePath = new URL(
	"../../src/adapters/trackers/filesystem.ts",
	import.meta.url,
).pathname;

const unreadableMode = 0o000;
const ownerReadWriteMode = 0o600;
const bundledGoldenSmokeTimeoutMs = 15_000;
const configLifecycleHandlerPrNumber = 42;

const prArtifact = (n: number) => ({
	type: "pull-request",
	url: `https://github.com/albizures/harness/pull/${n}`,
});

function serializeCliSmokeInput(input: unknown): string {
	return typeof input === "string" ? input : JSON.stringify(input);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "awf-cli-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function configWithMemoryIssue(id: string): string {
	return `import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker({ issues: [{
	id: ${JSON.stringify(id)},
	title: "Configured task",
	labels: [
		"awf:agent-workflow:kind:task",
		"awf:agent-workflow:state:ready",
		"awf:agent-workflow:action:work",
	],
}] });
`;
}

it("should ensure that CLI writes plain text to stdout by default", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", validManifestPath, "--help"],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("awf - Agent workflow CLI.");
	expect(result.stdout).toContain(
		"awf workflow describe  Describe the loaded workflow manifest.",
	);
	expect(result.stdout).toContain("Use --json for machine-readable output.");
});

it("should ensure that CLI writes bundled workflow descriptions as Markdown text by default", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", validManifestPath, "workflow", "describe"],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("# Workflow agent-workflow");
	expect(result.stdout).toContain(
		"- States: ready, running, in-discussion, done, need-human, waiting-human",
	);
	expect(result.stdout).toContain(
		"- Actions: planning, work, discuss, integration-test, merge, none",
	);
	expect(result.stdout).toContain("- Per workflow: 4");
	expect(result.stdout).toContain("- Per kind task: 3");
	expect(result.stdout).toContain("- spec (Spec)");
	expect(result.stdout).toContain("- task (Task)");
	expect(result.stdout).toContain("- wayfinder (Wayfinder)");
	expect(result.stdout).toContain("- grilling (Grilling)");
	expect(result.stdout).toContain(
		"- task-create\n  - Usage: awf create task --input <file|->\n  - Target: task/work\n  - Input: required",
	);
	expect(result.stdout).toContain(
		"  - children where spec/ready/integration-test; children all task/done/none, min 1, gate tasks-done",
	);
	expect(result.stdout).toContain(
		"  - parent child task/done/none; parent spec/ready/none; siblings all task/done; to ready/integration-test",
	);
	expect(result.stdout).toContain(
		"- task-generated-by-task: task -> task (generated-by)",
	);
	expect(result.stdout).toContain("## Scope notes");
	expect(result.stdout).not.toContain("agent-development");
	expect(result.stdout).not.toContain("_def");
	expect(result.stdout).not.toContain("reservedPrefix");
	expect(result.stdout).not.toContain("typeName");
});

it("should ensure that CLI writes bundled workflow description DTOs in JSON envelopes", () => {
	const result = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			validManifestPath,
			"workflow",
			"describe",
		],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(true);
	expect(envelope.data).not.toEqual(expect.any(String));
	expect(envelope.data).toMatchObject({
		version: "v1",
		workflow: { id: "agent-workflow", version: "1.0.0" },
		concurrency: { perIssue: 1, perWorkflow: 4, perKind: { task: 3 } },
		vocabulary: {
			states: [
				"ready",
				"running",
				"in-discussion",
				"done",
				"need-human",
				"waiting-human",
			],
			actions: [
				"planning",
				"work",
				"discuss",
				"integration-test",
				"merge",
				"none",
			],
			events: [
				"start",
				"succeed",
				"fail",
				"recover",
				"escalate",
				"pause",
				"resume",
			],
		},
		readiness: {
			filters: [
				{ kind: "spec", state: "ready", action: "planning" },
				{ kind: "spec", state: "ready", action: "integration-test" },
				{ kind: "spec", state: "ready", action: "merge" },
				{ kind: "task", state: "ready", action: "work" },
			],
		},
		relationships: expect.arrayContaining([
			{
				id: "spec-task",
				from: "spec",
				to: "task",
				projection: { type: "parent-child" },
			},
			{
				id: "task-generated-by-task",
				from: "task",
				to: "task",
				projection: { type: "generated-by" },
			},
		]),
	});
	expect(envelope.data.kinds.map((kind: { id: string }) => kind.id)).toEqual([
		"spec",
		"wayfinder",
		"task",
		"grilling",
	]);
	expect(
		envelope.data.commands.filter(
			(command: { cli?: unknown }) => command.cli !== undefined,
		),
	).toEqual(
		expect.arrayContaining([
			{
				id: "spec-create",
				cli: {
					verb: "create",
					target: "spec",
					usage: "awf create spec --input <file|->",
				},
				target: { kind: "spec", action: "planning" },
				input: { required: true },
			},
			{
				id: "task-create",
				cli: {
					verb: "create",
					target: "task",
					usage: "awf create task --input <file|->",
				},
				target: { kind: "task", action: "work" },
				input: { required: true },
			},
			expect.objectContaining({
				id: "task-start",
				cli: expect.objectContaining({ usage: "awf task start <issue>" }),
				transition: { event: "start", attempt: "start" },
			}),
		]),
	);
	const serialized = JSON.stringify(envelope.data);
	expect(serialized).not.toContain("agent-development");
	expect(serialized).not.toContain("_def");
	expect(serialized).not.toContain("reservedPrefix");
	expect(serialized).not.toContain("typeName");
});

it("should ensure that CLI workflow describe uses the no-config agent-workflow default", async () => {
	await withTempDir(async (dir) => {
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "workflow", "describe"],
			{ cwd: dir, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data.workflow.id).toBe("agent-workflow");
		expect(envelope.data.kinds.map((kind: { id: string }) => kind.id)).toEqual([
			"spec",
			"wayfinder",
			"task",
			"grilling",
		]);
	});
});

it("should ensure that CLI workflow describe accepts no extra arguments", () => {
	const result = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			validManifestPath,
			"workflow",
			"describe",
			"extra",
		],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(1);
	const envelope = JSON.parse(result.stdout);
	expect(envelope.error).toEqual({
		code: "INVALID_ARGUMENTS",
		message: "Invalid command arguments.",
		details: { usage: "awf workflow describe" },
	});
});

it("should ensure that CLI writes JSON envelopes to stdout with --json", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", validManifestPath, "--help"],
		{
			encoding: "utf8",
		},
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(true);
	expect(envelope.data.name).toBe("awf");
});

it("should ensure that CLI discovers only ./awf.config.ts from the current working directory", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "awf.config.ts"), configWithMemoryIssue("91"));
		const discovered = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "ready"],
			{
				cwd: dir,
				encoding: "utf8",
			},
		);

		expect(discovered.status).toBe(0);
		expect(
			JSON.parse(discovered.stdout).data.items.map(
				(item: { id: string }) => item.id,
			),
		).toEqual(["91"]);

		const child = join(dir, "child");
		await mkdir(child);
		const notDiscoveredFromParent = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "ready"],
			{ cwd: child, encoding: "utf8" },
		);

		expect(notDiscoveredFromParent.status).toBe(0);
		const envelope = JSON.parse(notDiscoveredFromParent.stdout);
		expect(envelope.data.items).toEqual([]);
	});
});

it("should ensure that CLI global --config loads a workflow module before command execution", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(configPath, configWithMemoryIssue("92"));
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "--config", configPath, "ready"],
			{ cwd: dir, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(
			JSON.parse(result.stdout).data.items.map(
				(item: { id: string }) => item.id,
			),
		).toEqual(["92"]);
	});
});

it("should ensure that CLI without a workflow config defaults to the bundled agent-workflow manifest", async () => {
	await withTempDir(async (dir) => {
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "create", "spec", "--input", "-"],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({ title: "No default", body: "# No default\n" }),
			},
		);

		expect(created.status).toBe(0);
		const envelope = JSON.parse(created.stdout);
		expect(envelope.data.issue.workflow).toMatchObject({
			kind: "spec",
			state: "ready",
			action: "planning",
		});
	});
});

it("should ensure that CLI config-exported command handlers can customize bundled agent-workflow command ids", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};

export const manifest = agentWorkflowManifest;
export const commandHandlers = {
	"task-create": async ({ input, command }) => ({
		command: command.id,
		title: input.title,
		handled: true,
	}),
};
`,
		);

		const result = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--json",
				"--config",
				configPath,
				"create",
				"task",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					parent: "1",
					title: "Configured task",
					description: "Handle through config.",
					profile: "engineering",
				}),
			},
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			ok: true,
			data: { command: "task-create", title: "Configured task", handled: true },
		});
	});
});

it("should ensure that CLI config-exported lifecycle handlers can customize bundled agent-workflow transition keys", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker({
	issues: [{
		id: "task-1",
		title: "Task",
		workflow: {
			kind: "task",
			state: "running",
			action: "work",
		},
	}],
});

export const lifecycleHandlers = {
	"task:running/work:succeed": () => undefined,
};
`,
		);

		const result = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--json",
				"--config",
				configPath,
				"run-command",
				"succeed",
				"task-1",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					implementationPr: prArtifact(configLifecycleHandlerPrNumber),
				}),
			},
		);

		expect(result.status).toBe(0);
		expect(
			JSON.parse(JSON.parse(result.stdout).data.log.message),
		).toMatchObject({
			input: { implementationPr: prArtifact(configLifecycleHandlerPrNumber) },
		});
	});
});

it("should ensure that CLI config that omits tracker uses the default filesystem tracker", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "awf.config.ts"),
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
export const manifest = agentWorkflowManifest;
`,
		);
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "create", "spec", "--input", "-"],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					title: "Manifest-only config",
					body: "# Spec",
				}),
			},
		);

		expect(created.status).toBe(0);
		const trackerState = JSON.parse(
			await readFile(join(dir, ".awf", "tracker.json"), "utf8"),
		);
		expect(trackerState.issues[0].title).toBe("Manifest-only config");
	});
});

it(
	"should ensure that CLI config default filesystem tracker keeps workflow state across separate processes",
	async () => {
		await withTempDir(async (dir) => {
			await writeFile(
				join(dir, "awf.config.ts"),
				`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
export const manifest = agentWorkflowManifest;
`,
			);
			const runCli = (args: Array<string>, input?: unknown) => {
				const result = spawnSync(
					process.execPath,
					[cliPath.pathname, "--json", ...args],
					{
						cwd: dir,
						encoding: "utf8",
						input:
							input === undefined ? undefined : serializeCliSmokeInput(input),
					},
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
				return envelope.data;
			};

			const spec = runCli(["create", "spec", "--input", "-"], {
				title: "Durable spec",
				body: "# Durable spec\n",
			}).issue;
			expect(spec.id).toBe("1");
			expect(
				runCli(["ready"]).items.map((item: { id: string }) => item.id),
			).toEqual(["1"]);
			expect(runCli(["get", spec.id]).issue.title).toBe("Durable spec");

			const task = runCli(["create", "task", "--input", "-"], {
				parent: spec.id,
				title: "Durable task",
				description: "Do it.",
				profile: "engineering",
			});
			const taskId = task.issue.id;
			expect(
				runCli(["ready"]).items.map((item: { id: string }) => item.id),
			).toEqual(["1", taskId]);
			expect(runCli(["get", taskId]).issue.relationships.parent).toBe(spec.id);
			expect(
				runCli(["logs", spec.id]).logs.map((log: { type: string }) => log.type),
			).toEqual(["spec-create_created"]);

			runCli(["run-command", "start", taskId]);
			const failed = runCli(["run-command", "fail", taskId, "--input", "-"], {
				reason: "transient",
			});
			expect({
				state: failed.issue.workflow.state,
				action: failed.issue.workflow.action,
			}).toEqual({ state: "need-human", action: "none" });

			const recovered = runCli([
				"run-command",
				"resume",
				taskId,
				"--action",
				"work",
			]);
			expect({
				state: recovered.issue.workflow.state,
				action: recovered.issue.workflow.action,
			}).toEqual({ state: "ready", action: "work" });
			expect(
				runCli(["logs", taskId]).logs.map((log: { type: string }) => log.type),
			).toEqual([
				"task-create_created",
				"action_started",
				"action_failed",
				"action_resumed",
			]);
		});
	},
	bundledGoldenSmokeTimeoutMs,
);

it("should ensure that CLI uses an explicit config-exported filesystem tracker across processes", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: "./custom-tracker.json" });
`,
		);
		const create = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--json",
				"--config",
				configPath,
				"create",
				"spec",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({ title: "Config tracker", body: "# Spec" }),
			},
		);
		expect(create.status).toBe(0);
		const createdId = JSON.parse(create.stdout).data.issue.id;

		const get = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "--config", configPath, "get", createdId],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(get.status).toBe(0);
		expect(JSON.parse(get.stdout).data.issue.title).toBe("Config tracker");
		const trackerState = JSON.parse(
			await readFile(join(dir, "custom-tracker.json"), "utf8"),
		);
		expect(trackerState.issues[0].id).toBe(createdId);
	});
});

it("should ensure that CLI returns clear failure envelopes for explicit bad config paths", async () => {
	const missing = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", "./missing.workflow.ts", "ready"],
		{ encoding: "utf8" },
	);
	expect(missing.status).toBe(1);
	expect(JSON.parse(missing.stdout).error.code).toBe("CONFIG_LOAD_FAILED");

	const invalid = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", badManifestPath, "ready"],
		{ encoding: "utf8" },
	);
	expect(invalid.status).toBe(1);
	expect(JSON.parse(invalid.stdout).error.code).toBe("CONFIG_LOAD_FAILED");

	const manifestless = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", missingManifestPath, "ready"],
		{ encoding: "utf8" },
	);
	expect(manifestless.status).toBe(1);
	const envelope = JSON.parse(manifestless.stdout);
	expect(envelope.error.code).toBe("CONFIG_LOAD_FAILED");
	expect(envelope.error.message).toMatch(/manifest/);

	await withTempDir(async (dir) => {
		const unreadablePath = join(dir, "unreadable.workflow.ts");
		await writeFile(unreadablePath, configWithMemoryIssue("93"));
		await chmod(unreadablePath, unreadableMode);
		try {
			const unreadable = spawnSync(
				process.execPath,
				[cliPath.pathname, "--json", "--config", unreadablePath, "ready"],
				{ encoding: "utf8" },
			);
			expect(unreadable.status).toBe(1);
			expect(JSON.parse(unreadable.stdout).error.code).toBe(
				"CONFIG_LOAD_FAILED",
			);
		} finally {
			await chmod(unreadablePath, ownerReadWriteMode);
		}
	});
});

it("should ensure that CLI smoke path loads a fixture manifest and returns a JSON success envelope", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "manifest", "validate", validManifestPath],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		ok: true,
		data: {
			manifest: "agent-workflow",
			version: "v1",
			kinds: ["spec", "wayfinder", "task", "grilling"],
		},
	});
});

it("should ensure that CLI returns a stable validation error envelope for a generic link projection", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "manifest", "validate", linkManifestPath],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(false);
	expect(envelope.error.code).toBe("MANIFEST_VALIDATION_FAILED");
	expect(envelope.error.details.issues.at(-1).path).toBe(
		"$.relationships[7].projection.type",
	);
	expect(envelope.error.details.issues.at(-1).message).toMatch(
		/parent-child, dependency, or generated-by/,
	);
});

it("should ensure that CLI returns a stable validation error envelope for a bad manifest", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "manifest", "validate", badManifestPath],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(false);
	expect(envelope.error.code).toBe("MANIFEST_VALIDATION_FAILED");
	expect(JSON.stringify(envelope.error.details.issues)).toMatch(/wildcard/);
});

it("should ensure that CLI smoke path seeds multiple in-memory issues and returns only legally executable ready items", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", envMemoryWorkflowPath, "ready"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "1",
						title: "Ready ticket",
						labels: [
							"awf:agent-workflow:kind:task",
							"awf:agent-workflow:state:ready",
							"awf:agent-workflow:action:work",
						],
					},
					{
						id: "2",
						title: "Dependency blocked ticket",
						labels: [
							"awf:agent-workflow:kind:task",
							"awf:agent-workflow:state:ready",
							"awf:agent-workflow:action:work",
						],
						relationships: { dependencies: ["1"] },
					},
					{
						id: "3",
						title: "Running ticket",
						workflow: {
							kind: "task",
							state: "running",
							action: "work",
						},
					},
				]),
			},
		},
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(
		JSON.parse(result.stdout).data.items.map((item: { id: string }) => item.id),
	).toEqual(["1"]);
});

it("should ensure that CLI smoke path does not report compatibility run ids", () => {
	const issues = [
		{
			id: "42",
			title: "Drifted lifecycle",
			workflow: { kind: "task", state: "running", action: "work" },
			logs: [
				{
					sequence: 1,
					issueId: "42",
					type: "action_started",
				},
			],
		},
	];
	const env = { ...process.env, AWF_MEMORY_ISSUES: JSON.stringify(issues) };

	const before = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"succeed",
			"42",
			"--input",
			"-",
		],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: prArtifact(1),
			}),
			env,
		},
	);
	expect(before.status).toBe(0);

	const diagnosed = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"reconcile",
			"42",
		],
		{
			encoding: "utf8",
			env,
		},
	);
	expect(diagnosed.status).toBe(0);
	expect(JSON.parse(diagnosed.stdout).data).toMatchObject({
		status: "clean",
		diagnostics: [],
	});

	const applied = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"reconcile",
			"42",
			"--apply",
		],
		{ encoding: "utf8", env },
	);
	expect(applied.status).toBe(0);
	const repairedIssue = JSON.parse(applied.stdout).data.issue;

	const after = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"succeed",
			"42",
			"--input",
			"-",
		],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: prArtifact(1),
			}),
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{ ...repairedIssue, logs: issues[0].logs },
				]),
			},
		},
	);
	expect(after.status).toBe(0);
});

it("should ensure that CLI smoke path starts and succeeds a workflow action with logs oldest-first", () => {
	const started = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"start",
			"42",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						labels: [
							"awf:agent-workflow:kind:task",
							"awf:agent-workflow:state:ready",
							"awf:agent-workflow:action:work",
						],
					},
				]),
			},
		},
	);

	expect(started.status).toBe(0);
	expect(started.stderr).toBe("");
	const startEnvelope = JSON.parse(started.stdout);
	expect(startEnvelope.ok).toBe(true);
	const succeeded = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"succeed",
			"42",
			"--input",
			"-",
		],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: prArtifact(1),
			}),
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						workflow: {
							kind: "task",
							state: "running",
							action: "work",
						},
						logs: [startEnvelope.data.log],
					},
				]),
			},
		},
	);

	expect(succeeded.status).toBe(0);
	expect(succeeded.stderr).toBe("");
	const succeedEnvelope = JSON.parse(succeeded.stdout);
	expect(succeedEnvelope.ok).toBe(true);
	const logged = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"logs",
			"42",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						workflow: {
							kind: "task",
							state: "ready",
							action: "none",
						},
						logs: [startEnvelope.data.log, succeedEnvelope.data.log],
					},
				]),
			},
		},
	);

	expect(logged.status).toBe(0);
	expect(logged.stderr).toBe("");
	const logsEnvelope = JSON.parse(logged.stdout);
	expect(logsEnvelope.ok).toBe(true);
	expect(
		logsEnvelope.data.logs.map((log: { type: string }) => log.type),
	).toEqual(["action_started", "action_succeeded"]);
});

it("should ensure that CLI writes plain text errors to stdout and exits non-zero by default", () => {
	const result = spawnSync(process.execPath, [cliPath.pathname, "unknown"], {
		encoding: "utf8",
	});

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("Error UNKNOWN_COMMAND: Unknown command.");
});

it("should ensure that CLI writes error envelopes to stdout and exits non-zero with --json", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "unknown"],
		{
			encoding: "utf8",
		},
	);

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "unknown" },
		},
	});
});
