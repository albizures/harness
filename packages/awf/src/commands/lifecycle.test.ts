import { expect, test } from "vitest";
import { execute } from "../commands.ts";
import { defaultManifest } from "../default-manifest.ts";
import { createInMemoryTracker } from "../trackers/memory.ts";

const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;
const prArtifact = (n: number) => ({ type: "pull-request", url: pr(n) });
const findingArtifact = (ref: string) => ({ type: "finding", ref });

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: T }).data;
}

test("start moves a ready issue to running, stores one active run, and appends an action_started log", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const envelope = await execute(["start", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: {
				issue: { workflow: { state: string; activeRunId: string } };
				run: { id: string };
			};
		}
	).data;
	expect(data.issue.workflow.state).toBe("running");
	expect(data.issue.workflow.activeRunId).toBe(data.run.id);
	const logs = await tracker.readLogs("123");
	expect(logs.map((log) => log.type)).toEqual(["action_started"]);
	expect(logs[0]?.runId).toBe(data.run.id);
});

test("succeed applies the manifest terminal transition for the active run", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		},
	);

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: {
				issue: {
					workflow: { state: string; action: string; activeRunId?: string };
				};
			};
		}
	).data;
	expect(data.issue.workflow.state).toBe("ready");
	expect(data.issue.workflow.action).toBe("review");
	expect(data.issue.workflow.activeRunId).toBe(undefined);
	expect((await tracker.readLogs("123")).map((log) => log.type)).toEqual([
		"action_succeeded",
	]);
});

test("failed running actions retry the same ready action by default", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Merge lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "merge",
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["fail", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				verdict: "changes-requested",
				findings: [findingArtifact("bug")],
			}),
		},
	);

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: {
				issue: { workflow: { state: string; action: string; reason?: string } };
			};
		}
	).data;
	expect({
		state: data.issue.workflow.state,
		action: data.issue.workflow.action,
		reason: data.issue.workflow.reason,
	}).toEqual({ state: "ready", action: "merge", reason: undefined });
	expect((await tracker.readLogs("123"))[0]?.payload).toEqual({
		event: "fail",
		input: { verdict: "changes-requested", findings: [findingArtifact("bug")] },
		to: { state: "ready", action: "merge" },
	});
});

test("explicit escalation moves work to need-human none and logs the reason", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Escalate lifecycle",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const envelope = await execute(["escalate", "123", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({ reason: "review requires product decision" }),
	});

	expect(envelope.ok).toBe(true);
	expect((await tracker.getIssue("123")).workflow.state).toBe("need-human");
	expect((await tracker.getIssue("123")).workflow.action).toBe("none");
	expect((await tracker.readLogs("123"))[0]?.payload).toEqual({
		event: "escalate",
		input: { reason: "review requires product decision" },
		from: { state: "ready", action: "review" },
		to: { state: "need-human", action: "none" },
	});
});

test("explicit resume chooses a valid next ready action", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Resume lifecycle",
				workflow: { kind: "ticket", state: "need-human", action: "none" },
			},
		],
	});

	const envelope = await execute(["resume", "123", "--action", "fix"], {
		tracker,
	});

	expect(envelope.ok).toBe(true);
	const issue = await tracker.getIssue("123");
	expect(issue.workflow.state).toBe("ready");
	expect(issue.workflow.action).toBe("fix");
});

test("manifest lifecycle policy constrains retry escalation and resume", async () => {
	const manifest = {
		...defaultManifest,
		lifecycle: {
			retry: { allow: [{ kind: "ticket", action: "implement" }] },
			escalation: { allow: [{ kind: "ticket", action: "implement" }] },
			resume: { allow: [{ kind: "ticket", actions: ["implement"] }] },
		},
	};
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Constrained",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "merge",
					activeRunId: "run-1",
				},
			},
			{
				id: "human",
				title: "Human",
				workflow: { kind: "ticket", state: "need-human", action: "none" },
			},
		],
	});

	expect(
		(
			await execute(["fail", "123", "--run", "run-1", "--input", "-"], {
				tracker,
				manifest,
				stdin: "{}",
			})
		).ok,
	).toBe(false);
	expect(
		(
			await execute(["escalate", "123", "--input", "-"], {
				tracker,
				manifest,
				stdin: JSON.stringify({ reason: "blocked" }),
			})
		).ok,
	).toBe(false);
	expect(
		(
			await execute(["resume", "human", "--action", "fix"], {
				tracker,
				manifest,
			})
		).ok,
	).toBe(false);
});

