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
	expect(commandHandlers).toBe(genericTaskCommandHandlers);
	expect(lifecycleHandlers).toBe(genericTaskLifecycleHandlers);
	expect(Object.keys(genericTaskCommandHandlers)).toEqual(["task-create"]);
	expect(genericTaskLifecycleHandlers).toEqual({});
	expect(validateManifest(genericTaskManifest)).toEqual([]);
	expect(genericTaskManifest.workflow.id).toBe("generic-task");
	expect(genericTaskManifest.vocabulary).toEqual({
		states: ["ready", "running", "done", "need-human"],
		actions: ["work", "none"],
		reasons: [],
		events: ["start", "succeed", "fail"],
	});
	expect(genericTaskManifest.kinds.map((kind) => kind.id)).toEqual([
		"spec",
		"task",
	]);
	expect(genericTaskManifest.commands.map((command) => command.id)).toEqual([
		"spec-create",
		"task-create",
	]);
});

it("should expose Spec and Task work lifecycle through help and describe surfaces", async () => {
	const help = assertSuccess(await execute(["--help"])) as {
		commands: Array<{ usage: string }>;
		readiness: { filters: Array<Record<string, string>> };
	};
	expect(help.commands.map((command) => command.usage)).toEqual(
		expect.arrayContaining([
			"awf create spec --input <file|->",
			"awf create task --input <file|->",
			"awf start <id>",
			"awf succeed <id> --run <run> --input <file|->",
			"awf fail <id> --run <run> --input <file|->",
		]),
	);
	expect(help.readiness.filters).toEqual([
		{ kind: "spec", state: "ready", action: "work" },
		{ kind: "task", state: "ready", action: "work" },
	]);

	const description = assertSuccess(
		await execute(["workflow", "describe"]),
	) as {
		workflow: { id: string };
		kinds: Array<{ id: string; initial: Record<string, string> }>;
		commands: Array<{ id: string; cli: { usage: string } }>;
		readiness?: { filters: Array<Record<string, string>> };
	};
	expect(description.workflow.id).toBe("generic-task");
	expect(description.kinds).toMatchObject([
		{ id: "spec", initial: { state: "ready", action: "work" } },
		{ id: "task", initial: { state: "ready", action: "work" } },
	]);
	expect(description.commands.map((command) => command.cli.usage)).toEqual([
		"awf create spec --input <file|->",
		"awf create task --input <file|->",
	]);
	expect(description.readiness?.filters).toEqual(help.readiness.filters);
});

it("should validate the bundled generic-task module through the manifest validate command", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "awf-generic-task-validate-"));
	const configPath = join(cwd, "awf.config.ts");
	await writeFile(
		configPath,
		`export { genericTaskManifest as manifest } from "${join(process.cwd(), "src/workflows/generic-task/index.ts")}";\n`,
	);

	expect(await validateManifestCommand(configPath)).toEqual({
		ok: true,
		data: { manifest: "generic-task", version: "v1", kinds: ["spec", "task"] },
	});
});

it("should create generic Specs from structured JSON with initial workflow fields and creation log", async () => {
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
		action: "work",
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
	expect(ready.blocked).toEqual([
		expect.objectContaining({
			id: created.issue.id,
			blocking: [
				expect.objectContaining({
					gate: "dependency",
					blockedBy: [expect.objectContaining({ id: blocker.issue.id })],
				}),
			],
		}),
	]);
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
