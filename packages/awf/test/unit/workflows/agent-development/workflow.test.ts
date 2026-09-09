import { expect, it } from "vitest";
import { execute as rawExecute } from "../../../../src/commands.ts";
import { validateManifest } from "../../../../src/manifest/index.ts";
import { createInMemoryTracker } from "../../../../src/trackers/memory.ts";
import type { WorkflowIssue } from "../../../../src/workflow/issue.ts";
import {
	agentDevelopmentCommandHandlers,
	agentDevelopmentLifecycleHandlers,
	agentDevelopmentManifest,
	commandHandlers,
	lifecycleHandlers,
	manifest,
} from "../../../../src/workflows/agent-development/index.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}

type CreateSpecData = { issue: WorkflowIssue };
type ApplyPlanData = {
	tickets: Array<{ key: string; id: string }>;
};
type HandoffData = { log: { type: string } };
type TerminalData = { issue: WorkflowIssue; log: { message?: string } };

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	expect(envelope.ok).toBe(true);
	return (envelope as { ok: true; data: T }).data;
}

function assertFailureCode(
	envelope: Awaited<ReturnType<typeof execute>>,
	code: string,
): void {
	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(code);
}

it("should export a valid explicit bundled workflow module", () => {
	expect(manifest).toBe(agentDevelopmentManifest);
	expect(commandHandlers).toBe(agentDevelopmentCommandHandlers);
	expect(lifecycleHandlers).toBe(agentDevelopmentLifecycleHandlers);
	expect(validateManifest(agentDevelopmentManifest)).toEqual([]);
	expect(agentDevelopmentManifest.workflow.id).toBe("agent-development");
	expect(agentDevelopmentManifest.kinds.map((kind) => kind.id)).toEqual([
		"spec",
		"ticket",
	]);
	expect(
		agentDevelopmentManifest.commands.map((command) => command.id),
	).toEqual([
		"spec-create",
		"plan-apply",
		"handoff-create",
		"start",
		"succeed",
		"fail",
		"escalate",
		"resume",
		"spec-start",
		"spec-succeed",
		"spec-fail",
		"spec-escalate",
		"spec-recover",
		"ticket-start",
		"ticket-succeed",
		"ticket-fail",
		"ticket-escalate",
		"ticket-recover",
	]);
});

it("should capture agent-development-specific lifecycle and readiness assumptions", () => {
	expect(agentDevelopmentManifest.vocabulary.states).not.toContain("blocked");
	const { readiness } = agentDevelopmentManifest;
	if (readiness === undefined) {
		throw new Error("agent-development readiness is required");
	}
	expect(readiness.filters).toEqual(
		expect.arrayContaining([
			{ kind: "spec", state: "ready", action: "plan" },
			{ kind: "spec", state: "ready", action: "integration-test" },
			{ kind: "ticket", state: "ready", action: "implement" },
			{ kind: "ticket", state: "ready", action: "review" },
		]),
	);
	expect(readiness.relationshipPolicies).toContainEqual({
		relationship: "children",
		where: { kind: "spec", state: "ready", action: "integration-test" },
		children: { all: { kind: "ticket", state: "done" }, min: 1 },
		gate: "children",
	});
	expect(
		agentDevelopmentManifest.lifecycle?.relationshipPolicies,
	).toContainEqual({
		relationship: "parent",
		child: { kind: "ticket", state: "done", action: "none" },
		parent: { kind: "spec", state: "ready", action: "none" },
		siblings: { all: { kind: "ticket", state: "done" }, min: 1 },
		to: { state: "ready", action: "integration-test" },
	});
});

it("should create a Spec through the bundled command handler", async () => {
	const tracker = createInMemoryTracker();

	const data = assertSuccess<CreateSpecData>(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: "# Build the workflow\n\nMake it explicit.",
		}),
	);

	expect(data.issue.title).toBe("Build the workflow");
	expect(data.issue.body).toBe("# Build the workflow\n\nMake it explicit.");
	expect(data.issue.workflow).toMatchObject({
		kind: "spec",
		state: "ready",
		action: "plan",
	});
	expect(
		(await tracker.readLogs(data.issue.id)).map((log) => log.type),
	).toEqual(["spec_created"]);
});

