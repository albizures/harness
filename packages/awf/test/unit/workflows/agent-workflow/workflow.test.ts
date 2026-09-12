import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execute as rawExecute } from "../../../support/execute.ts";
import { validateManifestCommand } from "../../../../src/runtime/commands/manifest-validate.ts";
import { validateManifest } from "../../../../src/manifest/index.ts";
import { createInMemoryTracker } from "../../../../src/adapters/trackers/memory.ts";
import type { Envelope } from "../../../../src/runtime/envelope.ts";
import {
	agentWorkflowCommandHandlers,
	agentWorkflowLifecycleHandlers,
	agentWorkflowManifest,
	commandHandlers,
	lifecycleHandlers,
	manifest,
} from "../../../../src/workflows/agent-workflow/index.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentWorkflowManifest, ...options });
}

function assertSuccess(
	envelope: Envelope,
): Extract<Envelope, { ok: true }>["data"] {
	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error(`expected success envelope, got ${envelope.error.code}`);
	}
	return envelope.data;
}

it("should export a valid explicit bundled workflow module", () => {
	expect(manifest).toBe(agentWorkflowManifest);
	expect(commandHandlers).toBe(agentWorkflowCommandHandlers);
	expect(lifecycleHandlers).toBe(agentWorkflowLifecycleHandlers);
	expect(Object.keys(agentWorkflowCommandHandlers)).toEqual([
		"pause",
		"escalate",
		"resume",
		"spec-create",
		"spec-complete",
		"task-create",
		"grilling-create",
	]);
	expect(Object.keys(agentWorkflowLifecycleHandlers)).toEqual([
		"wayfinder:ready/planning:succeed",
		"wayfinder:running/planning:succeed",
		"task:running/work:succeed",
		"grilling:in-discussion/discuss:succeed",
	]);
	expect(validateManifest(agentWorkflowManifest)).toEqual([]);
	expect(agentWorkflowManifest.workflow.id).toBe("agent-workflow");
	expect(agentWorkflowManifest.workflow.version).toBe("1.0.0");
	expect(agentWorkflowManifest.vocabulary).toEqual({
		states: [
			"ready",
			"running",
			"in-discussion",
			"done",
			"need-human",
			"waiting-human",
		],
		actions: [
			"planning",
			"work",
			"discuss",
			"integration-test",
			"merge",
			"none",
		],
		events: [
			"start",
			"succeed",
			"fail",
			"recover",
			"escalate",
			"pause",
			"resume",
		],
	});
	expect(agentWorkflowManifest.kinds.map((kind) => kind.id)).toEqual([
		"spec",
		"wayfinder",
		"task",
		"grilling",
	]);
	expect(
		agentWorkflowManifest.kinds.find((kind) => kind.id === "task")?.subkinds,
	).toEqual(["work", "research", "prototype"]);
	expect(
		agentWorkflowManifest.kinds.find((kind) => kind.id === "grilling")
			?.subkinds,
	).toBeUndefined();
	expect(agentWorkflowManifest.commands.map((command) => command.id)).toEqual([
		"spec-create",
		"spec-complete",
		"wayfinder-create",
		"task-create",
		"grilling-create",
		"start",
		"succeed",
		"fail",
		"pause",
		"escalate",
		"resume",
		"task-start",
		"task-fail",
		"task-recover",
		"task-escalate",
	]);
});

