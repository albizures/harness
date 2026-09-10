import { expect, it } from "vitest";
import { execute } from "../support/execute.ts";
import type { Tracker } from "../../src/ports/tracker.ts";
import { createInMemoryTracker } from "../../src/adapters/trackers/memory.ts";
import { agentDevelopmentManifest } from "../../src/workflows/agent-development/index.ts";

const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;
const prArtifact = (n: number) => ({ type: "pull-request", url: pr(n) });
const findingArtifact = (ref: string) => ({ type: "finding", ref });
const integrationImplementationPrNumber = 6;
const integrationSpecPrNumber = 3;

async function start(tracker: Tracker, id: string): Promise<void> {
	const issue = await tracker.getIssue(id);
	const envelope = await execute([issue.workflow.kind, "start", id], {
		tracker,
		manifest: agentDevelopmentManifest,
	});
	expect(envelope.ok).toBe(true);
}

async function terminal(
	tracker: Tracker,
	event: "succeed" | "fail",
	id: string,
	_input: Record<string, unknown>,
) {
	const issue = await tracker.getIssue(id);
	const envelope = await execute([issue.workflow.kind, event, id], {
		tracker,
		manifest: agentDevelopmentManifest,
	});
	expect(envelope.ok).toBe(true);
	return envelope;
}

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: T }).data;
}

it("should ensure that bundled Ticket workflow progresses through implementation review and merge", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	await start(tracker, "t");
	await terminal(tracker, "succeed", "t", {
		implementationPr: prArtifact(1),
	});
	await start(tracker, "t");
	await terminal(tracker, "succeed", "t", {
		verdict: "approved",
	});
	await start(tracker, "t");
	await terminal(tracker, "succeed", "t", {
		merged: true,
	});

	const issue = await tracker.getIssue("t");
	expect({
		state: issue.workflow.state,
		action: issue.workflow.action,
	}).toEqual({ state: "done", action: "none" });
	expect(issue).not.toHaveProperty("artifacts");
});

it("should ensure that bundled Ticket changes-requested review returns to fix and review", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	await start(tracker, "t");
	await terminal(tracker, "succeed", "t", {
		implementationPr: prArtifact(2),
	});
	await start(tracker, "t");
	await terminal(tracker, "fail", "t", {
		verdict: "changes-requested",
		findings: [findingArtifact("missing test")],
	});
	expect((await tracker.getIssue("t")).workflow.action).toBe("fix");
	await start(tracker, "t");
	await terminal(tracker, "succeed", "t", {
		summary: "added test",
	});
	expect((await tracker.getIssue("t")).workflow.action).toBe("review");
});

it("should ensure that bundled Spec workflow waits for child Tickets before integration and merge", async () => {
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
	await start(tracker, ticketId);
	await terminal(tracker, "succeed", ticketId, {
		implementationPr: prArtifact(integrationImplementationPrNumber),
	});
	await start(tracker, ticketId);
	await terminal(tracker, "succeed", ticketId, {
		verdict: "approved",
	});
	await start(tracker, ticketId);
	await terminal(tracker, "succeed", ticketId, {
		merged: true,
	});

	const readyForIntegration = await tracker.getIssue("s");
	expect({
		state: readyForIntegration.workflow.state,
		action: readyForIntegration.workflow.action,
	}).toEqual({ state: "ready", action: "integration-test" });

	await start(tracker, "s");
	await terminal(tracker, "succeed", "s", {
		verdict: "passed",
		specPr: prArtifact(integrationSpecPrNumber),
	});
	expect((await tracker.getIssue("s")).workflow.action).toBe("merge");
	await start(tracker, "s");
	await terminal(tracker, "succeed", "s", {
		merged: true,
	});
	const doneSpec = await tracker.getIssue("s");
	expect({
		state: doneSpec.workflow.state,
		action: doneSpec.workflow.action,
	}).toEqual({ state: "done", action: "none" });
});

it("should ensure that bundled agent-development help exposes manifest lifecycle routing without pause and respond", async () => {
	const envelope = await execute(["--help"], {
		manifest: agentDevelopmentManifest,
	});

	const help = assertSuccess<{
		commands: Array<{ name: string; usage: string }>;
	}>(envelope);
	expect(help.commands).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "ticket start",
				usage: "awf ticket start <issue>",
			}),
			expect.objectContaining({
				name: "ticket fail",
				usage: "awf ticket fail <issue>",
			}),
			expect.objectContaining({
				name: "ticket recover",
				usage: "awf ticket recover <issue>",
			}),
		]),
	);
	expect(help.commands.map((command) => command.name)).not.toContain(
		"ticket pause",
	);
	expect(help.commands.map((command) => command.name)).not.toContain(
		"ticket respond",
	);
});

it("should ensure that bundled Ticket lifecycle commands route through manifest transitions and write plain text logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const started = assertSuccess<{ log: { message: string } }>(
		await execute(["ticket", "start", "t"], {
			tracker,
			manifest: agentDevelopmentManifest,
		}),
	);
	expect(started.log).toMatchObject({ message: "Applied start." });

	const failed = assertSuccess<{ log: { message: string } }>(
		await execute(["ticket", "fail", "t"], {
			tracker,
			manifest: agentDevelopmentManifest,
		}),
	);
	expect(failed.log.message).toBe("Applied fail.");
	expect((await tracker.getIssue("t")).workflow).toMatchObject({
		state: "ready",
		action: "implement",
	});
});

it("should ensure that bundled Ticket manual escalation and recovery are explicit manifest transitions", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "t",
				title: "T",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	assertSuccess(
		await execute(["ticket", "start", "t"], {
			tracker,
			manifest: agentDevelopmentManifest,
		}),
	);
	await execute(["ticket", "escalate", "t"], {
		tracker,
		manifest: agentDevelopmentManifest,
	});
	expect((await tracker.getIssue("t")).workflow).toMatchObject({
		state: "need-human",
		action: "none",
		reason: "implement",
	});

	await execute(["ticket", "recover", "t"], {
		tracker,
		manifest: agentDevelopmentManifest,
	});
	expect((await tracker.getIssue("t")).workflow).toMatchObject({
		state: "ready",
		action: "implement",
	});
});

it("should ensure that bundled Spec integration changes-needed returns to planning", async () => {
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

	await start(tracker, "s");
	await terminal(tracker, "fail", "s", {
		verdict: "changes-needed",
		findings: [findingArtifact("split ticket")],
	});
	const issue = await tracker.getIssue("s");
	expect({
		state: issue.workflow.state,
		action: issue.workflow.action,
	}).toEqual({ state: "ready", action: "plan" });
});
