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
import { assert, test } from "vitest";

const cliPath = new URL("./cli.ts", import.meta.url);
const validManifestPath = new URL(
	"./fixtures/valid.workflow.ts",
	import.meta.url,
).pathname;
const badManifestPath = new URL("./fixtures/bad.workflow.ts", import.meta.url)
	.pathname;
const linkManifestPath = new URL("./fixtures/link.workflow.ts", import.meta.url)
	.pathname;
const envMemoryWorkflowPath = new URL(
	"./fixtures/env-memory.workflow.ts",
	import.meta.url,
).pathname;
const missingManifestPath = new URL(
	"./fixtures/missing-manifest.workflow.ts",
	import.meta.url,
).pathname;
const defaultManifestSourcePath = new URL(
	"./default-manifest.ts",
	import.meta.url,
).pathname;
const memoryTrackerSourcePath = new URL("./trackers/memory.ts", import.meta.url)
	.pathname;
const filesystemTrackerSourcePath = new URL(
	"./trackers/filesystem.ts",
	import.meta.url,
).pathname;

const unreadableMode = 0o000;
const ownerReadWriteMode = 0o600;
const durableImplementationPrNumber = 93;

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
	return `import { defaultManifest } from ${JSON.stringify(defaultManifestSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = defaultManifest;
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

test("CLI writes success envelopes to stdout", () => {
	const result = spawnSync(process.execPath, [cliPath.pathname, "--help"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, true);
	assert.equal(envelope.data.name, "awf");
});

test("CLI discovers only ./awf.config.ts from the current working directory", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "awf.config.ts"), configWithMemoryIssue("91"));
		const discovered = spawnSync(
			process.execPath,
			[cliPath.pathname, "ready"],
			{
				cwd: dir,
				encoding: "utf8",
			},
		);

		assert.equal(discovered.status, 0, discovered.stdout || discovered.stderr);
		assert.deepEqual(
			JSON.parse(discovered.stdout).data.items.map(
				(item: { id: string }) => item.id,
			),
			["91"],
		);

		const child = join(dir, "child");
		await mkdir(child);
		const notDiscoveredFromParent = spawnSync(
			process.execPath,
			[cliPath.pathname, "ready"],
			{ cwd: child, encoding: "utf8" },
		);

		assert.equal(notDiscoveredFromParent.status, 0);
		assert.deepEqual(JSON.parse(notDiscoveredFromParent.stdout).data.items, []);
	});
});

test("CLI global --config loads a workflow module before command execution", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(configPath, configWithMemoryIssue("92"));
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--config", configPath, "ready"],
			{ cwd: dir, encoding: "utf8" },
		);

		assert.equal(result.status, 0, result.stdout || result.stderr);
		assert.deepEqual(
			JSON.parse(result.stdout).data.items.map(
				(item: { id: string }) => item.id,
			),
			["92"],
		);
	});
});

test("CLI defaults to the bundled manifest and ./.awf/tracker.json", async () => {
	await withTempDir(async (dir) => {
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "create", "spec", "--input", "-"],
			{ cwd: dir, encoding: "utf8", input: "# Durable default\n" },
		);

		assert.equal(created.status, 0, created.stdout || created.stderr);
		const trackerState = JSON.parse(
			await readFile(join(dir, ".awf", "tracker.json"), "utf8"),
		);
		assert.equal(trackerState.issues[0].title, "Durable default");
	});
});

test("CLI config that omits tracker uses the default filesystem tracker", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "awf.config.ts"),
			`import { defaultManifest } from ${JSON.stringify(defaultManifestSourcePath)};
