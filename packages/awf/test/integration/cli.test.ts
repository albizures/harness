import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const cliPath = new URL("../../src/cli.ts", import.meta.url);
const validManifestPath = new URL(
	"../fixtures/valid.workflow.ts",
	import.meta.url,
).pathname;
const badManifestPath = new URL("../fixtures/bad.workflow.ts", import.meta.url)
	.pathname;
const linkManifestPath = new URL(
	"../fixtures/link.workflow.ts",
	import.meta.url,
).pathname;
const envMemoryWorkflowPath = new URL(
	"../fixtures/env-memory.workflow.ts",
	import.meta.url,
).pathname;
const missingManifestPath = new URL(
	"../fixtures/missing-manifest.workflow.ts",
	import.meta.url,
).pathname;
const agentWorkflowSourcePath = new URL(
	"../../src/workflows/agent-workflow/index.ts",
	import.meta.url,
).pathname;
const memoryTrackerSourcePath = new URL(
	"../../src/adapters/trackers/memory.ts",
	import.meta.url,
).pathname;
const filesystemTrackerSourcePath = new URL(
	"../../src/adapters/trackers/filesystem.ts",
	import.meta.url,
).pathname;
const agentWorkflowSkillPath = new URL(
	"../../../../skills/workflow/agent-workflow/SKILL.md",
	import.meta.url,
).pathname;
const toSpecSkillPath = new URL(
	"../../../../skills/design/to-spec/SKILL.md",
	import.meta.url,
).pathname;
const toTicketsSkillPath = new URL(
	"../../../../skills/design/to-tickets/SKILL.md",
	import.meta.url,
).pathname;
const wayfinderSkillPath = new URL(
	"../../../../skills/design/wayfinder/SKILL.md",
	import.meta.url,
).pathname;

const unreadableMode = 0o000;
const ownerReadWriteMode = 0o600;
const bundledGoldenSmokeTimeoutMs = 15_000;
const externalLogCliTimeoutMs = 15_000;
const configLifecycleHandlerPrNumber = 42;
const inspectionLogCount = 6;
const inspectionRecentLogCount = 5;
const firstInspectionLogSequence = 1;
const inspectionRecentLogSequences = Array.from(
	{ length: inspectionRecentLogCount },
	(_, index) =>
		inspectionLogCount -
		inspectionRecentLogCount +
		firstInspectionLogSequence +
		index,
);

const prArtifact = (n: number) => ({
	type: "pull-request",
	url: `https://github.com/albizures/harness/pull/${n}`,
});

function serializeCliSmokeInput(input: unknown): string {
	return typeof input === "string" ? input : JSON.stringify(input);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "awf-cli-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function configWithMemoryIssue(id: string): string {
	return `import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker({ issues: [{
	id: ${JSON.stringify(id)},
	title: "Configured task",
	labels: [
		"awf:w1:kind:task",
		"awf:w1:state:ready",
		"awf:w1:action:work",
	],
}] });
`;
}

it("should ensure that CLI writes plain text to stdout by default", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", validManifestPath, "--help"],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("awf - Agent workflow CLI.");
	expect(result.stdout).toContain(
		"awf workflow describe  Describe the loaded workflow manifest.",
	);
	expect(result.stdout).toContain("Use --json for machine-readable output.");
});

it("should ensure that CLI writes awf get inspection output as Markdown by default", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "inspection.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker({ issues: [
	{
		id: "target",
		title: "Inspect target",
		body: ${JSON.stringify("Keep **Markdown** verbatim.\n\n- first\n- second")},
		workflow: { kind: "task", state: "running", action: "work" },
		relationships: {
			parent: "parent",
			children: ["child"],
			dependencies: ["dependency"],
			dependents: ["dependent"],
			generatedBy: "generator",
		},
		logs: [
			{ sequence: 1, type: "task-work-create_created", message: "created" },
			{ sequence: 2, type: "action_started", message: "started" },
			{ sequence: 3, type: "checkpoint", message: "one" },
			{ sequence: 4, type: "checkpoint", message: "two" },
			{ sequence: 5, type: "checkpoint", message: "three" },
			{ sequence: 6, type: "action_succeeded", message: "done" },
		],
	},
	{ id: "parent", title: "Parent spec", workflow: { kind: "spec", state: "ready", action: "planning" } },
	{ id: "child", title: "Child task", workflow: { kind: "task", state: "ready", action: "work" } },
	{ id: "dependency", title: "Dependency task", workflow: { kind: "task", state: "done", action: "none" } },
	{ id: "dependent", title: "Dependent task", workflow: { kind: "task", state: "ready", action: "work" } },
	{ id: "generator", title: "Generator task", workflow: { kind: "task", state: "done", action: "none" } },
] });
`,
		);
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--config", configPath, "get", "target"],
			{ cwd: dir, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(`# target Inspect target [task/running/work]

## Body

Keep **Markdown** verbatim.

- first
- second

## Relationships

### Parent

- parent Parent spec [spec/ready/planning]

### Children

- child Child task [task/ready/work]

### Dependencies

- dependency Dependency task [task/done]

### Dependents

- dependent Dependent task [task/ready/work]

### Generated by

- generator Generator task [task/done]

## Recent logs

