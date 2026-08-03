import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./commands.ts";
import type { Tracker } from "./tracker.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;
const prArtifact = (n: number) => ({ type: "pull-request", url: pr(n) });
const findingArtifact = (ref: string) => ({ type: "finding", ref });

async function start(tracker: Tracker, id: string): Promise<string> {
	const envelope = await execute(["start", id], { tracker });
	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected start success");
	}
	return (envelope.data as { run: { id: string } }).run.id;
}

async function terminal(
	tracker: Tracker,
	event: "succeed" | "fail",
	id: string,
	run: string,
	input: Record<string, unknown>,
) {
	const envelope = await execute([event, id, "--run", run, "--input", "-"], {
		tracker,
		stdin: JSON.stringify(input),
	});
	assert.equal(envelope.ok, true);
	return envelope;
}

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	return envelope.data as T;
}

test("Ticket approved review path merges exactly one implementation PR to done", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		implementationPr: prArtifact(1),
	});
	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		verdict: "approved",
	});
	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		merged: true,
	});

	const issue = await tracker.getIssue("t");
	assert.equal(issue.workflow.state, "done");
	assert.equal(issue.workflow.action, "none");
	assert.deepEqual(
		issue.artifacts.map((artifact) => artifact.uri),
		[pr(1)],
	);
});

test("Ticket changes-requested path goes through fix and back to review", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		implementationPr: prArtifact(2),
	});
	await terminal(tracker, "fail", "t", await start(tracker, "t"), {
		verdict: "changes-requested",
		findings: [findingArtifact("missing test")],
	});
	assert.equal((await tracker.getIssue("t")).workflow.action, "fix");
	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		summary: "added test",
	});
	assert.equal((await tracker.getIssue("t")).workflow.action, "review");
});

test("dependency-gated Tickets stay ready/implement while omitted from executable ready results", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "blocker",
				title: "Open blocker",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
			{
				id: "blocked",
				title: "Blocked ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});
	await tracker.addDependency("blocked", "blocker");

	const ready = assertSuccess<{
		items: Array<{ id: string }>;
		blocked: Array<{
			id: string;
			workflow: { state: string; action: string };
			blocking: Array<{ gate: string; blockedBy: Array<{ id: string }> }>;
		}>;
	}>(await execute(["ready"], { tracker }));

	assert.deepEqual(
		ready.items.map((item) => item.id),
		["blocker"],
	);
	assert.deepEqual(ready.blocked, [
		{
			id: "blocked",
			title: "Blocked ticket",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
			blocking: [
				{
					gate: "dependency",
					blockedBy: [
						{
							id: "blocker",
							title: "Open blocker",
							workflow: { kind: "ticket", state: "ready", action: "review" },
						},
					],
				},
			],
		},
	]);
	assert.deepEqual(
		{
			state: (await tracker.getIssue("blocked")).workflow.state,
			action: (await tracker.getIssue("blocked")).workflow.action,
		},
		{ state: "ready", action: "implement" },
	);
});

test("Spec post-plan waits as ready/none and later progresses to ready/integration-test", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "s",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});

	const applied = assertSuccess<{
		spec: { id: string; workflow: { state: string; action: string } };
		tickets: Array<{ id: string; key: string }>;
	}>(
		await execute(["apply", "plan", "s", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				tickets: [{ key: "one", title: "One", content: "Do one thing." }],
			}),
		}),
	);

	assert.deepEqual(
		{
			state: applied.spec.workflow.state,
			action: applied.spec.workflow.action,
		},
		{ state: "ready", action: "none" },
	);
	assert.deepEqual(
		(await tracker.readLogs("s")).map((log) => log.type),
		["plan_applied"],
	);
	const waitingReady = assertSuccess<{ items: Array<{ id: string }> }>(
		await execute(["ready"], { tracker }),
	);
	assert.deepEqual(
		waitingReady.items.map((item) => item.id),
		[applied.tickets[0]?.id],
	);

	const ticketId = applied.tickets[0]?.id;
	assert.equal(typeof ticketId, "string");
	const implementationPrNumber = 6;
	await terminal(tracker, "succeed", ticketId, await start(tracker, ticketId), {
		implementationPr: prArtifact(implementationPrNumber),
	});
	await terminal(tracker, "succeed", ticketId, await start(tracker, ticketId), {
		verdict: "approved",
	});
	await terminal(tracker, "succeed", ticketId, await start(tracker, ticketId), {
		merged: true,
	});

	const spec = await tracker.getIssue("s");
	assert.deepEqual(
		{ state: spec.workflow.state, action: spec.workflow.action },
		{ state: "ready", action: "integration-test" },
	);
	const integrationReady = assertSuccess<{ items: Array<{ id: string }> }>(
		await execute(["ready"], { tracker }),
	);
	assert.deepEqual(
		integrationReady.items.map((item) => item.id),
		["s"],
	);
});

