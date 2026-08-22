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
const agentDevelopmentWorkflowSourcePath = new URL(
	"../../src/workflows/agent-development/index.ts",
	import.meta.url,
).pathname;
const manifestSourcePath = new URL("../../src/manifest.ts", import.meta.url)
	.pathname;
const memoryTrackerSourcePath = new URL(
	"../../src/trackers/memory.ts",
	import.meta.url,
).pathname;
const filesystemTrackerSourcePath = new URL(
	"../../src/trackers/filesystem.ts",
	import.meta.url,
).pathname;

const unreadableMode = 0o000;
const ownerReadWriteMode = 0o600;
const durableImplementationPrNumber = 93;
const bundledGoldenSmokeTimeoutMs = 15_000;

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
	return `import { agentDevelopmentManifest } from ${JSON.stringify(agentDevelopmentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentDevelopmentManifest;
export const tracker = createInMemoryTracker({ issues: [{
	id: ${JSON.stringify(id)},
	title: "Configured ticket",
	labels: [
		"awf:agent-development:kind:ticket",
		"awf:agent-development:state:ready",
		"awf:agent-development:action:implement",
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
	expect(result.stdout).toContain("Use --json for machine-readable output.");
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

		expect(notDiscoveredFromParent.status).toBe(1);
		const envelope = JSON.parse(notDiscoveredFromParent.stdout);
		expect(envelope.error.code).toBe("CONFIG_LOAD_FAILED");
		expect(envelope.error.message).toMatch(/explicit workflow config/);
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

it("should ensure that CLI without a workflow config fails instead of defaulting to the bundled manifest", async () => {
	await withTempDir(async (dir) => {
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "create", "spec", "--input", "-"],
			{ cwd: dir, encoding: "utf8", input: "# No default\n" },
		);

		expect(created.status).toBe(1);
		const envelope = JSON.parse(created.stdout);
		expect(envelope.error.code).toBe("CONFIG_LOAD_FAILED");
		expect(envelope.error.message).toMatch(/explicit workflow config/);
	});
});

it("should ensure that CLI config-exported command handlers are invoked by manifest command id", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { z } from "zod";
import { defineManifest } from ${JSON.stringify(manifestSourcePath)};

export const manifest = defineManifest({
	version: "v1",
	workflow: { id: "cli-handler" },
	vocabulary: { states: ["ready"], actions: ["draft"], events: ["saved"] },
	concurrency: { perIssue: 1 },
	kinds: [{
		id: "item",
		label: "Item",
		initial: { state: "ready", action: "draft" },
		transitions: [],
	}],
	commands: [{
		id: "memo-create",
		cli: { verb: "create", target: "memo" },
		target: { kind: "item", action: "draft" },
		input: z.strictObject({ title: z.string() }),
		output: z.strictObject({ title: z.string(), handled: z.literal(true) }),
	}],
});

export const commandHandlers = {
	"memo-create": async ({ input }) => ({ title: input.title, handled: true }),
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
				"memo",
				"--input",
				"-",
			],
			{ cwd: dir, encoding: "utf8", input: JSON.stringify({ title: "Note" }) },
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			ok: true,
			data: { title: "Note", handled: true },
		});
	});
});

it("should ensure that CLI config-exported lifecycle handlers are invoked by transition key", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { z } from "zod";
import { defineManifest } from ${JSON.stringify(manifestSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = defineManifest({
	version: "v1",
	workflow: { id: "cli-lifecycle-handler" },
	vocabulary: { states: ["running", "done"], actions: ["publish", "none"], events: ["succeed"] },
	concurrency: { perIssue: 1 },
	kinds: [{
		id: "article",
		label: "Article",
		initial: { state: "running", action: "publish" },
		transitions: [{
			from: { state: "running", action: "publish" },
			event: "succeed",
			input: z.strictObject({ summary: z.string() }),
			to: { state: "done", action: "none" },
		}],
	}],
	commands: [],
});

export const tracker = createInMemoryTracker({
	issues: [{
		id: "article-1",
		title: "Article",
		workflow: {
			kind: "article",
			state: "running",
			action: "publish",
			activeRunId: "run-1",
		},
	}],
});

export const lifecycleHandlers = {
	"article:running/publish:succeed": ({ input }) => ({
		log: { summary: input.summary, external: true },
		artifacts: [{ kind: "inline", uri: "handler:summary", name: "Handler summary" }],
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
				"succeed",
				"article-1",
				"--run",
				"run-1",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({ summary: "Published externally" }),
			},
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).data.log.payload).toMatchObject({
			summary: "Published externally",
			external: true,
		});
	});
});

it("should ensure that CLI config that omits tracker uses the default filesystem tracker", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "awf.config.ts"),
			`import { agentDevelopmentManifest } from ${JSON.stringify(agentDevelopmentWorkflowSourcePath)};