- 2 action_started — started
- 3 checkpoint — one
- 4 checkpoint — two
- 5 checkpoint — three
- 6 action_succeeded — done
`);

		const json = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "--config", configPath, "get", "target"],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(json.status).toBe(0);
		const envelope = JSON.parse(json.stdout);
		expect(envelope.data.logs).toHaveLength(inspectionLogCount);
		expect(
			envelope.data.recentLogs.map((log: { sequence: number }) => log.sequence),
		).toEqual(inspectionRecentLogSequences);
		expect(envelope.data.relationships.parent).toMatchObject({
			id: "parent",
			title: "Parent spec",
		});
	});
});

it(
	"should ensure that filesystem CLI stores default logs externally without embedding them in issue markdown",
	async () => {
		await withTempDir(async (dir) => {
			const trackerPath = join(dir, "tracker");
			const configPath = join(dir, "filesystem.workflow.ts");
			await writeFile(
				configPath,
				`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: ${JSON.stringify(trackerPath)} });
`,
			);
			const runCli = (args: Array<string>, input?: unknown) => {
				const result = spawnSync(
					process.execPath,
					[cliPath.pathname, "--json", "--config", configPath, ...args],
					{
						cwd: dir,
						encoding: "utf8",
						input:
							input === undefined ? undefined : serializeCliSmokeInput(input),
					},
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
				return envelope.data;
			};

			const spec = runCli(["create", "spec", "--input", "-"], {
				title: "External log spec",
				body: "Body",
			}).issue;
			const task = runCli(["create", "task:work", "--input", "-"], {
				parent: spec.id,
				title: "External log task",
				description: "Do it.",
				profile: "implement",
			}).issue;
			runCli(["task", "start", task.id]);
			runCli(["task", "succeed", task.id, "--input", "-"], {
				summary: "Implemented external log coverage.",
				checks: ["pnpm test"],
				implementationPr: prArtifact(1),
			});
			const runTextCli = (args: Array<string>) => {
				const result = spawnSync(
					process.execPath,
					[cliPath.pathname, "--config", configPath, ...args],
					{ cwd: dir, encoding: "utf8" },
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				return result.stdout;
			};

			expect(await readdir(trackerPath)).toEqual(["1.md", "2.md", "logs"]);
			expect(await readdir(join(trackerPath, "logs", spec.id))).toEqual([
				"1-spec-create-created.md",
			]);
			expect(await readdir(join(trackerPath, "logs", task.id))).toEqual([
				"1-task-work-create-created.md",
				"2-command.md",
				"3-command.md",
			]);
			expect(
				await readFile(join(trackerPath, `${spec.id}.md`), "utf8"),
			).not.toContain("## Logs");
			expect(
				await readFile(join(trackerPath, `${task.id}.md`), "utf8"),
			).not.toContain("## Logs");
			const creationLog = await readFile(
				join(trackerPath, "logs", spec.id, "1-spec-create-created.md"),
				"utf8",
			);
			expect(creationLog).toContain("\n\nApplied spec-create.\n");
			expect(creationLog).not.toContain("```json");
			const completionLog = await readFile(
				join(trackerPath, "logs", task.id, "3-command.md"),
				"utf8",
			);
			expect(completionLog).toContain(
				"\n\nImplemented external log coverage.\n",
			);
			expect(completionLog).not.toContain("checks");
			expect(completionLog).not.toContain("implementationPr");
			expect(
				runCli(["logs", task.id]).logs.map(
					(log: { type: string; message?: string }) => [log.type, log.message],
				),
			).toEqual([
				["task-work-create_created", "Applied task-work-create."],
				["command", "Applied start."],
				["command", "Implemented external log coverage."],
			]);
			expect(runTextCli(["logs", task.id])).toBe(
				"1 task-work-create_created — Applied task-work-create.\n2 command — Applied start.\n3 command — Implemented external log coverage.\n",
			);
			expect(runTextCli(["get", task.id])).toContain(
				"- 3 command — Implemented external log coverage.",
			);
		});
	},
	externalLogCliTimeoutMs,
);