export const manifest = defaultManifest;
`,
		);
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "create", "spec", "--input", "-"],
			{ cwd: dir, encoding: "utf8", input: "# Manifest-only config\n" },
		);

		assert.equal(created.status, 0, created.stdout || created.stderr);
		const trackerState = JSON.parse(
			await readFile(join(dir, ".awf", "tracker.json"), "utf8"),
		);
		assert.equal(trackerState.issues[0].title, "Manifest-only config");
	});
});

test("CLI default filesystem tracker keeps workflow state across separate processes", async () => {
	await withTempDir(async (dir) => {
		const runCli = (args: Array<string>, input?: unknown) => {
			const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
				cwd: dir,
				encoding: "utf8",
				input: input === undefined ? undefined : serializeCliSmokeInput(input),
			});
			assert.equal(result.status, 0, result.stdout || result.stderr);
			assert.equal(result.stderr, "");
			const envelope = JSON.parse(result.stdout);
			assert.equal(envelope.ok, true, result.stdout);
			return envelope.data;
		};

		const spec = runCli(
			["create", "spec", "--input", "-"],
			"# Durable spec\n",
		).issue;
		assert.equal(spec.id, "1");
		assert.deepEqual(
			runCli(["ready"]).items.map((item: { id: string }) => item.id),
			["1"],
		);
		assert.equal(runCli(["get", spec.id]).issue.title, "Durable spec");

		const planned = runCli(["apply", "plan", spec.id, "--input", "-"], {
			tickets: [{ key: "one", title: "Durable ticket", content: "Do it." }],
		});
		const ticketId = planned.tickets[0].id;
		assert.deepEqual(
			runCli(["ready"]).items.map((item: { id: string }) => item.id),
			[ticketId],
		);
		assert.equal(runCli(["get", ticketId]).issue.relationships.parent, spec.id);
		assert.deepEqual(
			runCli(["logs", spec.id]).logs.map((log: { type: string }) => log.type),
			["spec_created", "plan_applied"],
		);

		const started = runCli(["start", ticketId]);
		assert.deepEqual(runCli(["ready"]).items, []);
		const failed = runCli(
			["fail", ticketId, "--run", started.run.id, "--input", "-"],
			{ reason: "transient" },
		);
		assert.deepEqual(
			{
				state: failed.issue.workflow.state,
				action: failed.issue.workflow.action,
			},
			{ state: "ready", action: "implement" },
		);

		const restarted = runCli(["start", ticketId]);
		const implemented = runCli(
			["succeed", ticketId, "--run", restarted.run.id, "--input", "-"],
			{ implementationPr: prArtifact(durableImplementationPrNumber) },
		);
		assert.deepEqual(
			{
				state: implemented.issue.workflow.state,
				action: implemented.issue.workflow.action,
			},
			{ state: "ready", action: "review" },
		);
		const escalated = runCli(["escalate", ticketId, "--input", "-"], {
			reason: "needs decision",
		});
		assert.deepEqual(
			{
				state: escalated.issue.workflow.state,
				action: escalated.issue.workflow.action,
			},
			{ state: "need-human", action: "none" },
		);
		const resumed = runCli(["resume", ticketId, "--action", "fix"]);
		assert.deepEqual(
			{
				state: resumed.issue.workflow.state,
				action: resumed.issue.workflow.action,
			},
			{ state: "ready", action: "fix" },
		);
		assert.deepEqual(
			runCli(["logs", ticketId]).logs.map((log: { type: string }) => log.type),
			[
				"action_started",
				"action_failed",
				"action_started",
				"action_succeeded",
				"human_intervention_needed",
				"action_resumed",
			],
		);
	});
});

test("CLI uses an explicit config-exported filesystem tracker across processes", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { defaultManifest } from ${JSON.stringify(defaultManifestSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = defaultManifest;
export const tracker = createFileSystemTracker({ path: "./custom-tracker.json" });
`,
		);
		const create = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--config",
				configPath,
				"create",
				"spec",
				"--input",
				"-",
			],
			{ cwd: dir, encoding: "utf8", input: "# Config tracker\n" },
		);
		assert.equal(create.status, 0, create.stdout || create.stderr);
		const createdId = JSON.parse(create.stdout).data.issue.id;

		const get = spawnSync(
			process.execPath,
			[cliPath.pathname, "--config", configPath, "get", createdId],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.equal(get.status, 0, get.stdout || get.stderr);
		assert.equal(JSON.parse(get.stdout).data.issue.title, "Config tracker");
		const trackerState = JSON.parse(
			await readFile(join(dir, "custom-tracker.json"), "utf8"),
		);
		assert.equal(trackerState.issues[0].id, createdId);
	});
});

test("CLI returns clear failure envelopes for explicit bad config paths", async () => {
	const missing = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", "./missing.workflow.ts", "ready"],
		{ encoding: "utf8" },
	);
	assert.equal(missing.status, 1);
	assert.equal(JSON.parse(missing.stdout).error.code, "CONFIG_LOAD_FAILED");

	const invalid = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", badManifestPath, "ready"],
		{ encoding: "utf8" },
	);
	assert.equal(invalid.status, 1);
	assert.equal(JSON.parse(invalid.stdout).error.code, "CONFIG_LOAD_FAILED");

	const manifestless = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", missingManifestPath, "ready"],
		{ encoding: "utf8" },
	);
	assert.equal(manifestless.status, 1);
	const envelope = JSON.parse(manifestless.stdout);
	assert.equal(envelope.error.code, "CONFIG_LOAD_FAILED");
	assert.match(envelope.error.message, /manifest/);

	await withTempDir(async (dir) => {
		const unreadablePath = join(dir, "unreadable.workflow.ts");
		await writeFile(unreadablePath, configWithMemoryIssue("93"));
		await chmod(unreadablePath, unreadableMode);
		try {
			const unreadable = spawnSync(
				process.execPath,
				[cliPath.pathname, "--config", unreadablePath, "ready"],
				{ encoding: "utf8" },
			);
			assert.equal(unreadable.status, 1);
			assert.equal(
				JSON.parse(unreadable.stdout).error.code,
				"CONFIG_LOAD_FAILED",
			);
		} finally {
			await chmod(unreadablePath, ownerReadWriteMode);
		}
	});
});

