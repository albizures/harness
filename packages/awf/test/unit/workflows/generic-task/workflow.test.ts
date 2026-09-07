import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execute as rawExecute } from "../../../../src/commands.ts";
import { validateManifestCommand } from "../../../../src/commands/manifest-validate.ts";
import { validateManifest } from "../../../../src/manifest/index.ts";
import { createInMemoryTracker } from "../../../../src/trackers/memory.ts";
import type { Envelope } from "../../../../src/envelope.ts";
import {
	agentWorkflowCommandHandlers,
	agentWorkflowLifecycleHandlers,
	agentWorkflowManifest,
} from "../../../../src/workflows/agent-workflow/index.ts";
import {
	commandHandlers,
	genericTaskCommandHandlers,
	genericTaskLifecycleHandlers,
	genericTaskManifest,
	lifecycleHandlers,
	manifest,
} from "../../../../src/workflows/generic-task/index.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: genericTaskManifest, ...options });
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
	expect(manifest).toBe(genericTaskManifest);
	expect(agentWorkflowManifest).toBe(genericTaskManifest);
	expect(commandHandlers).toBe(genericTaskCommandHandlers);
	expect(agentWorkflowCommandHandlers).toBe(genericTaskCommandHandlers);
	expect(lifecycleHandlers).toBe(genericTaskLifecycleHandlers);
	expect(agentWorkflowLifecycleHandlers).toBe(genericTaskLifecycleHandlers);
	expect(Object.keys(genericTaskCommandHandlers)).toEqual([
		"task-create",
		"grilling-create",
	]);
	expect(genericTaskLifecycleHandlers).toEqual({});
	expect(validateManifest(genericTaskManifest)).toEqual([]);
	expect(genericTaskManifest.workflow.id).toBe("agent-workflow");
	expect(genericTaskManifest.vocabulary).toEqual({
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
		reasons: [],
		events: ["start", "succeed", "fail", "pause", "respond"],
	});
	expect(genericTaskManifest.kinds.map((kind) => kind.id)).toEqual([
		"spec",
		"wayfinder",
		"task",
		"grilling",
	]);
	expect(
		genericTaskManifest.kinds.find((kind) => kind.id === "task")?.subkinds,
	).toEqual(["work", "research", "prototype"]);
	expect(
		genericTaskManifest.kinds.find((kind) => kind.id === "grilling")?.subkinds,
	).toBeUndefined();
	expect(genericTaskManifest.commands.map((command) => command.id)).toEqual([
		"spec-create",
		"wayfinder-create",
		"task-create",
		"grilling-create",
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
			"awf start <id>",
			"awf succeed <id> --run <run> --input <file|->",
			"awf fail <id> --run <run> --input <file|->",
		]),
	);
	expect(help.readiness.filters).toEqual([
		{ kind: "spec", state: "ready", action: "planning" },
		{ kind: "spec", state: "ready", action: "integration-test" },
		{ kind: "spec", state: "ready", action: "merge" },
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
	expect(description.commands.map((command) => command.cli.usage)).toEqual([
		"awf create spec --input <file|->",
		"awf create wayfinder --input <file|->",
		"awf create task --input <file|->",
		"awf create grilling --input <file|->",
	]);
	expect(description.readiness?.filters).toEqual(help.readiness.filters);
});

it("should block Spec integration-test readiness until child Tasks are done", async () => {
	const tracker = createInMemoryTracker({
		issues: [
			{
				id: "empty-spec",
				title: "Empty Spec",
				workflow: { kind: "spec", state: "ready", action: "integration-test" },
			},
			{
				id: "blocked-spec",
				title: "Blocked Spec",
				workflow: { kind: "spec", state: "ready", action: "integration-test" },
				relationships: { children: ["open-task"] },
			},
			{
				id: "done-spec",
				title: "Done Spec",
				workflow: { kind: "spec", state: "ready", action: "integration-test" },
				relationships: { children: ["done-task"] },
			},
			{
				id: "open-task",
				title: "Open Task",
				workflow: { kind: "task", state: "ready", action: "work" },
				relationships: { parent: "blocked-spec" },
			},
			{
				id: "done-task",
				title: "Done Task",
				workflow: { kind: "task", state: "done", action: "none" },
				relationships: { parent: "done-spec" },
			},
		],
	});

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
		blocked: Array<{ id: string; blocking: Array<Record<string, unknown>> }>;
	};

	expect(ready.items.map((item) => item.id)).toEqual([
		"done-spec",
		"open-task",
	]);
	expect(ready.blocked).toEqual([
		{
			id: "blocked-spec",
			title: "Blocked Spec",
			workflow: { kind: "spec", state: "ready", action: "integration-test" },
			blocking: [
				{
					gate: "tasks-done",
					relationship: "children",
					minimum: 1,
					blockedBy: [
						{
							id: "open-task",
							title: "Open Task",
							workflow: { kind: "task", state: "ready", action: "work" },
						},
					],
				},
			],
		},
		{
			id: "empty-spec",
			title: "Empty Spec",
			workflow: { kind: "spec", state: "ready", action: "integration-test" },
			blocking: [
				{
					gate: "tasks-done",
					relationship: "children",
					minimum: 1,
				},
			],
		},
	]);
});

