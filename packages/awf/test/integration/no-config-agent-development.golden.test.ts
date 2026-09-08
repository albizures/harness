import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bindCliExecution } from "../../src/cli-config.ts";
import { execute } from "../../src/commands.ts";
import type { Envelope } from "../../src/envelope.ts";

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
		commandHandlers: binding.commandHandlers,
		lifecycleHandlers: binding.lifecycleHandlers,
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

async function createAgentDevelopmentConfig(cwd: string): Promise<void> {
	await writeFile(
		join(cwd, "awf.config.ts"),
		`export {\n\tagentDevelopmentManifest as manifest,\n\tagentDevelopmentCommandHandlers as commandHandlers,\n\tagentDevelopmentLifecycleHandlers as lifecycleHandlers,\n} from "${join(process.cwd(), "src/workflows/agent-development/index.ts")}";\n`,
	);
}

it("should ensure that no config loads the bundled agent-workflow manifest", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-no-config-agent-workflow-"));

	const created = expectSuccess(
		await runAwf(
			cwd,
			["create", "spec", "--input", "-"],
			JSON.stringify({ title: "Spec", body: "# Spec" }),
		),
	) as Record<string, unknown>;

	expect(created).toMatchObject({
		issue: {
			id: "1",
			title: "Spec",
			body: "# Spec",
			workflow: { kind: "spec", state: "ready", action: "planning" },
		},
		log: { sequence: 1, issueId: "1", type: "spec-create_created" },
	});
});

it("should ensure that explicit agent-development config creates Specs, applies Plans, records Handoffs, runs lifecycle terminals, reports readiness, logs, and tracker state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-explicit-agent-development-"));
	await createAgentDevelopmentConfig(cwd);

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

	const issue = (
		expectSuccess(await runAwf(cwd, ["get", "2"])) as {
			issue: Record<string, unknown>;
		}
	).issue;
	expect(issue).toMatchObject({
		id: "2",
		workflow: { kind: "ticket", state: "ready", action: "review" },
	});
	expect(issue).not.toHaveProperty("artifacts");
	expect(issue).not.toHaveProperty("changes");
});
