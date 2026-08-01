import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./commands.ts";
import { createInMemoryTracker, type Tracker } from "./tracker.ts";

const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;

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
		implementationPr: pr(1),
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
		implementationPr: pr(2),
	});
	await terminal(tracker, "fail", "t", await start(tracker, "t"), {
		verdict: "changes-requested",
		findings: ["missing test"],
	});
	assert.equal((await tracker.getIssue("t")).workflow.action, "fix");
	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		summary: "added test",
	});
	assert.equal((await tracker.getIssue("t")).workflow.action, "review");
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
		specPr: pr(specPrNumber),
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
		findings: ["split ticket"],
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
	const envelope = await execute(
		["succeed", "t", "--run", "r", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: `  ${pr(parsedPrNumber)}  ` }),
		},
	);

	assert.equal(envelope.ok, true);
	assert.deepEqual(
		(await tracker.getIssue("t")).artifacts.map((artifact) => artifact.uri),
		[pr(parsedPrNumber)],
	);
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
			stdin: JSON.stringify({ implementationPr: pr(replacementPrNumber) }),
		},
	);
	assert.equal(replacement.ok, false);
	assert.equal(
		replacement.ok ? undefined : replacement.error.code,
		"INVALID_ACTION_INPUT",
	);
});