it(
	"should ensure that filesystem CLI honors disabled manifest logging across create and lifecycle commands",
	async () => {
		await withTempDir(async (dir) => {
			const trackerPath = join(dir, "tracker");
			const configPath = join(dir, "filesystem-no-logs.workflow.ts");
			await writeFile(
				configPath,
				`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = { ...agentWorkflowManifest, logging: { enabled: false } };
export const tracker = createFileSystemTracker({ path: ${JSON.stringify(trackerPath)} });
`,
			);
			const runCli = (args: Array<string>, input?: unknown) => {
				const result = spawnSync(
					process.execPath,
					[cliPath.pathname, "--json", "--config", configPath, ...args],
					{
						cwd: dir,
						encoding: "utf8",
						input:
							input === undefined ? undefined : serializeCliSmokeInput(input),
					},
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
				return envelope.data;
			};

			const spec = runCli(["create", "spec", "--input", "-"], {
				title: "No-log spec",
				body: "Body",
			}).issue;
			const task = runCli(["create", "task:work", "--input", "-"], {
				parent: spec.id,
				title: "No-log task",
				description: "Do it.",
				profile: "implement",
			}).issue;
			runCli(["task", "start", task.id]);
			runCli(["task", "succeed", task.id, "--input", "-"], {
				implementationPr: prArtifact(1),
			});

			expect(runCli(["logs", spec.id]).logs).toEqual([]);
			expect(runCli(["logs", task.id]).logs).toEqual([]);
			expect(runCli(["get", task.id]).recentLogs).toEqual([]);
			expect(await readdir(trackerPath)).toEqual(["1.md", "2.md"]);
			await expect(stat(join(trackerPath, "logs"))).rejects.toThrow();
			expect(
				await readFile(join(trackerPath, `${spec.id}.md`), "utf8"),
			).not.toContain("## Logs");
			expect(
				await readFile(join(trackerPath, `${task.id}.md`), "utf8"),
			).not.toContain("## Logs");
		});
	},
	externalLogCliTimeoutMs,
);

it("should ensure that filesystem CLI reads historical JSON-looking log files as Markdown prose", async () => {
	await withTempDir(async (dir) => {
		const trackerPath = join(dir, "tracker");
		const configPath = join(dir, "filesystem.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: ${JSON.stringify(trackerPath)} });
`,
		);
		const runCli = (args: Array<string>, input?: unknown) => {
			const result = spawnSync(
				process.execPath,
				[cliPath.pathname, "--json", "--config", configPath, ...args],
				{
					cwd: dir,
					encoding: "utf8",
					input:
						input === undefined ? undefined : serializeCliSmokeInput(input),
				},
			);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			const envelope = JSON.parse(result.stdout);
			expect(envelope.ok).toBe(true);
			return envelope.data;
		};
		const spec = runCli(["create", "spec", "--input", "-"], {
			title: "Historical log spec",
			body: "Body",
		}).issue;
		const historicalBody = `# action_succeeded

\`\`\`json
{"message":"{\\"summary\\":\\"Nested summary\\"}"}
\`\`\`
`;
		const historicalPath = join(
			trackerPath,
			"logs",
			spec.id,
			"2-action-succeeded.md",
		);
		await writeFile(
			historicalPath,
			`---
sequence: 2
issue: ${JSON.stringify(spec.id)}
event: "action_succeeded"
createdAt: "2024-01-01T00:00:00.000Z"
---

${historicalBody}`,
		);
		const before = await readFile(historicalPath, "utf8");

		const logs = runCli(["logs", spec.id]).logs;
		expect(logs[1].message).toBe(historicalBody.trim());
		expect(runCli(["get", spec.id]).recentLogs[1].message).toBe(
			historicalBody.trim(),
		);
		expect(await readFile(historicalPath, "utf8")).toBe(before);
	});
});

it("should ensure that filesystem CLI get preserves metadata while surfacing malformed external log diagnostics", async () => {
	await withTempDir(async (dir) => {
		const trackerPath = join(dir, "tracker");
		const configPath = join(dir, "filesystem.workflow.ts");
		const inputPath = join(dir, "spec.json");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: ${JSON.stringify(trackerPath)} });
`,
		);
		await writeFile(
			inputPath,
			JSON.stringify({ title: "External log spec", body: "Body" }),
		);
		const createResult = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--config",
				configPath,
				"create",
				"spec",
				"--input",
				inputPath,
			],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(createResult.status).toBe(0);

		await mkdir(join(trackerPath, "logs", "1"), { recursive: true });
		await writeFile(
			join(trackerPath, "logs", "1", "2-malformed.md"),
			"not frontmatter\n",
		);

		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--config", configPath, "get", "1"],
			{ cwd: dir, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"# 1 External log spec [spec/ready/planning]",
		);
		expect(result.stdout).toContain("## Recent logs");
		expect(result.stderr).toContain("2-malformed.md");
		expect(result.stderr).toContain("invalid markdown projection data");
	});
});

it("should ensure that CLI writes bundled workflow descriptions as Markdown text by default", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--config", validManifestPath, "workflow", "describe"],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("# Workflow w1");
	expect(result.stdout).toContain(
		"- States: ready, running, in-discussion, done, need-human, waiting-human",
	);
	expect(result.stdout).toContain("- Actions: planning, work, discuss, none");
	expect(result.stdout).toContain("- Per workflow: 4");
	expect(result.stdout).toContain("- Per kind task: 3");
	expect(result.stdout).toContain("- spec (Spec)");
	expect(result.stdout).toContain("- task (Task)");
	expect(result.stdout).toContain("- wayfinder (Wayfinder)");
	expect(result.stdout).toContain("- grilling (Grilling)");
	expect(result.stdout).toContain("- task-create");
	expect(result.stdout).toContain(
		"  - Usage: awf create task --input <file|->",
	);
	expect(result.stdout).toContain(
		'    - awf create task --title "Title" --description -',
	);
	expect(result.stdout).toContain("  - Target: task/work");
	expect(result.stdout).toContain("  - Input: required");
	expect(result.stdout).toContain(
		"  - siblings where task:work:integration-test/ready/work; siblings all done/none, gate implementation-gate",
	);
	expect(result.stdout).toContain(
		"- task-generated-by-task: task -> task (generated-by)",
	);
	expect(result.stdout).toContain("## Scope notes");
	expect(result.stdout).not.toContain("agent-development");
	expect(result.stdout).not.toContain("_def");
	expect(result.stdout).not.toContain("typeName");
});

it("should ensure that CLI writes bundled workflow description DTOs in JSON envelopes", () => {
	const result = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			validManifestPath,
			"workflow",
			"describe",
		],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(true);
	expect(envelope.data).not.toEqual(expect.any(String));
	expect(envelope.data).toMatchObject({
		version: "v1",
		workflow: { id: "w1", version: "1.0.0" },
		concurrency: { perIssue: 1, perWorkflow: 4, perKind: { task: 3 } },
		vocabulary: {
			states: [
				"ready",
				"running",
				"in-discussion",
				"done",
				"need-human",
				"waiting-human",
			],
			actions: ["planning", "work", "discuss", "none"],
			events: [
				"start",
				"succeed",
				"fail",
				"recover",
				"escalate",
				"pause",
				"resume",
			],
		},
		readiness: {
			filters: [
				{ kind: "spec", state: "ready", action: "planning" },
				{ kind: "task", state: "ready", action: "work" },
			],
		},
		relationships: expect.arrayContaining([
			{
				id: "spec-task",
				from: "spec",
				to: "task",
				projection: { type: "parent-child" },
			},
			{
				id: "task-generated-by-task",
				from: "task",
				to: "task",
				projection: { type: "generated-by" },
			},
		]),
	});
	expect(envelope.data.kinds.map((kind: { id: string }) => kind.id)).toEqual([
		"spec",
		"wayfinder",
		"task",
		"task:work",
		"task:research",
		"task:prototype",
		"task:work:integration-test",
		"task:work:merge",
		"grilling",
	]);
	expect(
		envelope.data.commands.filter(
			(command: { cli?: unknown }) => command.cli !== undefined,
		),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "spec-create",
				cli: expect.objectContaining({
					verb: "create",
					target: "spec",
					usage: "awf create spec --input <file|->",
					examples: ['awf create spec --title "Title" --body -'],
				}),
				target: { kind: "spec", action: "planning" },
				input: { required: true },
			}),
			{
				id: "spec-planned",
				cli: {
					verb: "spec",
					target: "planned",
					usage: "awf spec planned <issue>",
				},
				target: { kind: "spec", action: "planning" },
				input: { required: false },
			},
			{
				id: "spec-complete",
				cli: {
					verb: "spec",
					target: "complete",
					usage: "awf spec complete <issue> --input <file|->",
				},
				target: { kind: "spec", state: "ready", action: "none" },
				input: { required: false },
			},
			expect.objectContaining({
				id: "task-create",
				cli: expect.objectContaining({
					verb: "create",
					target: "task",
					usage: "awf create task --input <file|->",
					examples: ['awf create task --title "Title" --description -'],
				}),
				target: { kind: "task", action: "work" },
				input: { required: true },
			}),
			expect.objectContaining({
				id: "task-start",
				cli: expect.objectContaining({ usage: "awf task start <issue>" }),
				transition: { event: "start", attempt: "start" },
			}),
		]),
	);
	const serialized = JSON.stringify(envelope.data);
	expect(serialized).not.toContain("agent-development");
	expect(serialized).not.toContain("_def");
	expect(serialized).not.toContain("typeName");
});

it("should ensure that CLI workflow describe uses the no-config agent-workflow default", async () => {
	await withTempDir(async (dir) => {
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "workflow", "describe"],
			{ cwd: dir, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.data.workflow.id).toBe("w1");
		expect(envelope.data.kinds.map((kind: { id: string }) => kind.id)).toEqual([
			"spec",
			"wayfinder",
			"task",
			"task:work",
			"task:research",
			"task:prototype",
			"task:work:integration-test",
			"task:work:merge",
			"grilling",
		]);
	});
});

it("should ensure that CLI workflow describe accepts no extra arguments", () => {
	const result = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			validManifestPath,
			"workflow",
			"describe",
			"extra",
		],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(1);
	const envelope = JSON.parse(result.stdout);
	expect(envelope.error).toEqual({
		code: "INVALID_ARGUMENTS",
		message: "Invalid command arguments.",
		details: { usage: "awf workflow describe" },
	});
});

it("should ensure that CLI writes JSON envelopes to stdout with --json", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", validManifestPath, "--help"],
		{
			encoding: "utf8",
		},
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(true);
	expect(envelope.data.name).toBe("awf");
});

it("should ensure that CLI discovers only ./awf.config.ts from the current working directory", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "awf.config.ts"), configWithMemoryIssue("91"));
		const discovered = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "ready"],
			{
				cwd: dir,
				encoding: "utf8",
			},
		);

		expect(discovered.status).toBe(0);
		expect(
			JSON.parse(discovered.stdout).data.items.map(
				(item: { id: string }) => item.id,
			),
		).toEqual(["91"]);

		const child = join(dir, "child");
		await mkdir(child);
		const notDiscoveredFromParent = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "ready"],
			{ cwd: child, encoding: "utf8" },
		);

		expect(notDiscoveredFromParent.status).toBe(0);
		const envelope = JSON.parse(notDiscoveredFromParent.stdout);
		expect(envelope.data.items).toEqual([]);
	});
});

it("should ensure that CLI global --config loads a workflow module before command execution", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(configPath, configWithMemoryIssue("92"));
		const result = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "--config", configPath, "ready"],
			{ cwd: dir, encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(
			JSON.parse(result.stdout).data.items.map(
				(item: { id: string }) => item.id,
			),
		).toEqual(["92"]);
	});
});

it(
	"should ensure that blocked ready diagnostics work end-to-end through the CLI",
	async () => {
		await withTempDir(async (dir) => {
			const configPath = join(dir, "blocked.workflow.ts");
			await writeFile(
				configPath,
				`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker({ issues: [
	{
		id: "1",
		title: "Unblocked work",
		workflow: { kind: "task", state: "ready", action: "work" },
	},
	{
		id: "2",
		title: "First blocked work",
		workflow: { kind: "task", state: "ready", action: "work" },
		relationships: { dependencies: ["1"] },
	},
	{
		id: "3",
		title: "Second blocked work",
		workflow: { kind: "task", state: "ready", action: "work" },
		relationships: { dependencies: ["1"] },
	},
] });
`,
			);
			const runCli = (args: Array<string>) =>
				spawnSync(
					process.execPath,
					[cliPath.pathname, "--config", configPath, ...args],
					{
						cwd: dir,
						encoding: "utf8",
					},
				);

			const defaultReady = runCli(["ready", "--limit", "1"]);
			expect(defaultReady.status).toBe(0);
			expect(defaultReady.stderr).toBe("");
			expect(defaultReady.stdout).toBe(
				"1 Unblocked work [task/ready/work] — awf run-command start 1\n\nBlocked work: 2. Use awf ready --blocked to inspect.\n",
			);

			const defaultJson = runCli(["--json", "ready", "--limit", "1"]);
			expect(defaultJson.status).toBe(0);
			const defaultEnvelope = JSON.parse(defaultJson.stdout);
			expect(
				defaultEnvelope.data.items.map((item: { id: string }) => item.id),
			).toEqual(["1"]);
			expect(
				defaultEnvelope.data.blocked.map((item: { id: string }) => item.id),
			).toEqual(["2", "3"]);

			const blockedReady = runCli(["ready", "--blocked", "--limit", "1"]);
			expect(blockedReady.status).toBe(0);
			expect(blockedReady.stderr).toBe("");
			expect(blockedReady.stdout).toBe(
				"2 First blocked work [task/ready/work] — blocked by dependency: 1 Unblocked work\n",
			);

			const blockedJson = runCli(["--json", "ready", "--blocked"]);
			expect(blockedJson.status).toBe(0);
			const blockedEnvelope = JSON.parse(blockedJson.stdout);
			expect(blockedEnvelope.data.items).toBeUndefined();
			expect(
				blockedEnvelope.data.blocked.map((item: { id: string }) => item.id),
			).toEqual(["2", "3"]);

			const emptyBlocked = spawnSync(
				process.execPath,
				[cliPath.pathname, "--config", validManifestPath, "ready", "--blocked"],
				{ cwd: dir, encoding: "utf8" },
			);
			expect(emptyBlocked.status).toBe(0);
			expect(emptyBlocked.stderr).toBe("");
			expect(emptyBlocked.stdout).toBe("No blocked work.\n");

			const help = runCli(["--help"]);
			expect(help.status).toBe(0);
			expect(help.stdout).toContain(
				"awf ready [--blocked] [--filter <name=value>] [--limit <n>]",
			);
		});
	},
	externalLogCliTimeoutMs,
);

it("should ensure that CLI without a workflow config defaults to the bundled agent-workflow manifest", async () => {
	await withTempDir(async (dir) => {
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "create", "spec", "--input", "-"],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({ title: "No default", body: "# No default\n" }),
			},
		);

		expect(created.status).toBe(0);
		const envelope = JSON.parse(created.stdout);
		expect(envelope.data.issue.workflow).toMatchObject({
			kind: "spec",
			state: "ready",
			action: "planning",
		});
	});
});

it(
	"should ensure that ergonomic AWF CLI creation flows work end-to-end",
	async () => {
		await withTempDir(async (dir) => {
			const trackerPath = join(dir, "tracker");
			const configPath = join(dir, "awf.config.ts");
			const wayfinderBodyPath = join(dir, "wayfinder.md");
			const grillingDescriptionPath = join(dir, "grilling.md");
			await writeFile(
				configPath,
				`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: ${JSON.stringify(trackerPath)} });
`,
			);
			await writeFile(wayfinderBodyPath, "# Map\n\nFind the route.\n");
			await writeFile(
				grillingDescriptionPath,
				"Discuss the acceptance edge.\n",
			);
			const runCli = (args: Array<string>, input?: unknown) => {
				const result = spawnSync(
					process.execPath,
					[cliPath.pathname, "--json", "--config", configPath, ...args],
					{
						cwd: dir,
						encoding: "utf8",
						input:
							input === undefined ? undefined : serializeCliSmokeInput(input),
					},
				);
				expect(result.stderr).toBe("");
				return result;
			};
			const assertOk = (result: ReturnType<typeof runCli>) => {
				expect(result.status, result.stdout).toBe(0);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
				return envelope.data;
			};

			const jsonSpec = assertOk(
				runCli(["create", "spec", "--input", "-"], {
					title: "JSON spec",
					body: "# JSON spec\n\nStill supported.",
				}),
			).issue;
			const stdinSpec = assertOk(
				runCli(
					["create", "spec", "--title", "Stdin spec", "--body", "-"],
					"# Stdin spec\n\nMarkdown from stdin.",
				),
			).issue;
			const wayfinder = assertOk(
				runCli([
					"create",
					"wayfinder",
					"--title",
					"File wayfinder",
					"--body-file",
					wayfinderBodyPath,
				]),
			).issue;
			const task = assertOk(
				runCli(
					[
						"create",
						"task:work",
						"--parent",
						jsonSpec.id,
						"--title",
						"Stdin task",
						"--description",
						"-",
						"--profile",
						"implement",
					],
					"Implement with Markdown from stdin.",
				),
			).issue;
			const grilling = assertOk(
				runCli([
					"create",
					"grilling",
					"--parent",
					jsonSpec.id,
					"--title",
					"File grilling",
					"--description-file",
					grillingDescriptionPath,
				]),
			).issue;
			const mixed = runCli(
				["create", "spec", "--input", "-", "--title", "Mixed"],
				{ title: "Mixed", body: "# Mixed" },
			);

			expect(mixed.status).toBe(1);
			expect(JSON.parse(mixed.stdout)).toMatchObject({
				ok: false,
				error: {
					code: "INVALID_ARGUMENTS",
					message: "Use either --input or ergonomic create flags, not both.",
				},
			});
			expect(jsonSpec.body).toContain("Still supported.");
			expect(stdinSpec.body).toBe("# Stdin spec\n\nMarkdown from stdin.");
			expect(wayfinder.body).toBe("# Map\n\nFind the route.\n");
			expect(task.body).toContain("Implement with Markdown from stdin.");
			expect(grilling.body).toContain("Discuss the acceptance edge.");
			expect(task.relationships.parent).toBe(jsonSpec.id);
			expect(grilling.relationships.parent).toBe(jsonSpec.id);

			const help = spawnSync(
				process.execPath,
				[cliPath.pathname, "--config", configPath, "--help"],
				{ cwd: dir, encoding: "utf8" },
			);
			expect(help.status).toBe(0);
			expect(help.stderr).toBe("");
			expect(help.stdout).toContain("awf create spec --input <file|->");
			expect(help.stdout).toContain('awf create spec --title "Title" --body -');
			expect(help.stdout).toContain("awf create task:work --input <file|->");
			expect(help.stdout).toContain(
				'awf create task:work --title "Title" --description -',
			);

			for (const skillPath of [
				agentWorkflowSkillPath,
				toSpecSkillPath,
				toTicketsSkillPath,
				wayfinderSkillPath,
			]) {
				const skill = await readFile(skillPath, "utf8");
				expect(skill).toMatch(/prefer(?:ring)? ergonomic create flags/i);
				expect(skill).toContain("--input <file|->");
			}
		});
	},
	externalLogCliTimeoutMs,
);

it("should ensure that CLI config-exported command handlers can customize bundled agent-workflow command ids", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};

export const manifest = agentWorkflowManifest;
export const commandHandlers = {
	"task-create": async ({ input, command }) => ({
		command: command.id,
		title: input.title,
		handled: true,
	}),
};
`,
		);

		const result = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--json",
				"--config",
				configPath,
				"create",
				"task",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					parent: "1",
					title: "Configured task",
					description: "Handle through config.",
					profile: "implement",
					kind: "task:work",
				}),
			},
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			ok: true,
			data: { command: "task-create", title: "Configured task", handled: true },
		});
	});
});