it("should expose Spec execution and Task work lifecycle through help and describe surfaces", async () => {
	const help = assertSuccess(await execute(["--help"])) as {
		commands: Array<{ usage: string }>;
		readiness: {
			filters: Array<Record<string, string>>;
			subkinds: Array<{ kind: string; values: Array<string> }>;
		};
	};
	expect(help.commands.map((command) => command.usage)).toEqual(
		expect.arrayContaining([
			"awf create spec --input <file|->",
			"awf create wayfinder --input <file|->",
			"awf create task --input <file|->",
			"awf create grilling --input <file|->",
			"awf spec complete <issue> --input <file|->",
			"awf task start <issue>",
			"awf task fail <issue>",
			"awf task recover <issue>",
			"awf task escalate <issue>",
		]),
	);
	expect(
		help.commands.every(
			(command) => !command.usage.startsWith("awf run-command"),
		),
	).toBe(true);
	expect(help.readiness.filters).toEqual([
		{ kind: "spec", state: "ready", action: "planning" },
		{ kind: "task", state: "ready", action: "work" },
	]);
	expect(help.readiness.subkinds).toEqual([
		{ kind: "task", values: ["work", "research", "prototype"] },
	]);

	const description = assertSuccess(
		await execute(["workflow", "describe"]),
	) as {
		workflow: { id: string };
		kinds: Array<{
			id: string;
			initial: Record<string, string>;
			subkinds?: Array<string>;
		}>;
		commands: Array<{ id: string; cli: { usage: string } }>;
		readiness?: { filters: Array<Record<string, string>> };
	};
	expect(description.workflow.id).toBe("agent-workflow");
	expect(description.kinds).toMatchObject([
		{ id: "spec", initial: { state: "ready", action: "planning" } },
		{ id: "wayfinder", initial: { state: "ready", action: "planning" } },
		{
			id: "task",
			initial: { state: "ready", action: "work" },
			subkinds: ["work", "research", "prototype"],
		},
		{ id: "grilling", initial: { state: "ready", action: "discuss" } },
	]);
	expect(
		description.commands.flatMap((command) =>
			command.cli === undefined ? [] : [command.cli.usage],
		),
	).toEqual([
		"awf create spec --input <file|->",
		"awf spec complete <issue> --input <file|->",
		"awf create wayfinder --input <file|->",
		"awf create task --input <file|->",
		"awf create grilling --input <file|->",
		"awf task start <issue>",
		"awf task fail <issue>",
		"awf task recover <issue>",
		"awf task escalate <issue>",
	]);
	expect(description.readiness?.filters).toEqual(help.readiness.filters);
});

it("should block Integration-test Task readiness until implementation-gate child Tasks are done", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "none" },
				relationships: { children: ["open-task", "integration-test"] },
			},
			{
				id: "open-task",
				title: "Open Task",
				workflow: {
					kind: "task",
					state: "ready",
					action: "work",
					data: { profile: "implement" },
				},
				relationships: { parent: "spec" },
			},
			{
				id: "integration-test",
				title: "Integration Test",
				workflow: {
					kind: "task",
					state: "ready",
					action: "work",
					data: { profile: "integration-test" },
				},
				relationships: { parent: "spec" },
			},
		],
	});

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
		blocked: Array<{ id: string; blocking: Array<Record<string, unknown>> }>;
	};

	expect(ready.items.map((item) => item.id)).toEqual(["open-task"]);
	expect(ready.blocked).toEqual([
		{
			id: "integration-test",
			title: "Integration Test",
			workflow: {
				kind: "task",
				state: "ready",
				action: "work",
				subkind: "work",
				profile: "integration-test",
			},
			blocking: [
				{
					gate: "implementation-gate",
					relationship: "siblings",
					blockedBy: [
						{
							id: "open-task",
							title: "Open Task",
							workflow: {
								kind: "task",
								state: "ready",
								action: "work",
								profile: "implement",
							},
						},
					],
				},
			],
		},
	]);
});

it("should block Merge Task readiness until implementation and integration-test Tasks are done", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "none" },
				relationships: {
					children: [
						"open-task",
						"open-integration",
						"done-integration",
						"merge",
					],
				},
			},
			{
				id: "open-task",
				title: "Open Task",
				workflow: {
					kind: "task",
					state: "ready",
					action: "work",
					data: { profile: "review" },
				},
				relationships: { parent: "spec" },
			},
			{
				id: "open-integration",
				title: "Open Integration",
				workflow: {
					kind: "task",
					state: "ready",
					action: "work",
					data: { profile: "integration-test" },
				},
				relationships: { parent: "spec" },
			},
			{
				id: "done-integration",
				title: "Done Integration",
				workflow: {
					kind: "task",
					state: "done",
					action: "none",
					data: { profile: "integration-test" },
				},
				relationships: { parent: "spec" },
			},
			{
				id: "merge",
				title: "Merge",
				workflow: {
					kind: "task",
					state: "ready",
					action: "work",
					data: { profile: "merge" },
				},
				relationships: { parent: "spec" },
			},
		],
	});

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
		blocked: Array<{ id: string; blocking: Array<Record<string, unknown>> }>;
	};

	expect(ready.items.map((item) => item.id)).toEqual(["open-task"]);
	expect(ready.blocked).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "merge",
				blocking: expect.arrayContaining([
					expect.objectContaining({
						gate: "implementation-gate",
						blockedBy: [expect.objectContaining({ id: "open-task" })],
					}),
					expect.objectContaining({
						gate: "integration-test-done",
						blockedBy: [expect.objectContaining({ id: "open-integration" })],
					}),
				]),
			}),
		]),
	);
});

