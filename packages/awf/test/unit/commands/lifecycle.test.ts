import { expect, it } from "vitest";
import { execute as rawExecute } from "../../support/execute.ts";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";

import { defineManifest } from "../../../src/manifest/index.ts";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}

const manifestWithRuntimeHumanCommands = {
	...agentDevelopmentManifest,
	commands: [
		...agentDevelopmentManifest.commands,
		{ id: "pause", target: { kind: "ticket", action: "implement" } },
		{ id: "respond", target: { kind: "ticket", action: "implement" } },
	],
};

function executeWithRuntimeHumanCommands(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, {
		manifest: manifestWithRuntimeHumanCommands,
		...options,
	});
}
const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;
const prArtifact = (n: number) => ({ type: "pull-request", url: pr(n) });
const findingArtifact = (ref: string) => ({ type: "finding", ref });

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: T }).data;
}

it("should ensure that start moves a ready issue to running and appends an action_started log without run identity", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
		],
	});

	const envelope = await execute(["run-command", "start", "123"], { tracker });

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: {
				issue: { workflow: { state: string } };
			};
		}
	).data;
	expect(data.issue.workflow.state).toBe("running");
	const logs = await tracker.readLogs("123");
	expect(logs.map((log) => log.type)).toEqual(["action_started"]);
});

it("should ensure that pause moves a running issue to waiting-human and logs pause metadata", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Need product answer",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
				},
			},
		],
	});

	const envelope = await executeWithRuntimeHumanCommands(
		["run-command", "pause", "123", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				reason: "Need clarification on the API shape.",
				resumeAction: "fix",
			}),
		},
	);

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: {
				issue: { workflow: Record<string, unknown> };
				log: {
					type: string;
					message?: string;
				};
			};
		}
	).data;
	expect(data.issue.workflow).toMatchObject({
		state: "waiting-human",
		action: "none",
	});
	expect(data.log.type).toBe("human_input_needed");
	expect(JSON.parse(data.log.message ?? "{}")).toMatchObject({
		event: "pause",
		pausedAction: "implement",
		resumeAction: "fix",
		reason: "Need clarification on the API shape.",
	});
	const getEnvelope = await execute(["get", "123"], { tracker });
	const getData = (getEnvelope as { ok: true; data: Record<string, unknown> })
		.data;
	expect(getData.logs).toEqual([
		{
			issueId: "123",
			sequence: 1,
			type: "human_input_needed",
			message: data.log.message,
		},
	]);
});

it("should ensure that respond resumes a waiting-human issue to a valid ready action from the pause metadata by default", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Answer received",
				workflow: { kind: "ticket", state: "waiting-human", action: "none" },
				logs: [
					{
						sequence: 1,
						type: "human_input_needed",
						message: JSON.stringify({
							event: "pause",
							pausedAction: "implement",
							reason: "Need API decision.",
						}),
					},
				],
			},
		],
	});

	const envelope = await executeWithRuntimeHumanCommands(
		["run-command", "respond", "123", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				response: "Use the smaller public API.",
				sufficient: true,
			}),
		},
	);

	expect(envelope.ok).toBe(true);
	const updated = await tracker.getIssue("123");
	expect(updated.workflow).toMatchObject({
		state: "ready",
		action: "implement",
	});
	const logs = await tracker.readLogs("123");
	expect(logs.map((log) => log.type)).toEqual([
		"human_input_needed",
		"human_response_received",
	]);
	expect(JSON.parse(logs[1]?.message ?? "{}")).toMatchObject({
		event: "respond",
		response: "Use the smaller public API.",
		sufficient: true,
		resumeAction: "implement",
	});
});

it("should ensure that respond keeps an insufficient response waiting for the human", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Partial answer",
				workflow: { kind: "ticket", state: "waiting-human", action: "none" },
			},
		],
	});

	const envelope = await executeWithRuntimeHumanCommands(
		["run-command", "respond", "123", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				response: "I only know part of it.",
				sufficient: false,
			}),
		},
	);

	expect(envelope.ok).toBe(true);
	const updated = await tracker.getIssue("123");
	expect(updated.workflow).toMatchObject({
		state: "waiting-human",
		action: "none",
	});
	const logs = await tracker.readLogs("123");
	expect(logs[0]?.type).toBe("human_response_received");
	expect(JSON.parse(logs[0]?.message ?? "{}")).toMatchObject({
		event: "respond",
		response: "I only know part of it.",
		sufficient: false,
	});
});