it("should ensure that CLI config-exported lifecycle handlers can customize bundled agent-workflow transition keys", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createInMemoryTracker } from ${JSON.stringify(memoryTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker({
	issues: [{
		id: "task-1",
		title: "Task",
		workflow: {
			kind: "task",
			state: "running",
			action: "work",
		},
	}],
});

export const lifecycleHandlers = {
	"task:running/work:succeed": () => undefined,
};
`,
		);

		const result = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--json",
				"--config",
				configPath,
				"run-command",
				"succeed",
				"task-1",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					implementationPr: prArtifact(configLifecycleHandlerPrNumber),
				}),
			},
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).data.log.message).toBe("Applied succeed.");
	});
});

it("should ensure that CLI config that omits tracker uses the default filesystem tracker", async () => {
	await withTempDir(async (dir) => {
		await writeFile(
			join(dir, "awf.config.ts"),
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
export const manifest = agentWorkflowManifest;
`,
		);
		const created = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "create", "spec", "--input", "-"],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					title: "Manifest-only config",
					body: "# Spec",
				}),
			},
		);

		expect(created.status).toBe(0);
		const trackerIssue = await readFile(
			join(dir, ".awf", "tracker", "1.md"),
			"utf8",
		);
		expect(trackerIssue).toContain('title: "Manifest-only config"');
	});
});

