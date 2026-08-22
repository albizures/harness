import { expect, test } from "vitest";
import { execute } from "../../src/commands.ts";
import type { Tracker } from "../../src/tracker.ts";
import { createInMemoryTracker } from "../../src/trackers/memory.ts";
import { agentDevelopmentManifest } from "../../src/workflows/agent-development/index.ts";

const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;
const prArtifact = (n: number) => ({ type: "pull-request", url: pr(n) });
const findingArtifact = (ref: string) => ({ type: "finding", ref });
const integrationImplementationPrNumber = 6;
const integrationSpecPrNumber = 3;

async function start(tracker: Tracker, id: string): Promise<string> {
	const envelope = await execute(["start", id], {
		tracker,
		manifest: agentDevelopmentManifest,
	});
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: { run: { id: string } } }).data.run.id;
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
		manifest: agentDevelopmentManifest,
		stdin: JSON.stringify(input),
	});
	expect(envelope.ok).toBe(true);
	return envelope;
}

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: T }).data;
}

test("bundled Ticket workflow progresses through implementation review and merge", async () => {
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
	expect({
		state: issue.workflow.state,
		action: issue.workflow.action,
	}).toEqual({ state: "done", action: "none" });
	expect(issue.artifacts.map((artifact) => artifact.uri)).toEqual([pr(1)]);
});

test("bundled Ticket changes-requested review returns to fix and review", async () => {
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
	expect((await tracker.getIssue("t")).workflow.action).toBe("fix");
	await terminal(tracker, "succeed", "t", await start(tracker, "t"), {
		summary: "added test",
	});
	expect((await tracker.getIssue("t")).workflow.action).toBe("review");
});

test("bundled Spec workflow waits for child Tickets before integration and merge", async () => {
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
			manifest: agentDevelopmentManifest,
			stdin: JSON.stringify({
				tickets: [{ key: "one", title: "One", content: "Do one thing." }],
			}),
		}),
	);
	expect({
		state: applied.spec.workflow.state,
		action: applied.spec.workflow.action,
	}).toEqual({ state: "ready", action: "none" });

	const ticketId = applied.tickets[0]?.id;
	expect(typeof ticketId).toBe("string");
	await terminal(tracker, "succeed", ticketId, await start(tracker, ticketId), {
		implementationPr: prArtifact(integrationImplementationPrNumber),
	});
	await terminal(tracker, "succeed", ticketId, await start(tracker, ticketId), {
		verdict: "approved",
	});
	await terminal(tracker, "succeed", ticketId, await start(tracker, ticketId), {
		merged: true,
	});

	const readyForIntegration = await tracker.getIssue("s");
	expect({
		state: readyForIntegration.workflow.state,
		action: readyForIntegration.workflow.action,
	}).toEqual({ state: "ready", action: "integration-test" });

	await terminal(tracker, "succeed", "s", await start(tracker, "s"), {
		verdict: "passed",
		specPr: prArtifact(integrationSpecPrNumber),
	});
	expect((await tracker.getIssue("s")).workflow.action).toBe("merge");
	await terminal(tracker, "succeed", "s", await start(tracker, "s"), {
		merged: true,
	});
	const doneSpec = await tracker.getIssue("s");
	expect({
		state: doneSpec.workflow.state,
		action: doneSpec.workflow.action,
	}).toEqual({ state: "done", action: "none" });
});

test("bundled Spec integration changes-needed returns to planning", async () => {
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
	expect({
		state: issue.workflow.state,
		action: issue.workflow.action,
	}).toEqual({ state: "ready", action: "plan" });
});
