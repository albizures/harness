import { z } from "zod";
import { expect, it } from "vitest";
import { execute as rawExecute } from "../../../src/commands.ts";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";

import { defineManifest } from "../../../src/manifest/index.ts";
import { createInMemoryTracker } from "../../../src/trackers/memory.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}
const pr = (n: number) => `https://github.com/albizures/harness/pull/${n}`;
const prArtifact = (n: number) => ({ type: "pull-request", url: pr(n) });
const findingArtifact = (ref: string) => ({ type: "finding", ref });

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: T }).data;
}

it("should ensure that start moves a ready issue to running, stores one active run, and appends an action_started log", async () => {
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

it("should ensure that pause moves a running issue to waiting-human, clears its active run, and logs pause metadata", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "123",
				title: "Need product answer",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(["pause", "123", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({
			reason: "Need clarification on the API shape.",
			resumeAction: "fix",
		}),
	});

	expect(envelope.ok).toBe(true);
	const data = (
		envelope as {
			ok: true;
			data: {
				issue: {
					workflow: { state: string; action: string; activeRunId?: string };
				};
				log: {
					type: string;
					runId?: string;
					payload?: Record<string, unknown>;
				};
			};
		}
	).data;
	expect(data.issue.workflow).toMatchObject({
		state: "waiting-human",
		action: "none",
	});
	expect(data.issue.workflow.activeRunId).toBeUndefined();
	expect(data.log.type).toBe("human_input_needed");
	expect(data.log.runId).toBe("run-1");
	expect(data.log.payload).toMatchObject({
		event: "pause",
		pausedAction: "implement",
		resumeAction: "fix",
		reason: "Need clarification on the API shape.",
	});
	const getEnvelope = await execute(["get", "123"], { tracker });
	const getData = (getEnvelope as { ok: true; data: { runs: unknown } }).data;
	expect(getData.runs).toEqual({
		activeRunId: undefined,
		attempts: [{ runId: "run-1", status: "paused" }],
	});
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
						runId: "run-1",
						payload: {
							event: "pause",
							pausedAction: "implement",
							reason: "Need API decision.",
						},
					},
				],
			},
		],
	});

	const envelope = await execute(["respond", "123", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({
			response: "Use the smaller public API.",
			sufficient: true,
		}),
	});

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
	expect(logs[1]?.payload).toMatchObject({
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

	const envelope = await execute(["respond", "123", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({
			response: "I only know part of it.",
			sufficient: false,
		}),
	});

	expect(envelope.ok).toBe(true);
	const updated = await tracker.getIssue("123");
	expect(updated.workflow).toMatchObject({
		state: "waiting-human",
		action: "none",
	});
	const logs = await tracker.readLogs("123");
	expect(logs[0]?.type).toBe("human_response_received");
	expect(logs[0]?.payload).toMatchObject({
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
						runId: "run-1",
						payload: { event: "pause", pausedAction: "not-ready" },
					},
				],
			},
		],
	});

	const envelope = await execute(["respond", "123", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({
			response: "Try the unknown action.",
			sufficient: true,
		}),
	});

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
	expect(logs[1]?.payload).toMatchObject({
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
		workflow: { id: "generic-parent-progression" },
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
		commands: [],
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
					activeRunId: "run-1",
				},
				relationships: { parent: "goal" },
			},
		],
	});

	const envelope = await execute(["succeed", "finishing", "--run", "run-1"], {
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

it("should ensure that succeed applies the manifest terminal transition for the active run", async () => {
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

it("should ensure that terminal command rejects malformed bundled pull request artifacts before mutation", async () => {
	const manifest = {
		...agentDevelopmentManifest,
		kinds: agentDevelopmentManifest.kinds.map((kind) =>
			kind.id === "ticket"
				? {
						...kind,
						transitions: kind.transitions.map((transition) =>
							transition.from.state === "running" &&
							transition.from.action === "implement" &&
							transition.event === "succeed"
								? {
										...transition,
										input: z.strictObject({ implementationPr: z.unknown() }),
									}
								: transition,
						),
					}
				: kind,
		),
	};
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
			manifest,
			stdin: JSON.stringify({
				implementationPr: { type: "pull-request", ref: "not-a-pr" },
			}),
		},
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"INVALID_ACTION_INPUT",
	);
	expect(envelope.ok ? undefined : envelope.error.details?.issues).toEqual([
		{
			path: "$.implementationPr.url",
			message: "Artifact reference must include url.",
		},
	]);
	expect((await tracker.getIssue("123")).workflow).toEqual({
		kind: "ticket",
		state: "running",
		action: "implement",
		activeRunId: "run-1",
		version: 1,
		hash: expect.any(String),
	});
	expect(await tracker.readLogs("123")).toEqual([]);
	expect((await tracker.getIssue("123")).artifacts).toEqual([]);
});

it("should ensure that terminal command rejects schema-valid non-JSON-compatible parsed input before mutation", async () => {
	const manifest = {
		...agentDevelopmentManifest,
		kinds: agentDevelopmentManifest.kinds.map((kind) =>
			kind.id === "ticket"
				? {
						...kind,
						transitions: kind.transitions.map((transition) =>
							transition.from.state === "running" &&
							transition.from.action === "implement" &&
							transition.event === "succeed"
								? {
										...transition,
										input: z.strictObject({
											implementationPr: z.string().transform(() => new Date(0)),
										}),
									}
								: transition,
						),
					}
				: kind,
		),
	};
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
		{ tracker, manifest, stdin: JSON.stringify({ implementationPr: "ok" }) },
	);

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"INVALID_ACTION_INPUT",
	);
	expect((await tracker.getIssue("123")).workflow).toEqual({
		kind: "ticket",
		state: "running",
		action: "implement",
		activeRunId: "run-1",
		version: 1,
		hash: expect.any(String),
	});
	expect(await tracker.readLogs("123")).toEqual([]);
	expect((await tracker.getIssue("123")).artifacts).toEqual([]);
});