it(
	"should ensure that CLI config default filesystem tracker keeps workflow state across separate processes",
	async () => {
		await withTempDir(async (dir) => {
			await writeFile(
				join(dir, "awf.config.ts"),
				`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
export const manifest = agentWorkflowManifest;
`,
			);
			const runCli = (args: Array<string>, input?: unknown) => {
				const result = spawnSync(
					process.execPath,
					[cliPath.pathname, "--json", ...args],
					{
						cwd: dir,
						encoding: "utf8",
						input:
							input === undefined ? undefined : serializeCliSmokeInput(input),
					},
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
				return envelope.data;
			};

			const spec = runCli(["create", "spec", "--input", "-"], {
				title: "Durable spec",
				body: "# Durable spec\n",
			}).issue;
			expect(spec.id).toBe("1");
			expect(
				runCli(["ready"]).items.map((item: { id: string }) => item.id),
			).toEqual(["1"]);
			expect(runCli(["get", spec.id]).issue.title).toBe("Durable spec");

			const task = runCli(["create", "task:work", "--input", "-"], {
				parent: spec.id,
				title: "Durable task",
				description: "Do it.",
				profile: "implement",
			});
			const taskId = task.issue.id;
			expect(
				runCli(["ready"]).items.map((item: { id: string }) => item.id),
			).toEqual(["1", taskId]);
			expect(runCli(["get", taskId]).issue.relationships.parent).toBe(spec.id);
			expect(
				runCli(["logs", spec.id]).logs.map((log: { type: string }) => log.type),
			).toEqual(["spec-create_created"]);

			runCli(["run-command", "start", taskId]);
			const failed = runCli(["run-command", "fail", taskId, "--input", "-"], {
				reason: "transient",
			});
			expect({
				state: failed.issue.workflow.state,
				action: failed.issue.workflow.action,
			}).toEqual({ state: "need-human", action: "none" });

			const recovered = runCli([
				"run-command",
				"resume",
				taskId,
				"--action",
				"work",
			]);
			expect({
				state: recovered.issue.workflow.state,
				action: recovered.issue.workflow.action,
			}).toEqual({ state: "ready", action: "work" });
			expect(
				runCli(["logs", taskId]).logs.map((log: { type: string }) => log.type),
			).toEqual([
				"task-work-create_created",
				"action_started",
				"action_failed",
				"action_resumed",
			]);
		});
	},
	bundledGoldenSmokeTimeoutMs,
);

it("should ensure that CLI uses an explicit config-exported filesystem tracker across processes", async () => {
	await withTempDir(async (dir) => {
		const configPath = join(dir, "custom.workflow.ts");
		await writeFile(
			configPath,
			`import { agentWorkflowManifest } from ${JSON.stringify(agentWorkflowSourcePath)};
import { createFileSystemTracker } from ${JSON.stringify(filesystemTrackerSourcePath)};

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: "./custom-tracker" });
`,
		);
		const create = spawnSync(
			process.execPath,
			[
				cliPath.pathname,
				"--json",
				"--config",
				configPath,
				"create",
				"spec",
				"--input",
				"-",
			],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({ title: "Config tracker", body: "# Spec" }),
			},
		);
		expect(create.status).toBe(0);
		const createdId = JSON.parse(create.stdout).data.issue.id;

		const get = spawnSync(
			process.execPath,
			[cliPath.pathname, "--json", "--config", configPath, "get", createdId],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(get.status).toBe(0);
		expect(JSON.parse(get.stdout).data.issue.title).toBe("Config tracker");
		const trackerIssue = await readFile(
			join(dir, "custom-tracker", `${createdId}.md`),
			"utf8",
		);
		expect(trackerIssue).toContain(`id: ${JSON.stringify(createdId)}`);
	});
});

it("should ensure that CLI returns clear failure envelopes for explicit bad config paths", async () => {
	const missing = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", "./missing.workflow.ts", "ready"],
		{ encoding: "utf8" },
	);
	expect(missing.status).toBe(1);
	expect(JSON.parse(missing.stdout).error.code).toBe("CONFIG_LOAD_FAILED");

	const invalid = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", badManifestPath, "ready"],
		{ encoding: "utf8" },
	);
	expect(invalid.status).toBe(1);
	expect(JSON.parse(invalid.stdout).error.code).toBe("CONFIG_LOAD_FAILED");

	const manifestless = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", missingManifestPath, "ready"],
		{ encoding: "utf8" },
	);
	expect(manifestless.status).toBe(1);
	const envelope = JSON.parse(manifestless.stdout);
	expect(envelope.error.code).toBe("CONFIG_LOAD_FAILED");
	expect(envelope.error.message).toMatch(/manifest/);

	await withTempDir(async (dir) => {
		const unreadablePath = join(dir, "unreadable.workflow.ts");
		await writeFile(unreadablePath, configWithMemoryIssue("93"));
		await chmod(unreadablePath, unreadableMode);
		try {
			const unreadable = spawnSync(
				process.execPath,
				[cliPath.pathname, "--json", "--config", unreadablePath, "ready"],
				{ encoding: "utf8" },
			);
			expect(unreadable.status).toBe(1);
			expect(JSON.parse(unreadable.stdout).error.code).toBe(
				"CONFIG_LOAD_FAILED",
			);
		} finally {
			await chmod(unreadablePath, ownerReadWriteMode);
		}
	});
});

