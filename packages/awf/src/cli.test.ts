import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cliPath = new URL("./cli.ts", import.meta.url);
const validManifestPath = new URL(
	"./fixtures/valid.workflow.ts",
	import.meta.url,
).pathname;
const badManifestPath = new URL("./fixtures/bad.workflow.ts", import.meta.url)
	.pathname;

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
	const result = spawnSync(process.execPath, [cliPath.pathname, "ready"], {
		encoding: "utf8",
		env: {
			...process.env,
			AWF_MEMORY_ISSUES: JSON.stringify([
				{
					id: "1",
					title: "Ready ticket",
					labels: ["type:ticket", "state:ready", "action:implement"],
				},
				{
					id: "2",
					title: "Dependency blocked ticket",
					labels: ["type:ticket", "state:ready", "action:implement"],
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
	});

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.deepEqual(
		JSON.parse(result.stdout).data.items.map((item: { id: string }) => item.id),
		["1"],
	);
});

test("CLI smoke path starts and succeeds a workflow run with logs oldest-first", () => {
	const started = spawnSync(
		process.execPath,
		[cliPath.pathname, "start", "42"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						labels: ["type:ticket", "state:ready", "action:implement"],
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
		[cliPath.pathname, "succeed", "42", "--run", runId],
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
	const logged = spawnSync(process.execPath, [cliPath.pathname, "logs", "42"], {
		encoding: "utf8",
		env: {
			...process.env,
			AWF_MEMORY_ISSUES: JSON.stringify([
				{
					id: "42",
					title: "Implement lifecycle",
					workflow: {
						kind: "ticket",
						state: "done",
						action: "none",
					},
					logs: [startEnvelope.data.log, succeedEnvelope.data.log],
				},
			]),
		},
	});

	assert.equal(logged.status, 0);
	assert.equal(logged.stderr, "");
	const logsEnvelope = JSON.parse(logged.stdout);
	assert.equal(logsEnvelope.ok, true);
	assert.deepEqual(
		logsEnvelope.data.logs.map((log: { type: string }) => log.type),
		["action_started", "action_succeeded"],
	);
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