test("default retry, explicit escalation, and explicit resume expose workflow logs and messages", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "retry",
				title: "Retry ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-retry",
				},
			},
			{
				id: "human",
				title: "Needs decision",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const failed = assertSuccess<{
		issue: { workflow: { state: string; action: string; reason?: string } };
	}>(
		await execute(["fail", "retry", "--run", "run-retry", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ reason: "temporary CI failure" }),
		}),
	);
	assert.deepEqual(
		{
			state: failed.issue.workflow.state,
			action: failed.issue.workflow.action,
			reason: failed.issue.workflow.reason,
		},
		{ state: "ready", action: "implement", reason: undefined },
	);
	assert.deepEqual((await tracker.readLogs("retry"))[0]?.payload, {
		event: "fail",
		input: { reason: "temporary CI failure" },
		to: { state: "ready", action: "implement" },
	});

	const invalidResume = await execute(["resume", "retry", "--action", "fix"], {
		tracker,
	});
	assert.equal(invalidResume.ok, false);
	assert.deepEqual(invalidResume.ok ? undefined : invalidResume.error, {
		code: "INVALID_TRANSITION",
		message:
			"No manifest transition matches the current workflow fields for this event.",
		details: { id: "retry", event: "resume" },
	});

	await assertSuccess(
		await execute(["escalate", "human", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ reason: "needs product decision" }),
		}),
	);
	assert.deepEqual(
		{
			state: (await tracker.getIssue("human")).workflow.state,
			action: (await tracker.getIssue("human")).workflow.action,
		},
		{ state: "need-human", action: "none" },
	);
	assert.deepEqual((await tracker.readLogs("human"))[0]?.payload, {
		event: "escalate",
		input: { reason: "needs product decision" },
		from: { state: "ready", action: "review" },
		to: { state: "need-human", action: "none" },
	});

	const resumed = assertSuccess<{
		issue: { workflow: { state: string; action: string } };
	}>(await execute(["resume", "human", "--action", "fix"], { tracker }));
	assert.deepEqual(
		{
			state: resumed.issue.workflow.state,
			action: resumed.issue.workflow.action,
		},
		{ state: "ready", action: "fix" },
	);
	assert.deepEqual(
		(await tracker.readLogs("human")).map((log) => log.type),
		["human_intervention_needed", "action_resumed"],
	);
	assert.deepEqual((await tracker.readLogs("human"))[1]?.payload, {
		event: "resume",
		to: { state: "ready", action: "fix" },
	});
});

test("Spec becomes ready for integration only after all child Tickets are done", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "s",
				title: "S",
				workflow: { kind: "spec", state: "ready", action: "none" },
				relationships: { children: ["done", "last"] },
			},
			{
				id: "done",
				title: "Done",
				workflow: { kind: "ticket", state: "done", action: "none" },
				relationships: { parent: "s" },
			},
			{
				id: "last",
				title: "Last",
				workflow: { kind: "ticket", state: "ready", action: "merge" },
				relationships: { parent: "s" },
			},
		],
	});

	assert.deepEqual((await tracker.getIssue("s")).workflow.action, "none");

	await terminal(tracker, "succeed", "last", await start(tracker, "last"), {
		merged: true,
	});

	const spec = await tracker.getIssue("s");
	assert.equal(spec.workflow.state, "ready");
	assert.equal(spec.workflow.action, "integration-test");
});