it("should ensure that invalid waiting-human resume targets become exceptional need-human intervention", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Invalid response target",
				workflow: { kind: "ticket", state: "waiting-human", action: "none" },
				logs: [
					{
						sequence: 1,
						type: "human_input_needed",
						message: JSON.stringify({
							event: "pause",
							pausedAction: "not-ready",
						}),
					},
				],
			},
		],
	});

	const envelope = await executeWithRuntimeHumanCommands(
		["run-command", "respond", "123", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({
				response: "Try the unknown action.",
				sufficient: true,
			}),
		},
	);

	expect(envelope.ok).toBe(true);
	expect((await tracker.getIssue("123")).workflow).toMatchObject({
		state: "need-human",
		action: "none",
	});
	const logs = await tracker.readLogs("123");
	expect(logs.map((log) => log.type)).toEqual([
		"human_input_needed",
		"human_intervention_needed",
	]);
	expect(JSON.parse(logs[1]?.message ?? "{}")).toMatchObject({
		event: "respond",
		from: { state: "waiting-human", action: "none" },
		to: { state: "need-human", action: "none" },
		response: "Try the unknown action.",
		sufficient: true,
		resumeAction: "not-ready",
	});
});

it("should ensure that succeed applies generic relationship-driven lifecycle progression", async () => {
	const manifest = defineManifest({
		version: "v1",
		workflow: { id: "generic-parent-progression", version: "1.0.0" },
		vocabulary: {
			states: ["ready", "running", "done"],
			actions: ["wait", "do", "verify", "none"],
			events: ["start", "succeed"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 },
		readiness: { filters: [] },
		lifecycle: {
			relationshipPolicies: [
				{
					relationship: "parent",
					child: { kind: "task", state: "done", action: "none" },
					parent: { kind: "goal", state: "ready", action: "wait" },
					siblings: { all: { kind: "task", state: "done" }, min: 2 },
					to: { state: "ready", action: "verify" },
				},
			],
		},
		kinds: [
			{
				id: "goal",
				label: "Goal",
				initial: { state: "ready", action: "wait" },
				transitions: [],
			},
			{
				id: "task",
				label: "Task",
				initial: { state: "ready", action: "do" },
				transitions: [
					{
						from: { state: "running", action: "do" },
						event: "succeed",
						to: { state: "done", action: "none" },
					},
				],
			},
		],
		commands: [
			{ id: "start", target: { kind: "task", action: "do" } },
			{ id: "succeed", target: { kind: "task", action: "do" } },
			{ id: "fail", target: { kind: "task", action: "do" } },
			{ id: "pause", target: { kind: "task", action: "do" } },
			{ id: "respond", target: { kind: "task", action: "do" } },
			{ id: "escalate", target: { kind: "task", action: "do" } },
			{ id: "resume", target: { kind: "task", action: "do" } },
		],
	});
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "goal",
				title: "Goal",
				workflow: { kind: "goal", state: "ready", action: "wait" },
				relationships: { children: ["done", "finishing"] },
			},
			{
				id: "done",
				title: "Already done",
				workflow: { kind: "task", state: "done", action: "none" },
				relationships: { parent: "goal" },
			},
			{
				id: "finishing",
				title: "Finishing",
				workflow: {
					kind: "task",
					state: "running",
					action: "do",
				},
				relationships: { parent: "goal" },
			},
		],
	});

	const envelope = await execute(["run-command", "succeed", "finishing"], {
		tracker,
		manifest,
	});

	expect(envelope.ok).toBe(true);
	const goal = await tracker.getIssue("goal");
	expect({
		kind: goal.workflow.kind,
		state: goal.workflow.state,
		action: goal.workflow.action,
	}).toEqual({ kind: "goal", state: "ready", action: "verify" });
});