it("should ensure that escalation validates input shape and JSON-compatible parsed input before mutation", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "shape",
				title: "Escalate shape",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
			{
				id: "json",
				title: "Escalate json",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const shapeInvalid = await execute(["escalate", "shape", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({ reason: "blocked", extra: true }),
	});
	expect(shapeInvalid.ok).toBe(false);
	expect(shapeInvalid.ok ? undefined : shapeInvalid.error.code).toBe(
		"INVALID_ACTION_INPUT",
	);
	expect(await tracker.readLogs("shape")).toEqual([]);
	expect((await tracker.getIssue("shape")).workflow.state).toBe("ready");

	const manifest = {
		...agentDevelopmentManifest,
		lifecycle: {
			...agentDevelopmentManifest.lifecycle,
			escalation: {
				...agentDevelopmentManifest.lifecycle?.escalation,
				input: z.strictObject({
					reason: z.string().transform(() => Symbol("not-json")),
				}),
			},
		},
	};
	const jsonInvalid = await execute(["escalate", "json", "--input", "-"], {
		tracker,
		manifest,
		stdin: JSON.stringify({ reason: "blocked" }),
	});
	expect(jsonInvalid.ok).toBe(false);
	expect(jsonInvalid.ok ? undefined : jsonInvalid.error.code).toBe(
		"INVALID_ACTION_INPUT",
	);
	expect(await tracker.readLogs("json")).toEqual([]);
	expect((await tracker.getIssue("json")).workflow.state).toBe("ready");
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

	const envelope = await execute(["resume", "123", "--action", "fix"], {
		tracker,
	});

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

it("should ensure that lifecycle commands reject invalid manifest transitions and run mismatches", async () => {
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

it("should ensure that terminal retries are idempotent for identical outcomes and reject conflicts", async () => {
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

it("should ensure that generic lifecycle transition handlers receive validated input and contribute log payload, artifacts, and effects", async () => {
	const manifest = {
		version: "v1" as const,
		workflow: { id: "generic" },
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
						input: z.strictObject({ n: z.string().transform(Number) }),
						to: { state: "done", action: "none" },
					},
				],
			},
		],
		commands: [],
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
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ n: "2" }),
			lifecycleHandlers: {
				"work:running/do:succeed": ({ input, tracker }) => ({
					log: {
						doubled: (input as { n: number }).n * 2,
						canMutate: "applyWorkflowEffects" in tracker,
					},
					artifacts: [
						{
							kind: "inline",
							uri: "handler:summary",
							name: "Handler summary",
							text: "done",
						},
					],
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
				}),
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
	expect(updatedWorkflow.activeRunId).toBeUndefined();
	expect((await tracker.getIssue("123")).artifacts).toMatchObject([
		{ kind: "inline", uri: "handler:summary", name: "Handler summary" },
	]);
	expect((await tracker.readLogs("123"))[0]?.payload).toEqual({
		event: "succeed",
		input: { n: 2 },
		to: { state: "done", action: "none" },
		doubled: 4,
		canMutate: false,
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
		workflow: { id: "generic" },
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
						input: z.strictObject({ ok: z.boolean() }),
						to: { state: "done", action: "none" },
					},
				],
			},
		],
		commands: [],
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
					activeRunId: "run-1",
				},
			},
		],
	});

	const envelope = await execute(
		["succeed", "123", "--run", "run-1", "--input", "-"],
		{
			tracker,
			manifest,
			stdin: JSON.stringify({ ok: true }),
			lifecycleHandlers: {
				"work:running/do:succeed": () => ({ log: { bad: Symbol("x") } }),
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
		activeRunId: "run-1",
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