it("should ensure that CLI smoke path loads a fixture manifest and returns a JSON success envelope", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "manifest", "validate", validManifestPath],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		ok: true,
		data: {
			manifest: "w1",
			version: "v1",
			kinds: [
				"spec",
				"wayfinder",
				"task",
				"task:work",
				"task:research",
				"task:prototype",
				"task:work:integration-test",
				"task:work:merge",
				"grilling",
			],
		},
	});
});

it("should ensure that CLI returns a stable validation error envelope for a generic link projection", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "manifest", "validate", linkManifestPath],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(false);
	expect(envelope.error.code).toBe("MANIFEST_VALIDATION_FAILED");
	expect(envelope.error.details.issues.at(-1).path).toBe(
		"$.relationships[7].projection.type",
	);
	expect(envelope.error.details.issues.at(-1).message).toMatch(
		/parent-child, dependency, or generated-by/,
	);
});

it("should ensure that CLI returns a stable validation error envelope for a bad manifest", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "manifest", "validate", badManifestPath],
		{ encoding: "utf8" },
	);

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.ok).toBe(false);
	expect(envelope.error.code).toBe("MANIFEST_VALIDATION_FAILED");
	expect(JSON.stringify(envelope.error.details.issues)).toMatch(/wildcard/);
});

it("should ensure that CLI smoke path seeds multiple in-memory issues and returns only legally executable ready items", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "--config", envMemoryWorkflowPath, "ready"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "1",
						title: "Ready ticket",
						labels: [
							"awf:w1:kind:task",
							"awf:w1:state:ready",
							"awf:w1:action:work",
						],
					},
					{
						id: "2",
						title: "Dependency blocked ticket",
						labels: [
							"awf:w1:kind:task",
							"awf:w1:state:ready",
							"awf:w1:action:work",
						],
						relationships: { dependencies: ["1"] },
					},
					{
						id: "3",
						title: "Running ticket",
						workflow: {
							kind: "task",
							state: "running",
							action: "work",
						},
					},
				]),
			},
		},
	);

	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(
		JSON.parse(result.stdout).data.items.map((item: { id: string }) => item.id),
	).toEqual(["1"]);
});