it("should advance a planned Spec to integration-test readiness after child Tasks complete", async () => {
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

	const started = assertSuccess(
		await execute(["start", "task"], { tracker }),
	) as {
		run: { id: string };
	};
	assertSuccess(
		await execute(
			["succeed", "task", "--run", started.run.id, "--input", "-"],
			{
				tracker,
				stdin: "{}",
			},
		),
	);

	expect((await tracker.getIssue("task")).workflow).toMatchObject({
		kind: "task",
		state: "done",
		action: "none",
	});
	expect((await tracker.getIssue("spec")).workflow).toMatchObject({
		kind: "spec",
		state: "ready",
		action: "integration-test",
	});

	const ready = assertSuccess(await execute(["ready"], { tracker })) as {
		items: Array<{ id: string }>;
	};
	expect(ready.items.map((item) => item.id)).toEqual(["spec"]);
});

it("should validate the bundled agent-workflow module through the manifest validate command", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-agent-workflow-validate-"));
	const configPath = join(cwd, "awf.config.ts");
	await writeFile(
		configPath,
		`export { genericTaskManifest as manifest } from "${join(process.cwd(), "src/workflows/generic-task/index.ts")}";\n`,
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

it("should create generic Specs from structured JSON ready for planning with creation log", async () => {
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
		log: { type: string; payload: unknown };
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
	expect(created.log).toMatchObject({
		type: "spec-create_created",
		payload: {
			input: {
				title: "Write the spec",
				content: "# Write the spec\n\nDefine the work in Markdown.",
			},
		},
	});
	expect(
		(await tracker.readLogs(created.issue.id)).map((log) => log.type),
	).toEqual(["spec-create_created"]);
});

it("should advance generic Specs through planning, integration-test, merge, and done", async () => {
	const tracker = createInMemoryTracker();
	const created = assertSuccess(
		await execute(["create", "spec", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({ title: "Spec", content: "# Spec" }),
		}),
	) as { issue: { id: string } };

	const planningRun = assertSuccess(
		await execute(["start", created.issue.id], { tracker }),
	) as { run: { id: string } };
	expect(
		assertSuccess(
			await execute(
				[
					"succeed",
					created.issue.id,
					"--run",
					planningRun.run.id,
					"--input",
					"-",
				],
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
	const taskRun = assertSuccess(
		await execute(["start", task.issue.id], { tracker }),
	) as {
		run: { id: string };
	};
	assertSuccess(
		await execute(
			["succeed", task.issue.id, "--run", taskRun.run.id, "--input", "-"],
			{
				tracker,
				stdin: "{}",
			},
		),
	);
	expect((await tracker.getIssue(created.issue.id)).workflow).toMatchObject({
		state: "ready",
		action: "integration-test",
	});

	const integrationRun = assertSuccess(
		await execute(["start", created.issue.id], { tracker }),
	) as { run: { id: string } };
	expect(
		assertSuccess(
			await execute(
				[
					"succeed",
					created.issue.id,
					"--run",
					integrationRun.run.id,
					"--input",
					"-",
				],
				{ tracker, stdin: "{}" },
			),
		) as { issue: { workflow: Record<string, string> } },
	).toMatchObject({ issue: { workflow: { state: "ready", action: "merge" } } });

	const mergeRun = assertSuccess(
		await execute(["start", created.issue.id], { tracker }),
	) as { run: { id: string } };
	expect(
		assertSuccess(
			await execute(
				["succeed", created.issue.id, "--run", mergeRun.run.id, "--input", "-"],
				{ tracker, stdin: "{}" },
			),
		) as { issue: { workflow: Record<string, string> } },
	).toMatchObject({ issue: { workflow: { state: "done", action: "none" } } });
});

it("should reject malformed generic Spec create input before tracker mutation", async () => {
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

it("should create generic Tasks under Specs with routing profiles and dependencies", async () => {
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
		log: { payload: unknown };
	};

	expect(created.issue.body).toContain("Profile: implement");
	expect(created.issue.workflow).toMatchObject({
		data: { subkind: "work" },
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
		await execute(["start", standalone.issue.id], { tracker }),
	) as { issue: { workflow: Record<string, unknown> }; run: { id: string } };
	expect(started.issue.workflow).toMatchObject({
		kind: "grilling",
		state: "in-discussion",
		action: "discuss",
	});

	const done = assertSuccess(
		await execute(["succeed", standalone.issue.id, "--run", started.run.id], {
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

it("should record generated generic Task provenance without blocking readiness", async () => {
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

it("should reject invalid generic Task create relationships before tracker mutation", async () => {
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

it("should reject missing generic Task create fields before tracker mutation", async () => {
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

it("should run generic Task basic start, succeed, and fail transitions", async () => {
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
		await execute(["start", created.issue.id], { tracker }),
	) as {
		run: { id: string };
		issue: { workflow: Record<string, string> };
	};
	expect(started.issue.workflow).toMatchObject({
		state: "running",
		action: "work",
	});

	expect(
		assertSuccess(
			await execute(
				["succeed", created.issue.id, "--run", started.run.id, "--input", "-"],
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
	const failedRun = assertSuccess(
		await execute(["start", failedTask.issue.id], { tracker }),
	) as {
		run: { id: string };
	};
	expect(
		assertSuccess(
			await execute(
				[
					"fail",
					failedTask.issue.id,
					"--run",
					failedRun.run.id,
					"--input",
					"-",
				],
				{ tracker, stdin: "{}" },
			),
		) as { issue: { workflow: Record<string, string> } },
	).toMatchObject({
		issue: { workflow: { state: "need-human", action: "none" } },
	});
});