test("Spec integration passed path enables merge and merge completes the Spec", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "s",
				title: "S",
				workflow: { kind: "spec", state: "ready", action: "integration-test" },
				relationships: { children: ["t"] },
			},
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "done", action: "none" },
				relationships: { parent: "s" },
			},
		],
	});

	const ready = await execute(["ready"], { tracker });
	assert.equal(ready.ok, true);
	assert.deepEqual(
		(ready.data as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
		["s"],
	);
	const specPrNumber = 3;
	await terminal(tracker, "succeed", "s", await start(tracker, "s"), {
		verdict: "passed",
		specPr: prArtifact(specPrNumber),
	});
	assert.equal((await tracker.getIssue("s")).workflow.action, "merge");
	await terminal(tracker, "succeed", "s", await start(tracker, "s"), {
		merged: true,
	});
	assert.equal((await tracker.getIssue("s")).workflow.state, "done");
});

test("Spec integration changes-needed returns to ready plan", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "s",
				title: "S",
				workflow: { kind: "spec", state: "ready", action: "integration-test" },
				relationships: { children: ["t"] },
			},
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "done", action: "none" },
				relationships: { parent: "s" },
			},
		],
	});

	await terminal(tracker, "fail", "s", await start(tracker, "s"), {
		verdict: "changes-needed",
		findings: [findingArtifact("split ticket")],
	});
	const issue = await tracker.getIssue("s");
	assert.equal(issue.workflow.state, "ready");
	assert.equal(issue.workflow.action, "plan");
});

test("required action artifact validation rejects malformed JSON and PRs before tracker mutation", async () => {
	for (const [stdin, expectedIssues] of [
		["{not json", undefined],
		[
			JSON.stringify({ implementationPr: "not-a-pr" }),
			[
				{
					path: "$.implementationPr",
					message: "Invalid input: expected object, received string",
				},
			],
		],
		[
			JSON.stringify({
				implementationPr: {
					type: "pull-request",
					url: "https://github.com/albizures/harness/issues/51",
				},
			}),
			[
				{
					path: "$.implementationPr.url",
					message: "Pull request artifact must be a GitHub pull request URL.",
				},
			],
		],
	] as const) {
		const tracker = createInMemoryTracker({
			issues: [
				{
					id: "t",
					title: "T",
					workflow: {
						kind: "ticket",
						state: "running",
						action: "implement",
						activeRunId: "r",
					},
				},
			],
		});

		const malformed = await execute(
			["succeed", "t", "--run", "r", "--input", "-"],
			{ tracker, stdin },
		);
		assert.equal(malformed.ok, false);
		assert.equal(
			malformed.ok ? undefined : malformed.error.code,
			"INVALID_ACTION_INPUT",
		);
		if (expectedIssues !== undefined) {
			assert.deepEqual(malformed.ok ? undefined : malformed.error.details, {
				issues: expectedIssues,
			});
		}
		const workflow = (await tracker.getIssue("t")).workflow;
		assert.equal(workflow.kind, "ticket");
		assert.equal(workflow.state, "running");
		assert.equal(workflow.action, "implement");
		assert.equal(workflow.activeRunId, "r");
		assert.equal(workflow.version, 1);
		assert.deepEqual(await tracker.readLogs("t"), []);
		assert.deepEqual((await tracker.getIssue("t")).artifacts, []);
	}
});

test("terminal commands pass parsed artifact references into runtime behavior", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "r",
				},
			},
		],
	});

	const parsedPrNumber = 4;
	const structuredPr = {
		type: "pull-request",
		url: pr(parsedPrNumber),
		title: "Implementation PR",
		metadata: { repository: "albizures/harness" },
	};
	const envelope = await execute(
		["succeed", "t", "--run", "r", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: structuredPr }),
		},
	);

	assert.equal(envelope.ok, true);
	assert.deepEqual((await tracker.getIssue("t")).artifacts, [
		{
			id: "artifact-1",
			kind: "pull-request",
			uri: pr(parsedPrNumber),
			name: "Implementation PR",
			...structuredPr,
		},
	]);
});

test("required action artifact validation rejects replacement PRs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "r",
				},
			},
		],
	});

	const existingPrNumber = 4;
	const replacementPrNumber = 5;
	await tracker.registerArtifact("t", {
		kind: "pull-request",
		uri: pr(existingPrNumber),
	});
	const replacement = await execute(
		["succeed", "t", "--run", "r", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				implementationPr: {
					type: "pull-request",
					url: pr(replacementPrNumber),
				},
			}),
		},
	);
	assert.equal(replacement.ok, false);
	assert.equal(
		replacement.ok ? undefined : replacement.error.code,
		"INVALID_ACTION_INPUT",
	);
});