it("should ensure that CLI smoke path does not report compatibility run ids", () => {
	const issues = [
		{
			id: "42",
			title: "Drifted lifecycle",
			workflow: { kind: "task", state: "running", action: "work" },
			logs: [
				{
					sequence: 1,
					issueId: "42",
					type: "action_started",
				},
			],
		},
	];
	const env = { ...process.env, AWF_MEMORY_ISSUES: JSON.stringify(issues) };

	const before = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"succeed",
			"42",
			"--input",
			"-",
		],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: prArtifact(1),
			}),
			env,
		},
	);
	expect(before.status).toBe(0);

	const diagnosed = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"reconcile",
			"42",
		],
		{
			encoding: "utf8",
			env,
		},
	);
	expect(diagnosed.status).toBe(0);
	expect(JSON.parse(diagnosed.stdout).data).toMatchObject({
		status: "clean",
		diagnostics: [],
	});

	const applied = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"reconcile",
			"42",
			"--apply",
		],
		{ encoding: "utf8", env },
	);
	expect(applied.status).toBe(0);
	const repairedIssue = JSON.parse(applied.stdout).data.issue;

	const after = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"succeed",
			"42",
			"--input",
			"-",
		],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: prArtifact(1),
			}),
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{ ...repairedIssue, logs: issues[0].logs },
				]),
			},
		},
	);
	expect(after.status).toBe(0);
});