test("CLI smoke path loads a fixture manifest and returns a JSON success envelope", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "manifest", "validate", validManifestPath],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		ok: true,
		data: {
			manifest: "agent-development",
			version: "v1",
			kinds: ["spec", "ticket"],
		},
	});
});

test("CLI returns a stable validation error envelope for a generic link projection", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "manifest", "validate", linkManifestPath],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, "MANIFEST_VALIDATION_FAILED");
	assert.equal(
		envelope.error.details.issues.at(-1).path,
		"$.relationships[2].projection.type",
	);
	assert.match(
		envelope.error.details.issues.at(-1).message,
		/parent-child or dependency/,
	);
});

test("CLI returns a stable validation error envelope for a bad manifest", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "manifest", "validate", badManifestPath],
		{ encoding: "utf8" },
	);

	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, "MANIFEST_VALIDATION_FAILED");
	assert.match(JSON.stringify(envelope.error.details.issues), /wildcard/);
});

test("CLI smoke path seeds multiple in-memory issues and returns only legally executable ready items", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", envMemoryWorkflowPath, "ready"],
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

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.deepEqual(
		JSON.parse(result.stdout).data.items.map((item: { id: string }) => item.id),
		["1"],
	);
});

test("CLI smoke path reconciles a corrupt in-memory issue before normal commands resume", () => {
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
	assert.equal(before.status, 1);
	assert.equal(JSON.parse(before.stdout).error.code, "RUN_MISMATCH");

	const diagnosed = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", envMemoryWorkflowPath, "reconcile", "42"],
		{
			encoding: "utf8",
			env,
		},
	);
	assert.equal(diagnosed.status, 0);
	assert.equal(
		JSON.parse(diagnosed.stdout).data.diagnostics[0].code,
		"MISSING_ACTIVE_RUN",
	);

	const applied = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--config",
			envMemoryWorkflowPath,
			"reconcile",
			"42",
			"--apply",
		],
		{ encoding: "utf8", env },
	);
	assert.equal(applied.status, 0);
	const repairedIssue = JSON.parse(applied.stdout).data.issue;
	assert.equal(repairedIssue.workflow.activeRunId, "run-42");

	const after = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
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
	assert.equal(after.status, 0, after.stdout || after.stderr);
	assert.equal(JSON.parse(after.stdout).ok, true);
});

test("CLI smoke path starts and succeeds a workflow run with logs oldest-first", () => {
	const started = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", envMemoryWorkflowPath, "start", "42"],
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

	assert.equal(started.status, 0);
	assert.equal(started.stderr, "");
	const startEnvelope = JSON.parse(started.stdout);
	assert.equal(startEnvelope.ok, true);
	const runId = startEnvelope.data.run.id;
	const succeeded = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
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

	assert.equal(succeeded.status, 0);
	assert.equal(succeeded.stderr, "");
	const succeedEnvelope = JSON.parse(succeeded.stdout);
	assert.equal(succeedEnvelope.ok, true);
	const logged = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", envMemoryWorkflowPath, "logs", "42"],
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

	assert.equal(logged.status, 0);
	assert.equal(logged.stderr, "");
	const logsEnvelope = JSON.parse(logged.stdout);
	assert.equal(logsEnvelope.ok, true);
	assert.deepEqual(
		logsEnvelope.data.logs.map((log: { type: string }) => log.type),
		["action_started", "action_succeeded"],
	);
});

test("CLI smoke path drives one tiny Spec with one Ticket to Spec done", () => {
	const runCli = (
		args: Array<string>,
		issues: Array<unknown>,
		input?: unknown,
	) => {
		const stdin =
			input === undefined ? undefined : serializeCliSmokeInput(input);
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--config", envMemoryWorkflowPath, ...args],
			{
				encoding: "utf8",
				input: stdin,
				env: { ...process.env, AWF_MEMORY_ISSUES: JSON.stringify(issues) },
			},
		);
		assert.equal(result.status, 0, result.stdout || result.stderr);
		assert.equal(result.stderr, "");
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.ok, true, result.stdout);
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
	assert.equal(ticketIssue.workflow.state, "done");
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
	assert.equal(specIssue.workflow.state, "done");
	assert.equal(specIssue.workflow.action, "none");
});

test("CLI writes error envelopes to stdout and exits non-zero", () => {
	const result = spawnSync(process.execPath, [cliPath.pathname, "unknown"], {
		encoding: "utf8",
	});

	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "unknown" },
		},
	});
});
