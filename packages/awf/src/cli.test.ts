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
const linkManifestPath = new URL("./fixtures/link.workflow.ts", import.meta.url)
	.pathname;

function serializeCliSmokeInput(input: unknown): string {
	return typeof input === "string" ? input : JSON.stringify(input);
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
	const result = spawnSync(process.execPath, [cliPath.pathname, "ready"], {
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
	});

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
		[cliPath.pathname, "succeed", "42", "--run", "run-42", "--input", "-"],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
			}),
			env,
		},
	);
	assert.equal(before.status, 1);
	assert.equal(JSON.parse(before.stdout).error.code, "RUN_MISMATCH");

	const diagnosed = spawnSync(
		process.execPath,
		[cliPath.pathname, "reconcile", "42"],
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
		[cliPath.pathname, "reconcile", "42", "--apply"],
		{ encoding: "utf8", env },
	);
	assert.equal(applied.status, 0);
	const repairedIssue = JSON.parse(applied.stdout).data.issue;
	assert.equal(repairedIssue.workflow.activeRunId, "run-42");

	const after = spawnSync(
		process.execPath,
		[cliPath.pathname, "succeed", "42", "--run", "run-42", "--input", "-"],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
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
		[cliPath.pathname, "start", "42"],
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
		[cliPath.pathname, "succeed", "42", "--run", runId, "--input", "-"],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: "https://github.com/albizures/harness/pull/1",
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
						state: "ready",
						action: "review",
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

test("CLI smoke path drives one tiny Spec with one Ticket to Spec done", () => {
	const runCli = (
		args: Array<string>,
		issues: Array<unknown>,
		input?: unknown,
	) => {
		const stdin =
			input === undefined ? undefined : serializeCliSmokeInput(input);
		const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
			encoding: "utf8",
			input: stdin,
			env: { ...process.env, AWF_MEMORY_ISSUES: JSON.stringify(issues) },
		});
		assert.equal(result.status, 0, result.stdout || result.stderr);
		assert.equal(result.stderr, "");
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.ok, true, result.stdout);
		return envelope.data;
	};

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
		{ implementationPr: "https://github.com/albizures/harness/pull/39" },
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
			specPr: "https://github.com/albizures/harness/pull/40",
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