it("should apply a bundled plan into tickets, parent-child links, dependencies, and a plan log", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});
	const plan = {
		tickets: [
			{ key: "one", title: "First ticket", content: "Implement first." },
			{
				key: "two",
				title: "Second ticket",
				content: "Implement second.",
				dependsOn: ["one"],
			},
		],
	};

	const data = assertSuccess<ApplyPlanData>(
		await execute(["apply", "plan", "spec-1", "--input", "-"], {
			tracker,
			stdin: JSON.stringify(plan),
		}),
	);

	expect(data.tickets).toEqual([
		{ key: "one", id: "1" },
		{ key: "two", id: "2" },
	]);
	const spec = await tracker.getIssue("spec-1");
	expect(spec.workflow).toMatchObject({
		kind: "spec",
		state: "ready",
		action: "none",
	});
	expect(spec.relationships.children).toEqual(["1", "2"]);
	expect((await tracker.getIssue("2")).relationships.dependencies).toEqual([
		"1",
	]);
	expect((await tracker.readLogs("spec-1")).map((log) => log.type)).toContain(
		"plan_applied",
	);
});

it("should reject bundled plan payloads with duplicate or unknown dependency keys", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec-1",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "plan" },
			},
		],
	});

	assertFailureCode(
		await execute(["apply", "plan", "spec-1", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				tickets: [
					{ key: "same", title: "First", content: "One" },
					{
						key: "same",
						title: "Second",
						content: "Two",
						dependsOn: ["missing"],
					},
				],
			}),
		}),
		"INVALID_PLAN",
	);
	expect((await tracker.getIssue("spec-1")).relationships.children).toEqual([]);
});

it("should record bundled handoffs as workflow logs", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: { kind: "ticket", state: "ready", action: "review" },
			},
		],
	});

	const data = assertSuccess<HandoffData>(
		await execute(
			["create", "handoff", "--source", "ticket-1", "--input", "-"],
			{
				tracker,
				stdin: JSON.stringify({
					handoff: { type: "handoff", ref: "Continue with review." },
				}),
			},
		),
	);

	expect(data.log.type).toBe("handoff_created");
	expect(await tracker.getIssue("ticket-1")).not.toHaveProperty("artifacts");
});

it("should ensure that bundled lifecycle handlers enforce terminal verdicts and record pull request artifacts", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "ticket-1",
				title: "Ticket",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "review",
					activeRunId: "run-review",
				},
			},
			{
				id: "ticket-2",
				title: "Ticket 2",
				workflow: {
					kind: "ticket",
					state: "running",
					action: "implement",
					activeRunId: "run-implement",
				},
			},
		],
	});

	assertFailureCode(
		await execute(
			[
				"run-command",
				"succeed",
				"ticket-1",
				"--run",
				"run-review",
				"--input",
				"-",
			],
			{
				tracker,
				stdin: JSON.stringify({ verdict: "changes-requested" }),
			},
		),
		"INVALID_ACTION_INPUT",
	);

	const data = assertSuccess<TerminalData>(
		await execute(
			[
				"run-command",
				"succeed",
				"ticket-2",
				"--run",
				"run-implement",
				"--input",
				"-",
			],
			{
				tracker,
				stdin: JSON.stringify({
					implementationPr: {
						type: "pull-request",
						url: "https://github.com/albizures/harness/pull/1",
					},
				}),
			},
		),
	);

	expect(data.issue.workflow).toMatchObject({
		kind: "ticket",
		state: "ready",
		action: "review",
	});
	expect(await tracker.getIssue("ticket-2")).not.toHaveProperty("artifacts");
	expect(data.log.message).toContain(
		"https://github.com/albizures/harness/pull/1",
	);
});