it("should ensure that succeed applies the manifest terminal transition", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Implement lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
				},
			},
		],
	});

	const envelope = await execute(
		["run-command", "succeed", "123", "--input", "-"],
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
				issue: { workflow: { state: string; action: string } };
			};
		}
	).data;
	expect(data.issue.workflow.state).toBe("ready");
	expect(data.issue.workflow.action).toBe("review");
	expect((await tracker.readLogs("123")).map((log) => log.type)).toEqual([
		"action_succeeded",
	]);
});

it("should ensure that failed running actions retry the same ready action by default", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Merge lifecycle",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "merge",
				},
			},
		],
	});

	const envelope = await execute(
		["run-command", "fail", "123", "--input", "-"],
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
	expect(
		JSON.parse((await tracker.readLogs("123"))[0]?.message ?? "{}"),
	).toEqual({
		event: "fail",
		input: { verdict: "changes-requested", findings: [findingArtifact("bug")] },
		to: { state: "ready", action: "merge" },
	});
});

it("should ensure that explicit escalation moves work to need-human none and logs the reason", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Escalate lifecycle",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const envelope = await execute(
		["run-command", "escalate", "123", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ reason: "review requires product decision" }),
		},
	);

	expect(envelope.ok).toBe(true);
	expect((await tracker.getIssue("123")).workflow.state).toBe("need-human");
	expect((await tracker.getIssue("123")).workflow.action).toBe("none");
	expect(
		JSON.parse((await tracker.readLogs("123"))[0]?.message ?? "{}"),
	).toEqual({
		event: "escalate",
		input: { reason: "review requires product decision" },
		from: { state: "ready", action: "review" },
		to: { state: "need-human", action: "none" },
	});
});

it("should ensure that lifecycle commands do not schema-validate arbitrary terminal or escalation payload shapes", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "running",
				title: "Terminal payload",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
				},
			},
			{
				id: "escalate",
				title: "Escalate payload",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const terminal = await execute(
		["run-command", "succeed", "running", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ arbitrary: { nested: true } }),
		},
	);
	expect(terminal.ok).toBe(true);
	expect(
		JSON.parse((await tracker.readLogs("running"))[0]?.message ?? "{}"),
	).toMatchObject({
		input: { arbitrary: { nested: true } },
	});

	const escalated = await execute(
		["run-command", "escalate", "escalate", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ arbitrary: true, extra: [1] }),
		},
	);
	expect(escalated.ok).toBe(true);
	expect(
		JSON.parse((await tracker.readLogs("escalate"))[0]?.message ?? "{}"),
	).toMatchObject({
		input: { arbitrary: true, extra: [1] },
	});
});
it("should ensure that explicit resume chooses a valid next ready action", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Resume lifecycle",
				workflow: { kind: "ticket", state: "need-human", action: "none" },
			},
		],
	});

	const envelope = await execute(
		["run-command", "resume", "123", "--action", "fix"],
		{
			tracker,
		},
	);

	expect(envelope.ok).toBe(true);
	const issue = await tracker.getIssue("123");
	expect(issue.workflow.state).toBe("ready");
	expect(issue.workflow.action).toBe("fix");
});

it("should ensure that manifest lifecycle policy constrains retry escalation and resume", async () => {
	const manifest = {
		...agentDevelopmentManifest,
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
			await execute(["run-command", "fail", "123", "--input", "-"], {
				tracker,
				manifest,
				stdin: "{}",
			})
		).ok,
	).toBe(false);
	expect(
		(
			await execute(["run-command", "escalate", "123", "--input", "-"], {
				tracker,
				manifest,
				stdin: JSON.stringify({ reason: "blocked" }),
			})
		).ok,
	).toBe(false);
	expect(
		(
			await execute(["run-command", "resume", "human", "--action", "fix"], {
				tracker,
				manifest,
			})
		).ok,
	).toBe(false);
});

it("should ensure that bundled workflow vocabulary and transitions do not include durable blocked", () => {
	expect(
		!agentDevelopmentManifest.vocabulary.states.includes("blocked"),
	).toBeTruthy();
	expect(
		agentDevelopmentManifest.kinds.every((kind) =>
			kind.transitions.every(
				(transition) =>
					transition.from.state !== "blocked" &&
					transition.to.state !== "blocked",
			),
		),
	).toBeTruthy();
});