it("should leave planned Specs at ready none after child Tasks complete", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "spec",
				title: "Spec",
				workflow: { kind: "spec", state: "ready", action: "none" },
				relationships: { children: ["task"] },
			},
			{
				id: "task",
				title: "Task",
				workflow: { kind: "task", state: "ready", action: "work" },
				relationships: { parent: "spec" },
			},
		],
	});
	assertSuccess(await execute(["run-command", "start", "task"], { tracker }));
	assertSuccess(
		await execute(["run-command", "succeed", "task", "--input", "-"], {
			tracker,
			stdin: "{}",
		}),
	);

	expect((await tracker.getIssue("task")).workflow).toMatchObject({
		kind: "task",
		state: "done",
		action: "none",
	});
	expect((await tracker.getIssue("spec")).workflow).toMatchObject({
		kind: "spec",
		state: "ready",
		action: "none",
	});

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
	};
	expect(ready.items.map((item) => item.id)).toEqual([]);
});

it("should validate the bundled agent-workflow module through the manifest validate command", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-agent-workflow-validate-"));
	const configPath = join(cwd, "awf.config.ts");
	await writeFile(
		configPath,
		`export { agentWorkflowManifest as manifest } from "${join(process.cwd(), "src/workflows/agent-workflow/index.ts")}";\n`,
	);

	expect(await validateManifestCommand(configPath)).toEqual({
		ok: true,
		data: {
			manifest: "agent-workflow",
			version: "v1",
			kinds: ["spec", "wayfinder", "task", "grilling"],
		},
	});
});

it("should create agent-workflow Specs from structured JSON ready for planning with creation log", async () => {
	const tracker = createInMemoryTracker();

	const created = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Write the spec",
				content: "# Write the spec\n\nDefine the work in Markdown.",
			}),
		}),
	) as {
		issue: {
			id: string;
			title: string;
			body: string;
			workflow: Record<string, string>;
		};
		log: { type: string; message: string };
	};

	expect(created.issue.title).toBe("Write the spec");
	expect(created.issue.body).toBe(
		"# Write the spec\n\nDefine the work in Markdown.",
	);
	expect(created.issue.workflow).toMatchObject({
		kind: "spec",
		state: "ready",
		action: "planning",
	});
	expect(created.log.type).toBe("spec-create_created");
	expect(JSON.parse(created.log.message)).toEqual({
		input: {
			title: "Write the spec",
			content: "# Write the spec\n\nDefine the work in Markdown.",
		},
	});
	expect(
		(await tracker.readLogs(created.issue.id)).map((log) => log.type),
	).toEqual(["spec-create_created"]);
});

it("should complete agent-workflow Specs only after merge work is done", async () => {
	const tracker = createInMemoryTracker();
	const created = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["run-command", "start", created.issue.id], { tracker }),
	);
	expect(
		assertSuccess(
			await execute(
				["run-command", "succeed", created.issue.id, "--input", "-"],
				{ tracker, stdin: "{}" },
			),
		) as { issue: { workflow: Record<string, string> } },
	).toMatchObject({ issue: { workflow: { state: "ready", action: "none" } } });

	const task = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: created.issue.id,
				title: "Task",
				description: "Implement it.",
				profile: "implement",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["run-command", "start", task.issue.id], { tracker }),
	);
	assertSuccess(
		await execute(["run-command", "succeed", task.issue.id, "--input", "-"], {
			tracker,
			stdin: "{}",
		}),
	);
	expect((await tracker.getIssue(created.issue.id)).workflow).toMatchObject({
		state: "ready",
		action: "none",
	});
	const blockedComplete = await execute(
		["spec", "complete", created.issue.id],
		{
			tracker,
		},
	);
	expect(blockedComplete.ok).toBe(false);

	const integrationTest = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: created.issue.id,
				title: "Integration test",
				description: "Verify it.",
				profile: "integration-test",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["task", "start", integrationTest.issue.id], { tracker }),
	);
	assertSuccess(
		await execute(
			["run-command", "succeed", integrationTest.issue.id, "--input", "-"],
			{
				tracker,
				stdin: "{}",
			},
		),
	);
	const merge = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: created.issue.id,
				title: "Merge",
				description: "Merge it.",
				profile: "merge",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(await execute(["task", "start", merge.issue.id], { tracker }));
	assertSuccess(
		await execute(["run-command", "succeed", merge.issue.id, "--input", "-"], {
			tracker,
			stdin: "{}",
		}),
	);
	expect(
		assertSuccess(
			await execute(["spec", "complete", created.issue.id], { tracker }),
		) as {
			issue: { workflow: Record<string, string> };
		},
	).toMatchObject({ issue: { workflow: { state: "done", action: "none" } } });
});

