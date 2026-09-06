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
	expect(genericTaskCommandHandlers).toEqual({});
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

it("should create generic Tasks and run basic start, succeed, and fail transitions", async () => {
	const tracker = createInMemoryTracker();
	const created = assertSuccess(
		await execute(["create", "task", "--input", "-"], {
			tracker,
			stdin: JSON.stringify({
				title: "Do the work",
				body: "Complete the generic task.",
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
			stdin: JSON.stringify({ title: "Needs help" }),
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