export const manifest = agentDevelopmentManifest;
`,
		);
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "create", "spec", "--input", "-"],
			{ cwd: dir, encoding: "utf8", input: "# Manifest-only config\n" },
		);

		expect(created.status).toBe(0);
		const trackerState = JSON.parse(
			await readFile(join(dir, ".awf", "tracker.json"), "utf8"),
		);
		expect(trackerState.issues[0].title).toBe("Manifest-only config");
	});
});

it("should ensure that CLI config default filesystem tracker keeps workflow state across separate processes", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "awf.config.ts"),
			`import { agentDevelopmentManifest } from ${JSON.stringify(agentDevelopmentWorkflowSourcePath)};
export const manifest = agentDevelopmentManifest;
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

		const spec = runCli(
			["create", "spec", "--input", "-"],
			"# Durable spec\n",
		).issue;
		expect(spec.id).toBe("1");
		expect(
			runCli(["ready"]).items.map((item: { id: string }) => item.id),
		).toEqual(["1"]);
		expect(runCli(["get", spec.id]).issue.title).toBe("Durable spec");

		const planned = runCli(["apply", "plan", spec.id, "--input", "-"], {
			tickets: [{ key: "one", title: "Durable ticket", content: "Do it." }],
		});
		const ticketId = planned.tickets[0].id;
		expect(
			runCli(["ready"]).items.map((item: { id: string }) => item.id),
		).toEqual([ticketId]);
		expect(runCli(["get", ticketId]).issue.relationships.parent).toBe(spec.id);
		expect(
			runCli(["logs", spec.id]).logs.map((log: { type: string }) => log.type),
		).toEqual(["spec_created", "plan_applied"]);

		const started = runCli(["start", ticketId]);
		expect(runCli(["ready"]).items).toEqual([]);
		const failed = runCli(
			["fail", ticketId, "--run", started.run.id, "--input", "-"],
			{ reason: "transient" },
		);
		expect({
			state: failed.issue.workflow.state,
			action: failed.issue.workflow.action,
		}).toEqual({ state: "ready", action: "implement" });

		const restarted = runCli(["start", ticketId]);
		const implemented = runCli(
			["succeed", ticketId, "--run", restarted.run.id, "--input", "-"],
			{ implementationPr: prArtifact(durableImplementationPrNumber) },
		);
		expect({
			state: implemented.issue.workflow.state,
			action: implemented.issue.workflow.action,
		}).toEqual({ state: "ready", action: "review" });
		const escalated = runCli(["escalate", ticketId, "--input", "-"], {
			reason: "needs decision",
		});
		expect({
			state: escalated.issue.workflow.state,
			action: escalated.issue.workflow.action,
		}).toEqual({ state: "need-human", action: "none" });
		const resumed = runCli(["resume", ticketId, "--action", "fix"]);
		expect({
			state: resumed.issue.workflow.state,
			action: resumed.issue.workflow.action,
		}).toEqual({ state: "ready", action: "fix" });
		expect(
			runCli(["logs", ticketId]).logs.map((log: { type: string }) => log.type),
		).toEqual([
			"action_started",
			"action_failed",
			"action_started",
			"action_succeeded",
			"human_intervention_needed",
			"action_resumed",
		]);
	});
}, bundledGoldenSmokeTimeoutMs);