it("should reject malformed agent-workflow Spec create input before tracker mutation", async () => {
	const tracker = createInMemoryTracker();

	const envelope = await execute(["create", "spec", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({ content: "# Missing title" }),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should create agent-workflow Tasks under Specs with routing profiles and dependencies", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Spec",
				content: "# Spec\n\nBuild the thing.",
			}),
		}),
	) as { issue: { id: string } };
	const blocker = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Set up",
				description: "Prepare the work.",
				profile: "implement",
			}),
		}),
	) as { issue: { id: string } };

	const created = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Do the work",
				description: "Complete the generic task.",
				profile: "implement",
				dependsOn: [blocker.issue.id],
			}),
		}),
	) as {
		issue: {
			id: string;
			body: string;
			workflow: Record<string, string>;
			relationships: { parent?: string; dependencies: Array<string> };
		};
		log: { message: string };
	};

	expect(created.issue.body).toContain("Profile: implement");
	expect(created.issue.workflow).toMatchObject({
		data: { subkind: "work", profile: "implement" },
		kind: "task",
		state: "ready",
		action: "work",
	});
	expect(created.issue.relationships.parent).toBe(spec.issue.id);
	expect(created.issue.relationships.dependencies).toEqual([blocker.issue.id]);
	expect(
		(await tracker.getIssue(spec.issue.id)).relationships.children,
	).toEqual([blocker.issue.id, created.issue.id]);
	expect(
		(await tracker.getIssue(blocker.issue.id)).relationships.dependents,
	).toEqual([created.issue.id]);

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
		blocked: Array<{ id: string; blocking: Array<Record<string, unknown>> }>;
	};
	expect(ready.items.map((item) => item.id)).toContain(blocker.issue.id);
	expect(ready.blocked).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: created.issue.id,
				blocking: [
					expect.objectContaining({
						gate: "dependency",
						blockedBy: [expect.objectContaining({ id: blocker.issue.id })],
					}),
				],
			}),
		]),
	);
});

it("should store Task subkind as workflow data without changing lifecycle readiness", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };

	const research = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Research",
				description: "Research the approach.",
				profile: "implement",
				subkind: "research",
			}),
		}),
	) as { issue: { id: string; workflow: Record<string, unknown> } };

	expect(research.issue.workflow).toMatchObject({
		kind: "task",
		state: "ready",
		action: "work",
		data: { subkind: "research" },
	});
	expect(research.issue.workflow).not.toHaveProperty("subkind");

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string; workflow: Record<string, unknown> }>;
	};
	const readyResearch = ready.items.find(
		(item) => item.id === research.issue.id,
	);
	expect(readyResearch?.workflow).toMatchObject({
		kind: "task",
		state: "ready",
		action: "work",
		subkind: "research",
	});
	expect(readyResearch?.workflow).not.toHaveProperty("data");
});

it("should create Tasks and Specs under Wayfinder maps without offering the Wayfinder as autonomous ready work", async () => {
	const tracker = createInMemoryTracker();
	const wayfinder = assertSuccess(
		await execute(["create", "wayfinder", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Map", content: "# Explore" }),
		}),
	) as { issue: { id: string } };

	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Route spec",
				content: "# Build this route",
				parent: wayfinder.issue.id,
			}),
		}),
	) as { issue: { id: string; relationships: { parent?: string } } };
	const task = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				parent: wayfinder.issue.id,
				title: "Explore route",
				description: "Research the route.",
				profile: "research",
				subkind: "research",
			}),
		}),
	) as { issue: { id: string; relationships: { parent?: string } } };

	expect(spec.issue.relationships.parent).toBe(wayfinder.issue.id);
	expect(task.issue.relationships.parent).toBe(wayfinder.issue.id);
	expect(
		(await tracker.getIssue(wayfinder.issue.id)).relationships.children,
	).toEqual([spec.issue.id, task.issue.id]);

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
	};
	expect(ready.items.map((item) => item.id)).not.toContain(wayfinder.issue.id);
	expect(ready.items.map((item) => item.id)).toContain(task.issue.id);
});