test("bundled workflow vocabulary and transitions do not include durable blocked", () => {
	expect(!defaultManifest.vocabulary.states.includes("blocked")).toBeTruthy();
	expect(
		defaultManifest.kinds.every((kind) =>
			kind.transitions.every(
				(transition) =>
					transition.from.state !== "blocked" &&
					transition.to.state !== "blocked",
			),
		),
	).toBeTruthy();
});

test("lifecycle commands reject invalid manifest transitions and run mismatches", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "done",
				title: "Done",
				workflow: { kind: "ticket", state: "done", action: "none" },
			},
			{
				id: "running",
				title: "Running",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
		],
	});

	expect(await execute(["start", "done"], { tracker })).toEqual({
		ok: false,
		error: {
			code: "INVALID_TRANSITION",
			message:
				"No manifest transition matches the current workflow fields for this event.",
			details: { id: "done", event: "start" },
		},
	});
	expect(
		await execute(["succeed", "running", "--run", "other", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		}),
	).toEqual({
		ok: false,
		error: {
			code: "RUN_MISMATCH",
			message: "Command run id does not match the active workflow run.",
			details: { id: "running", activeRunId: "run-1", runId: "other" },
		},
	});
});

test("terminal retries are idempotent for identical outcomes and reject conflicts", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Terminal",
				workflow: { kind: "ticket", state: "done", action: "none" },
			},
		],
	});
	await tracker.appendLog("123", {
		type: "action_succeeded",
		runId: "run-1",
		payload: { event: "succeed", to: { state: "done", action: "none" } },
	});

	const retry = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ merged: true }),
		},
	);
	expect(retry.ok).toBe(true);
	expect((await tracker.readLogs("123")).length).toBe(1);
	expect(
		await execute(["fail", "123", "--run", "run-1", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ merged: true }),
		}),
	).toEqual({
		ok: false,
		error: {
			code: "CONFLICTING_TERMINAL_OUTCOME",
			message: "Workflow run already has a different terminal outcome.",
			details: { id: "123", runId: "run-1" },
		},
	});
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
	expect({
		state: failed.issue.workflow.state,
		action: failed.issue.workflow.action,
		reason: failed.issue.workflow.reason,
	}).toEqual({ state: "ready", action: "implement", reason: undefined });
	expect((await tracker.readLogs("retry"))[0]?.payload).toEqual({
		event: "fail",
		input: { reason: "temporary CI failure" },
		to: { state: "ready", action: "implement" },
	});

	const invalidResume = await execute(["resume", "retry", "--action", "fix"], {
		tracker,
	});
	expect(invalidResume.ok).toBe(false);
	expect(invalidResume.ok ? undefined : invalidResume.error).toEqual({
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
	expect({
		state: (await tracker.getIssue("human")).workflow.state,
		action: (await tracker.getIssue("human")).workflow.action,
	}).toEqual({ state: "need-human", action: "none" });
	expect((await tracker.readLogs("human"))[0]?.payload).toEqual({
		event: "escalate",
		input: { reason: "needs product decision" },
		from: { state: "ready", action: "review" },
		to: { state: "need-human", action: "none" },
	});

	const resumed = assertSuccess<{
		issue: { workflow: { state: string; action: string } };
	}>(await execute(["resume", "human", "--action", "fix"], { tracker }));
	expect({
		state: resumed.issue.workflow.state,
		action: resumed.issue.workflow.action,
	}).toEqual({ state: "ready", action: "fix" });
	expect((await tracker.readLogs("human")).map((log) => log.type)).toEqual([
		"human_intervention_needed",
		"action_resumed",
	]);
	expect((await tracker.readLogs("human"))[1]?.payload).toEqual({
		event: "resume",
		to: { state: "ready", action: "fix" },
	});
});