it("should ensure that CLI uses an explicit config-exported filesystem tracker across processes", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentDevelopmentManifest } from ${JSON.stringify(agentDevelopmentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentDevelopmentManifest;
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
			{ cwd: dir, encoding: "utf8", input: "# Config tracker\n" },
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
			manifest: "agent-development",
			version: "v1",
			kinds: ["spec", "ticket"],
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
		"$.relationships[2].projection.type",
	);
	expect(envelope.error.details.issues.at(-1).message).toMatch(
		/parent-child or dependency/,
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
							"awf:agent-development:kind:ticket",
							"awf:agent-development:state:ready",
							"awf:agent-development:action:implement",
						],
					},
					{
						id: "2",
						title: "Dependency blocked ticket",
						labels: [
							"awf:agent-development:kind:ticket",
							"awf:agent-development:state:ready",
							"awf:agent-development:action:implement",
						],
						relationships: { dependencies: ["1"] },
					},
					{
						id: "3",
						title: "Running ticket",
						workflow: {
							kind: "ticket",
							state: "running",
							action: "implement",
							activeRunId: "run-3",
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

it("should ensure that CLI smoke path reconciles a corrupt in-memory issue before normal commands resume", () => {
	const issues = [
		{
			id: "42",
			title: "Drifted lifecycle",
			workflow: { kind: "ticket", state: "running", action: "implement" },
			logs: [
				{
					sequence: 1,
					issueId: "42",
					type: "action_started",
					runId: "run-42",
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
			"succeed",
			"42",
			"--run",
			"run-42",
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
	expect(before.status).toBe(1);
	expect(JSON.parse(before.stdout).error.code).toBe("RUN_MISMATCH");

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
	expect(JSON.parse(diagnosed.stdout).data.diagnostics[0].code).toBe(
		"MISSING_ACTIVE_RUN",
	);

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
	expect(repairedIssue.workflow.activeRunId).toBe("run-42");

	const after = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"succeed",
			"42",
			"--run",
			"run-42",
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
	expect(JSON.parse(after.stdout).ok).toBe(true);
});

it("should ensure that CLI smoke path starts and succeeds a workflow run with logs oldest-first", () => {
	const started = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
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
							"awf:agent-development:kind:ticket",
							"awf:agent-development:state:ready",
							"awf:agent-development:action:implement",
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
	const runId = startEnvelope.data.run.id;
	const succeeded = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"succeed",
			"42",
			"--run",
			runId,
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
							kind: "ticket",
							state: "running",
							action: "implement",
							activeRunId: runId,
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
							kind: "ticket",
							state: "ready",
							action: "review",
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

it(
	"should ensure that CLI smoke path drives one tiny Spec with one Ticket to Spec done",
	() => {
		const runCli = (
			args: Array<string>,
			issues: Array<unknown>,
			input?: unknown,
		) => {
			const stdin =
				input === undefined ? undefined : serializeCliSmokeInput(input);
			const result = spawnSync(
				process.execPath,
				[
					cliPath.pathname,
					"--json",
					"--config",
					envMemoryWorkflowPath,
					...args,
				],
				{
					encoding: "utf8",
					input: stdin,
					env: { ...process.env, AWF_MEMORY_ISSUES: JSON.stringify(issues) },
				},
			);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.ok).toBe(true);
			return envelope.data;
		};

		const implementationPrNumber = 39;
		const specPrNumber = 40;

		const created = runCli(
			["create", "spec", "--input", "-"],
			[],
			"# Tiny spec\n",
		);
		const planned = runCli(
			["apply", "plan", created.issue.id, "--input", "-"],
			[created.issue],
			{ tickets: [{ key: "one", title: "One", content: "Do one thing." }] },
		);
		const specAfterPlan = planned.spec;
		const ticket = {
			id: planned.tickets[0].id,
			title: "One",
			body: "Do one thing.",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
			relationships: { parent: specAfterPlan.id },
		};

		let started = runCli(["start", ticket.id], [specAfterPlan, ticket]);
		let completed = runCli(
			["succeed", ticket.id, "--run", started.run.id, "--input", "-"],
			[
				specAfterPlan,
				{ ...ticket, workflow: started.issue.workflow, logs: [started.log] },
			],
			{ implementationPr: prArtifact(implementationPrNumber) },
		);
		let ticketIssue = completed.issue;
		let ticketLogs = [started.log, completed.log];

		started = runCli(
			["start", ticket.id],
			[specAfterPlan, { ...ticketIssue, logs: ticketLogs }],
		);
		completed = runCli(
			["succeed", ticket.id, "--run", started.run.id, "--input", "-"],
			[
				specAfterPlan,
				{
					...ticketIssue,
					workflow: started.issue.workflow,
					logs: [...ticketLogs, started.log],
				},
			],
			{ verdict: "approved" },
		);
		ticketIssue = completed.issue;
		ticketLogs = [...ticketLogs, started.log, completed.log];

		started = runCli(
			["start", ticket.id],
			[specAfterPlan, { ...ticketIssue, logs: ticketLogs }],
		);
		completed = runCli(
			["succeed", ticket.id, "--run", started.run.id, "--input", "-"],
			[
				specAfterPlan,
				{
					...ticketIssue,
					workflow: started.issue.workflow,
					logs: [...ticketLogs, started.log],
				},
			],
			{ merged: true },
		);
		ticketIssue = completed.issue;
		expect(ticketIssue.workflow.state).toBe("done");
		const specReadyForIntegration = {
			...specAfterPlan,
			workflow: { ...specAfterPlan.workflow, action: "integration-test" },
		};

		started = runCli(
			["start", specAfterPlan.id],
			[specReadyForIntegration, ticketIssue],
		);
		completed = runCli(
			["succeed", specAfterPlan.id, "--run", started.run.id, "--input", "-"],
			[
				{
					...specReadyForIntegration,
					workflow: started.issue.workflow,
					logs: [started.log],
				},
				ticketIssue,
			],
			{
				verdict: "passed",
				specPr: prArtifact(specPrNumber),
			},
		);
		let specIssue = completed.issue;
		const specLogs = [started.log, completed.log];

		started = runCli(
			["start", specIssue.id],
			[{ ...specIssue, logs: specLogs }, ticketIssue],
		);
		completed = runCli(
			["succeed", specIssue.id, "--run", started.run.id, "--input", "-"],
			[
				{
					...specIssue,
					workflow: started.issue.workflow,
					logs: [...specLogs, started.log],
				},
				ticketIssue,
			],
			{ merged: true },
		);
		specIssue = completed.issue;
		expect(specIssue.workflow.state).toBe("done");
		expect(specIssue.workflow.action).toBe("none");
	},
	bundledGoldenSmokeTimeoutMs,
);

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