it("should ensure that CLI smoke path starts and succeeds a workflow action with logs oldest-first", () => {
	const started = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"start",
			"42",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						labels: [
							"awf:w1:kind:task",
							"awf:w1:state:ready",
							"awf:w1:action:work",
						],
					},
				]),
			},
		},
	);

	expect(started.status).toBe(0);
	expect(started.stderr).toBe("");
	const startEnvelope = JSON.parse(started.stdout);
	expect(startEnvelope.ok).toBe(true);
	const succeeded = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"run-command",
			"succeed",
			"42",
			"--input",
			"-",
		],
		{
			encoding: "utf8",
			input: JSON.stringify({
				implementationPr: prArtifact(1),
			}),
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						workflow: {
							kind: "task",
							state: "running",
							action: "work",
						},
						logs: [startEnvelope.data.log],
					},
				]),
			},
		},
	);

	expect(succeeded.status).toBe(0);
	expect(succeeded.stderr).toBe("");
	const succeedEnvelope = JSON.parse(succeeded.stdout);
	expect(succeedEnvelope.ok).toBe(true);
	const logged = spawnSync(
		process.execPath,
		[
			cliPath.pathname,
			"--json",
			"--config",
			envMemoryWorkflowPath,
			"logs",
			"42",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				AWF_MEMORY_ISSUES: JSON.stringify([
					{
						id: "42",
						title: "Implement lifecycle",
						workflow: {
							kind: "task",
							state: "ready",
							action: "none",
						},
						logs: [startEnvelope.data.log, succeedEnvelope.data.log],
					},
				]),
			},
		},
	);

	expect(logged.status).toBe(0);
	expect(logged.stderr).toBe("");
	const logsEnvelope = JSON.parse(logged.stdout);
	expect(logsEnvelope.ok).toBe(true);
	expect(
		logsEnvelope.data.logs.map((log: { type: string }) => log.type),
	).toEqual(["action_started", "action_succeeded"]);
});

it("should ensure that CLI writes plain text errors to stdout and exits non-zero by default", () => {
	const result = spawnSync(process.execPath, [cliPath.pathname, "unknown"], {
		encoding: "utf8",
	});

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("Error UNKNOWN_COMMAND: Unknown command.");
});

it("should ensure that CLI writes error envelopes to stdout and exits non-zero with --json", () => {
	const result = spawnSync(
		process.execPath,
		[cliPath.pathname, "--json", "unknown"],
		{
			encoding: "utf8",
		},
	);

	expect(result.status).toBe(1);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		ok: false,
		error: {
			code: "UNKNOWN_COMMAND",
			message: "Unknown command.",
			details: { command: "unknown" },
		},
	});
});
