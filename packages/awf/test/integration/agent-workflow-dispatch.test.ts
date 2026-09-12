import { expect, it } from "vitest";
import { execute } from "../support/execute.ts";
import { createInMemoryTracker } from "../../src/adapters/trackers/memory.ts";
import { agentWorkflowManifest } from "../../src/workflows/agent-workflow/index.ts";

function assertSuccess<T>(envelope: Awaited<ReturnType<typeof execute>>): T {
	if (!envelope.ok) {
		throw new Error(`Expected success, got ${envelope.error.code}`);
	}
	return envelope.data as T;
}

it("should ensure that bundled agent-workflow dispatches supported create and ready commands while rejecting generic apply", async () => {
	const tracker = createInMemoryTracker();

	const spec = assertSuccess<{ issue: { id: string } }>(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			manifest: agentWorkflowManifest,
			stdin: JSON.stringify({ title: "Plan feature", body: "# Plan feature" }),
		}),
	);
	const task = assertSuccess<{
		issue: { id: string; relationships: { parent?: string } };
	}>(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			manifest: agentWorkflowManifest,
			stdin: JSON.stringify({
				parent: spec.issue.id,
				title: "Implement feature",
				description: "Build it.",
				profile: "implement",
			}),
		}),
	);

	expect(task.issue.relationships.parent).toBe(spec.issue.id);
	expect(
		assertSuccess<{ items: Array<{ id: string }> }>(
			await execute(["ready", "--filter", `spec=${spec.issue.id}`], {
				tracker,
				manifest: agentWorkflowManifest,
			}),
		).items.map((item) => item.id),
	).toEqual([task.issue.id]);

	const applied = await execute(
		["apply", "task", task.issue.id, "--input", "-"],
		{
			tracker,
			manifest: agentWorkflowManifest,
			stdin: JSON.stringify({ note: "Unsupported generic apply." }),
		},
	);
	expect(applied).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: `apply task ${task.issue.id} --input -` },
		},
	});
});

it("should ensure that bundled agent-workflow exposes supported task lifecycle commands and hides raw run-command from help", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "task-1",
				title: "Implement workflow",
				workflow: { kind: "task", state: "ready", action: "work" },
			},
		],
	});

	const help = assertSuccess<{
		commands: Array<{ name: string; usage: string }>;
	}>(await execute(["--help"], { manifest: agentWorkflowManifest }));
	expect(help.commands.map((command) => command.name)).not.toContain(
		"run-command",
	);
	expect(help.commands.map((command) => command.usage)).toEqual(
		expect.arrayContaining([
			"awf task start <issue>",
			"awf task fail <issue>",
			"awf task recover <issue>",
			"awf task escalate <issue>",
		]),
	);

	assertSuccess(
		await execute(["task", "start", "task-1"], {
			tracker,
			manifest: agentWorkflowManifest,
		}),
	);
	assertSuccess(
		await execute(["task", "fail", "task-1"], {
			tracker,
			manifest: agentWorkflowManifest,
		}),
	);
	assertSuccess(
		await execute(["task", "recover", "task-1"], {
			tracker,
			manifest: agentWorkflowManifest,
		}),
	);
	assertSuccess(
		await execute(["task", "start", "task-1"], {
			tracker,
			manifest: agentWorkflowManifest,
		}),
	);
	assertSuccess(
		await execute(["task", "escalate", "task-1"], {
			tracker,
			manifest: agentWorkflowManifest,
		}),
	);

	expect((await tracker.getIssue("task-1")).workflow).toMatchObject({
		kind: "task",
		state: "need-human",
		action: "none",
	});
	const logs = await tracker.readLogs("task-1");
	expect(logs.map((log) => log.type)).toEqual([
		"command",
		"command",
		"command",
		"command",
		"command",
	]);
	expect(logs.map((log) => log.message)).toEqual([
		"Applied start.",
		"Applied fail.",
		"Applied recover.",
		"Applied start.",
		"Applied escalate.",
	]);
});

it("should ensure that bundled agent-workflow diagnostics reject unsupported top-level lifecycle verbs and undeclared filters", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "task-1",
				title: "Implement workflow",
				workflow: { kind: "task", state: "ready", action: "work" },
			},
		],
	});

	expect(
		await execute(["start", "task-1"], {
			tracker,
			manifest: agentWorkflowManifest,
		}),
	).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "start task-1" },
		},
	});
	expect(
		(
			await execute(["ready", "--filter", "goal=task-1"], {
				tracker,
				manifest: agentWorkflowManifest,
			})
		).ok,
	).toBe(false);
});