it("should complete Wayfinder maps only by explicit success after all children are done", async () => {
	const tracker = createInMemoryTracker();
	const wayfinder = assertSuccess(
		await execute(["create", "wayfinder", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Map", content: "# Explore" }),
		}),
	) as { issue: { id: string } };
	const task = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				parent: wayfinder.issue.id,
				title: "Explore route",
				description: "Research the route.",
				profile: "research",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["run-command", "start", wayfinder.issue.id], { tracker }),
	);
	const blocked = await execute(
		["run-command", "succeed", wayfinder.issue.id, "--input", "-"],
		{ tracker, stdin: "{}" },
	);
	expect(blocked).toMatchObject({
		ok: false,
		error: { code: "WAYFINDER_CHILDREN_INCOMPLETE" },
	});

	assertSuccess(
		await execute(["run-command", "start", task.issue.id], { tracker }),
	);
	assertSuccess(
		await execute(["run-command", "succeed", task.issue.id, "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				outcome: { type: "completed", facts: ["Explored the route."] },
			}),
		}),
	);
	expect((await tracker.getIssue(wayfinder.issue.id)).workflow).toMatchObject({
		kind: "wayfinder",
		state: "running",
		action: "planning",
	});

	const done = assertSuccess(
		await execute(
			["run-command", "succeed", wayfinder.issue.id, "--input", "-"],
			{ tracker, stdin: "{}" },
		),
	) as { issue: { workflow: Record<string, string> } };
	expect(done.issue.workflow).toMatchObject({
		kind: "wayfinder",
		state: "done",
		action: "none",
	});
});

it("should validate Wayfinder child terminal outcomes and allow coarse map body revisions", async () => {
	const tracker = createInMemoryTracker();
	const wayfinder = assertSuccess(
		await execute(["create", "wayfinder", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Map", content: "# Old map" }),
		}),
	) as { issue: { id: string } };
	const task = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				parent: wayfinder.issue.id,
				title: "Explore",
				description: "Explore route.",
				profile: "research",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["run-command", "start", task.issue.id], { tracker }),
	);
	const missing = await execute(["run-command", "succeed", task.issue.id], {
		tracker,
	});
	expect(missing).toMatchObject({
		ok: false,
		error: { code: "WAYFINDER_CHILD_OUTCOME_INVALID" },
	});

	const completed = assertSuccess(
		await execute(["run-command", "succeed", task.issue.id, "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				outcome: { type: "completed", facts: ["Found the shortest route."] },
				mapRevision: { body: "# Updated map" },
			}),
		}),
	) as { log: { message: string } };
	expect(JSON.parse(completed.log.message).input.outcome).toEqual({
		type: "completed",
		facts: ["Found the shortest route."],
	});
	expect((await tracker.getIssue(wayfinder.issue.id)).body).toBe(
		"# Updated map",
	);

	const grilling = assertSuccess(
		await execute(["create", "grilling", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				parent: wayfinder.issue.id,
				title: "Decide",
				description: "Resolve a decision.",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["run-command", "start", grilling.issue.id], { tracker }),
	);
	assertSuccess(
		await execute(
			["run-command", "succeed", grilling.issue.id, "--input", "-"],
			{
				tracker,
				stdin: JSON.stringify({
					outcome: {
						type: "decision",
						resolution: "Use the simpler route.",
						gist: "Simplicity beats coverage for now.",
					},
				}),
			},
		),
	);

	const outOfScopeTask = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				parent: wayfinder.issue.id,
				title: "Ignore",
				description: "Check unrelated route.",
				profile: "research",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["run-command", "start", outOfScopeTask.issue.id], {
			tracker,
		}),
	);
	assertSuccess(
		await execute(
			["run-command", "succeed", outOfScopeTask.issue.id, "--input", "-"],
			{
				tracker,
				stdin: JSON.stringify({
					outcome: { type: "out-of-scope", scopeNote: "Owned by another map." },
				}),
			},
		),
	);
});