it("should ensure that lifecycle commands reject invalid manifest transitions", async () => {
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
				},
			},
		],
	});

	expect(await execute(["run-command", "start", "done"], { tracker })).toEqual({
		ok: false,
		error: {
			code: "INVALID_TRANSITION",
			message:
				"No manifest transition matches the current workflow fields for this event.",
			details: { id: "done", event: "start" },
		},
	});
	const succeeded = await execute(
		["run-command", "succeed", "running", "--input", "-"],
		{
			tracker,
			stdin: JSON.stringify({ implementationPr: prArtifact(1) }),
		},
	);
	expect(succeeded.ok).toBe(true);
});

it("should ensure that terminal commands for inactive issues use invalid-transition behavior", async () => {
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
		message: JSON.stringify({
			event: "succeed",
			to: { state: "done", action: "none" },
		}),
	});

	expect(
		await execute(["run-command", "succeed", "123", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ merged: true }),
		}),
	).toEqual({
		ok: false,
		error: {
			code: "INVALID_TRANSITION",
			message: "Terminal transition must leave a manifest active state.",
			details: { id: "123", event: "succeed" },
		},
	});
	expect((await tracker.readLogs("123")).length).toBe(1);
});

it("should ensure that generic lifecycle transition handlers receive JSON input and contribute effects", async () => {
	const manifest = {
		version: "v1" as const,
		workflow: { id: "generic", version: "1.0.0" },
		vocabulary: {
			states: ["ready", "running", "done"],
			actions: ["do", "none"],
			events: ["start", "succeed"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 as const },
		kinds: [
			{
				id: "work",
				label: "Work",
				initial: { state: "ready", action: "do" },
				transitions: [
					{
						from: { state: "ready", action: "do" },
						event: "start",
						to: { state: "running", action: "do" },
					},
					{
						from: { state: "running", action: "do" },
						event: "succeed",
						to: { state: "done", action: "none" },
					},
				],
			},
		],
		commands: [
			{ id: "start", target: { kind: "work", action: "do" } },
			{ id: "succeed", target: { kind: "work", action: "do" } },
			{ id: "fail", target: { kind: "work", action: "do" } },
			{ id: "pause", target: { kind: "work", action: "do" } },
			{ id: "respond", target: { kind: "work", action: "do" } },
			{ id: "escalate", target: { kind: "work", action: "do" } },
			{ id: "resume", target: { kind: "work", action: "do" } },
		],
	};
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Generic work",
				workflow: {
					kind: "work",
					state: "running",
					action: "do",
				},
			},
		],
	});

	const envelope = await execute(
		["run-command", "succeed", "123", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ n: "2" }),
			lifecycleHandlers: {
				"work:running/do:succeed": ({ input, tracker }) => {
					expect(input).toEqual({ n: "2" });
					expect("applyWorkflowEffects" in tracker).toBe(false);
					return {
						effects: [
							{
								type: "create-workflow-issue",
								input: {
									id: "child",
									title: "Follow-up",
									workflow: { kind: "work", state: "ready", action: "do" },
								},
							},
						],
					};
				},
			},
		},
	);

	expect(envelope.ok).toBe(true);
	const updatedWorkflow = (await tracker.getIssue("123")).workflow;
	expect(updatedWorkflow).toMatchObject({
		kind: "work",
		state: "done",
		action: "none",
	});
	expect(await tracker.getIssue("123")).not.toHaveProperty("artifacts");
	expect(
		JSON.parse((await tracker.readLogs("123"))[0]?.message ?? "{}"),
	).toEqual({
		event: "succeed",
		input: { n: "2" },
		to: { state: "done", action: "none" },
	});
	expect(await tracker.getIssue("child")).toMatchObject({
		id: "child",
		title: "Follow-up",
		workflow: { kind: "work", state: "ready", action: "do" },
	});
});

