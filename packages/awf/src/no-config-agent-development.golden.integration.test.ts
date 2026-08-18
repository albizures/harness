import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bindCliExecution } from "./cli-config.ts";
import { execute } from "./commands.ts";
import type { Envelope } from "./envelope.ts";

type SuccessData = Extract<Envelope, { ok: true }>["data"];

async function runAwf(
	cwd: string,
	args: Array<string>,
	stdin?: string,
): Promise<Envelope> {
	const binding = await bindCliExecution(args, cwd);
	if ("ok" in binding) {
		return binding;
	}
	return execute(binding.args, {
		manifest: binding.manifest,
		tracker: binding.tracker,
		stdin,
	});
}

function expectSuccess(envelope: Envelope): SuccessData {
	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error(`expected success envelope, got ${envelope.error.code}`);
	}
	return envelope.data;
}

function normalizeRunIds<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_key, nested) =>
			typeof nested === "string" && nested.startsWith("run-")
				? "<run-id>"
				: nested,
		),
	) as T;
}

test("no-config bundled workflow golden path creates Specs, applies Plans, records Handoffs, runs lifecycle terminals, reports readiness, logs, and tracker state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-no-config-golden-"));

	const created = expectSuccess(
		await runAwf(
			cwd,
			["create", "spec", "--input", "-"],
			"# Golden spec\n\nPin compatibility.",
		),
	) as Record<string, unknown>;
	expect(created).toMatchObject({
		issue: {
			id: "1",
			title: "Golden spec",
			body: "# Golden spec\n\nPin compatibility.",
			workflow: { kind: "spec", state: "ready", action: "plan" },
		},
		log: { sequence: 1, issueId: "1", type: "spec_created" },
	});

	expect(
		expectSuccess(
			await runAwf(
				cwd,
				["apply", "plan", "1", "--input", "-"],
				JSON.stringify({
					tickets: [
						{ key: "api", title: "Build API", content: "Implement API." },
					],
				}),
			),
		),
	).toMatchObject({
		outcome: "SUCCESS",
		spec: {
			id: "1",
			workflow: { kind: "spec", state: "ready", action: "none" },
		},
		tickets: [{ id: "2", key: "api" }],
		artifact: {
			id: "artifact-1",
			kind: "inline",
			uri: "submitted-plan-bundle",
			metadata: { ticketCount: 1 },
		},
		log: { sequence: 2, issueId: "1", type: "plan_applied" },
	});

	expect(expectSuccess(await runAwf(cwd, ["ready"]))).toEqual({
		items: [
			{
				id: "2",
				title: "Build API",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				suggestedCommand: { argv: ["start", "2"], display: "awf start 2" },
			},
		],
	});

	const started = expectSuccess(await runAwf(cwd, ["start", "2"])) as {
		run: { id: string };
	};
	const runId = started.run.id;
	expect(normalizeRunIds(started)).toMatchObject({
		issue: {
			id: "2",
			workflow: {
				kind: "ticket",
				state: "running",
				action: "implement",
				activeRunId: "<run-id>",
			},
		},
		run: { id: "<run-id>" },
		log: {
			sequence: 1,
			issueId: "2",
			type: "action_started",
			runId: "<run-id>",
		},
	});

	expect(
		normalizeRunIds(
			expectSuccess(
				await runAwf(
					cwd,
					["succeed", "2", "--run", runId, "--input", "-"],
					JSON.stringify({
						implementationPr: {
							type: "pull-request",
							url: "https://github.com/albizures/harness/pull/129",
						},
					}),
				),
			),
		),
	).toMatchObject({
		issue: {
			id: "2",
			workflow: { kind: "ticket", state: "ready", action: "review" },
		},
		run: { id: "<run-id>", status: "succeed" },
		log: {
			sequence: 2,
			issueId: "2",
			type: "action_succeeded",
			runId: "<run-id>",
		},
	});

	expect(
		expectSuccess(
			await runAwf(
				cwd,
				["create", "handoff", "--source", "2", "--input", "-"],
				JSON.stringify({
					handoff: { type: "handoff", ref: "Next: review the API surface." },
				}),
			),
		),
	).toMatchObject({
		source: "2",
		artifact: {
			id: "artifact-2",
			kind: "handoff",
			uri: "Next: review the API surface.",
			type: "handoff",
			ref: "Next: review the API surface.",
		},
		log: { sequence: 3, issueId: "2", type: "handoff_created" },
	});

	expect(
		normalizeRunIds(expectSuccess(await runAwf(cwd, ["logs", "2"]))),
	).toEqual({
		logs: [
			expect.objectContaining({
				sequence: 1,
				issueId: "2",
				type: "action_started",
				runId: "<run-id>",
			}),
			expect.objectContaining({
				sequence: 2,
				issueId: "2",
				type: "action_succeeded",
				runId: "<run-id>",
			}),
			expect.objectContaining({
				sequence: 3,
				issueId: "2",
				type: "handoff_created",
			}),
		],
	});

	expect(expectSuccess(await runAwf(cwd, ["get", "2"]))).toMatchObject({
		issue: {
			id: "2",
			workflow: { kind: "ticket", state: "ready", action: "review" },
			artifacts: [
				{
					kind: "pull-request",
					uri: "https://github.com/albizures/harness/pull/129",
				},
				{ kind: "handoff", uri: "Next: review the API surface." },
			],
		},
	});
});

test("no-config bundled workflow golden errors expose compatibility codes and details before mutation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-no-config-errors-"));

	expect(await runAwf(cwd, ["create", "spec", "--input", "-"], "   ")).toEqual({
		ok: false,
		error: {
			code: "WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			message: "Workflow command input is invalid.",
			details: {
				command: "spec-create",
				issues: [
					{
						path: "$input.spec.ref",
						message: "Artifact reference must be non-empty.",
					},
				],
			},
		},
	});

	expect(
		await runAwf(
			cwd,
			["create", "handoff", "--source", "missing", "--input", "-"],
			JSON.stringify({
				handoff: { type: "handoff", metadata: { summary: "no ref" } },
			}),
		),
	).toEqual({
		ok: false,
		error: {
			code: "WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			message: "Workflow command input is invalid.",
			details: {
				command: "handoff-create",
				issues: [
					{
						path: "$input.handoff.ref",
						message: "Artifact reference must include ref.",
					},
				],
			},
		},
	});

	const created = expectSuccess(
		await runAwf(cwd, ["create", "spec", "--input", "-"], "# Error fixture"),
	) as { issue: { id: string } };
	expect(
		await runAwf(
			cwd,
			["apply", "plan", created.issue.id, "--input", "-"],
			JSON.stringify({ tickets: [{ key: "bad", title: "Missing content" }] }),
		),
	).toEqual({
		ok: false,
		error: {
			code: "WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			message: "Workflow command input is invalid.",
			details: {
				command: "plan-apply",
				issues: [
					{
						path: "$input.tickets[0].content",
						message: "Invalid input: expected string, received undefined",
					},
				],
			},
		},
	});

	expect(await runAwf(cwd, ["get", created.issue.id])).toMatchObject({
		ok: true,
		data: {
			issue: {
				id: created.issue.id,
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		},
	});
});