it("should create Grilling as collaborative work without offering it as autonomous ready work", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };
	const wayfinder = assertSuccess(
		await execute(["create", "wayfinder", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Wayfinder", content: "# Explore" }),
		}),
	) as { issue: { id: string } };

	const standalone = assertSuccess(
		await execute(["create", "grilling", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Pressure-test",
				description: "Pressure-test the decision.",
			}),
		}),
	) as {
		issue: {
			id: string;
			workflow: Record<string, unknown>;
			relationships: { parent?: string };
		};
	};
	const specChild = assertSuccess(
		await execute(["create", "grilling", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Spec questions",
				description: "Resolve spec questions.",
				parent: spec.issue.id,
			}),
		}),
	) as { issue: { id: string; relationships: { parent?: string } } };
	const wayfinderChild = assertSuccess(
		await execute(["create", "grilling", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Explore questions",
				description: "Resolve exploration questions.",
				parent: wayfinder.issue.id,
			}),
		}),
	) as { issue: { id: string; relationships: { parent?: string } } };

	expect(standalone.issue.workflow).toMatchObject({
		kind: "grilling",
		state: "ready",
		action: "discuss",
	});
	expect(standalone.issue.workflow).not.toHaveProperty("data.subkind");
	expect(standalone.issue.relationships.parent).toBeUndefined();
	expect(specChild.issue.relationships.parent).toBe(spec.issue.id);
	expect(wayfinderChild.issue.relationships.parent).toBe(wayfinder.issue.id);

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string; workflow: Record<string, unknown> }>;
	};
	expect(ready.items.map((item) => item.id)).not.toContain(standalone.issue.id);

	const started = assertSuccess(
		await execute(["run-command", "start", standalone.issue.id], { tracker }),
	) as { issue: { workflow: Record<string, unknown> } };
	expect(started.issue.workflow).toMatchObject({
		kind: "grilling",
		state: "in-discussion",
		action: "discuss",
	});

	const done = assertSuccess(
		await execute(["run-command", "succeed", standalone.issue.id], {
			tracker,
		}),
	) as { issue: { workflow: Record<string, unknown> } };
	expect(done.issue.workflow).toMatchObject({
		kind: "grilling",
		state: "done",
		action: "none",
	});
});

it("should reject Grilling parents that are not Spec or Wayfinder issues", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };
	const task = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Task",
				description: "Do work.",
				profile: "implement",
			}),
		}),
	) as { issue: { id: string } };

	const rejected = await execute(["create", "grilling", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({
			title: "Invalid",
			description: "Invalid parent.",
			parent: task.issue.id,
		}),
	});

	expect(rejected).toMatchObject({
		ok: false,
		error: { code: "INVALID_GRILLING_PARENT" },
	});
});

it("should declare generated agent-workflow Task provenance separately from containment and dependencies", () => {
	const relationships = agentWorkflowManifest.relationships?.map(
		(relationship) => ({
			id: relationship.id,
			projection: relationship.projection.type,
		}),
	);

	expect(relationships).toEqual(
		expect.arrayContaining([
			{ id: "spec-task", projection: "parent-child" },
			{ id: "task-blocks-task", projection: "dependency" },
			{ id: "task-generated-by-task", projection: "generated-by" },
		]),
	);
});

it("should record generated agent-workflow Task provenance without blocking readiness", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };
	const source = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Find follow-up",
				description: "Identify follow-up work.",
				profile: "research",
			}),
		}),
	) as { issue: { id: string } };

	const created = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Follow up",
				description: "Do generated work.",
				profile: "implement",
				generatedBy: source.issue.id,
			}),
		}),
	) as {
		issue: {
			id: string;
			relationships: {
				parent?: string;
				generatedBy?: string;
				dependencies: Array<string>;
			};
		};
	};

	expect(created.issue.relationships.parent).toBe(spec.issue.id);
	expect(created.issue.relationships.generatedBy).toBe(source.issue.id);
	expect(created.issue.relationships.dependencies).toEqual([]);
	expect(
		(await tracker.getIssue(source.issue.id)).relationships.dependents,
	).toEqual([]);

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
		blocked?: Array<{ id: string }>;
	};
	expect(ready.items.map((item) => item.id)).toEqual(
		expect.arrayContaining([source.issue.id, created.issue.id]),
	);
	expect(ready.blocked?.map((item) => item.id) ?? []).not.toContain(
		created.issue.id,
	);
});