it("should ensure that generic lifecycle transition handlers reject invalid contributions before mutation", async () => {
	const manifest = {
		version: "v1" as const,
		workflow: { id: "generic", version: "1.0.0" },
		vocabulary: {
			states: ["ready", "running", "done"],
			actions: ["do", "none"],
			events: ["succeed"],
		},
		github: { reservedPrefix: "awf" },
		concurrency: { perIssue: 1 as const },
		kinds: [
			{
				id: "work",
				label: "Work",
				initial: { state: "running", action: "do" },
				transitions: [
					{
						from: { state: "running", action: "do" },
						event: "succeed",
						to: { state: "done", action: "none" },
					},
				],
			},
		],
		commands: [
			{ id: "start", target: { kind: "work", action: "do" } },
			{ id: "succeed", target: { kind: "work", action: "do" } },
			{ id: "fail", target: { kind: "work", action: "do" } },
			{ id: "pause", target: { kind: "work", action: "do" } },
			{ id: "respond", target: { kind: "work", action: "do" } },
			{ id: "escalate", target: { kind: "work", action: "do" } },
			{ id: "resume", target: { kind: "work", action: "do" } },
		],
	};
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Generic work",
				workflow: {
					kind: "work",
					state: "running",
					action: "do",
				},
			},
		],
	});

	const envelope = await execute(
		["run-command", "succeed", "123", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ ok: true }),
			lifecycleHandlers: {
				"work:running/do:succeed": () => ({ effects: "invalid" }) as never,
			},
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED",
	);
	expect(await tracker.readLogs("123")).toEqual([]);
	expect((await tracker.getIssue("123")).workflow).toMatchObject({
		kind: "work",
		state: "running",
		action: "do",
	});
});

it("should ensure that default retry, explicit escalation, and explicit resume expose workflow logs and messages", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "retry",
				title: "Retry ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
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
		await execute(["run-command", "fail", "retry", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ reason: "temporary CI failure" }),
		}),
	);
	expect({
		state: failed.issue.workflow.state,
		action: failed.issue.workflow.action,
		reason: failed.issue.workflow.reason,
	}).toEqual({ state: "ready", action: "implement", reason: undefined });
	expect(
		JSON.parse((await tracker.readLogs("retry"))[0]?.message ?? "{}"),
	).toEqual({
		event: "fail",
		input: { reason: "temporary CI failure" },
		to: { state: "ready", action: "implement" },
	});

	const invalidResume = await execute(
		["run-command", "resume", "retry", "--action", "fix"],
		{
			tracker,
		},
	);
	expect(invalidResume.ok).toBe(false);
	expect(invalidResume.ok ? undefined : invalidResume.error).toEqual({
		code: "INVALID_TRANSITION",
		message:
			"No manifest transition matches the current workflow fields for this event.",
		details: { id: "retry", event: "resume" },
	});

	await assertSuccess(
		await execute(["run-command", "escalate", "human", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ reason: "needs product decision" }),
		}),
	);
	expect({
		state: (await tracker.getIssue("human")).workflow.state,
		action: (await tracker.getIssue("human")).workflow.action,
	}).toEqual({ state: "need-human", action: "none" });
	expect(
		JSON.parse((await tracker.readLogs("human"))[0]?.message ?? "{}"),
	).toEqual({
		event: "escalate",
		input: { reason: "needs product decision" },
		from: { state: "ready", action: "review" },
		to: { state: "need-human", action: "none" },
	});

	const resumed = assertSuccess<{
		issue: { workflow: { state: string; action: string } };
	}>(
		await execute(["run-command", "resume", "human", "--action", "fix"], {
			tracker,
		}),
	);
	expect({
		state: resumed.issue.workflow.state,
		action: resumed.issue.workflow.action,
	}).toEqual({ state: "ready", action: "fix" });
	expect((await tracker.readLogs("human")).map((log) => log.type)).toEqual([
		"human_intervention_needed",
		"action_resumed",
	]);
	expect(
		JSON.parse((await tracker.readLogs("human"))[1]?.message ?? "{}"),
	).toEqual({
		event: "resume",
		to: { state: "ready", action: "fix" },
	});
});