it("should reject invalid agent-workflow Task create relationships before tracker mutation", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };
	const notTask = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Other Spec", content: "# Other" }),
		}),
	) as { issue: { id: string } };
	const otherSpecTask = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: notTask.issue.id,
				title: "Other spec task",
				description: "Wrong Spec.",
				profile: "implement",
			}),
		}),
	) as { issue: { id: string } };

	for (const input of [
		{
			spec: "missing",
			title: "Bad spec",
			description: "No mutation.",
			profile: "implement",
		},
		{
			spec: spec.issue.id,
			title: "Bad dependency",
			description: "No mutation.",
			profile: "implement",
			dependsOn: ["missing"],
		},
		{
			spec: spec.issue.id,
			title: "Non-task dependency",
			description: "No mutation.",
			profile: "implement",
			dependsOn: [notTask.issue.id],
		},
		{
			spec: spec.issue.id,
			title: "Non-task generated source",
			description: "No mutation.",
			profile: "implement",
			generatedBy: notTask.issue.id,
		},
		{
			spec: spec.issue.id,
			title: "Cross-Spec generated source",
			description: "No mutation.",
			profile: "implement",
			generatedBy: otherSpecTask.issue.id,
		},
	]) {
		const before = await tracker.listIssues();
		const envelope = await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify(input),
		});

		expect(envelope.ok).toBe(false);
		expect(await tracker.listIssues()).toEqual(before);
	}
});

it("should reject missing agent-workflow Task create fields before tracker mutation", async () => {
	const tracker = createInMemoryTracker();

	const envelope = await execute(["create", "task", "--input", "-"], {
		tracker,
		stdin: JSON.stringify({ title: "Missing fields" }),
	});

	expect(envelope.ok).toBe(false);
	expect(envelope.ok ? undefined : envelope.error.code).toBe(
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	expect(await tracker.listIssues()).toEqual([]);
});

it("should run agent-workflow Task start, succeed, fail, recover, and escalate transitions through manifest commands", async () => {
	const tracker = createInMemoryTracker();
	const spec = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };
	const created = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Do the work",
				description: "Complete the generic task.",
				profile: "implement",
			}),
		}),
	) as { issue: { id: string; workflow: Record<string, string> } };

	expect(created.issue.workflow).toMatchObject({
		kind: "task",
		state: "ready",
		action: "work",
	});

	const started = assertSuccess(
		await execute(["task", "start", created.issue.id], { tracker }),
	) as {
		issue: { workflow: Record<string, string> };
		log: { type: string; message: string };
	};
	expect(started.issue.workflow).toMatchObject({
		state: "running",
		action: "work",
	});
	expect(started.log).toMatchObject({
		type: "command",
		message: "Applied start.",
	});
	expect(started.log.message.startsWith("{")).toBe(false);

	expect(
		assertSuccess(
			await execute(
				["run-command", "succeed", created.issue.id, "--input", "-"],
				{ tracker, stdin: "{}" },
			),
		) as { issue: { workflow: Record<string, string> } },
	).toMatchObject({ issue: { workflow: { state: "done", action: "none" } } });

	const failedTask = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				spec: spec.issue.id,
				title: "Needs help",
				description: "Exercise the failure transition.",
				profile: "implement",
			}),
		}),
	) as { issue: { id: string } };
	assertSuccess(
		await execute(["task", "start", failedTask.issue.id], { tracker }),
	);
	const failed = assertSuccess(
		await execute(["task", "fail", failedTask.issue.id], {
			tracker,
		}),
	) as {
		issue: { workflow: Record<string, string> };
		log: { message: string };
	};
	expect(failed).toMatchObject({
		issue: { workflow: { state: "need-human", action: "none" } },
		log: { message: "Applied fail." },
	});
	expect(failed.log.message.startsWith("{")).toBe(false);

	const recovered = assertSuccess(
		await execute(["task", "recover", failedTask.issue.id], { tracker }),
	) as { issue: { workflow: Record<string, string> } };
	expect(recovered).toMatchObject({
		issue: { workflow: { state: "ready", action: "work" } },
	});

	assertSuccess(
		await execute(["run-command", "start", failedTask.issue.id], { tracker }),
	);
	expect(
		assertSuccess(
			await execute(["task", "escalate", failedTask.issue.id], { tracker }),
		) as {
			issue: { workflow: Record<string, string> };
			log: { message: string };
		},
	).toMatchObject({
		issue: { workflow: { state: "need-human", action: "none" } },
		log: {
			message: "Applied escalate.",
		},
	});
});
