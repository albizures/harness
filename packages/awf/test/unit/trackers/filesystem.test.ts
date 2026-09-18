import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CorruptWorkflowProjectionError } from "../../../src/domain/workflow/projection.ts";
import { createFileSystemTracker } from "../../../src/adapters/trackers/filesystem.ts";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"fixtures",
	"filesystem-tracker",
);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "awf-file-tracker-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

it("should ensure that file-backed tracker initializes missing directory state and persists mutations for later adapters", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "nested", "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		expect(await tracker.listIssues()).toEqual([]);
		await expect(stat(trackerDir)).rejects.toThrow();

		const issue = await tracker.createIssue({
			title: "Durable ticket",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});
		await tracker.appendLog(issue.id, { type: "created" });

		expect((await stat(trackerDir)).isDirectory()).toBe(true);
		const reloaded = createFileSystemTracker({ path: trackerDir });
		expect((await reloaded.listIssues()).map((stored) => stored.title)).toEqual(
			["Durable ticket"],
		);
		expect((await reloaded.readLogs(issue.id)).map((log) => log.type)).toEqual([
			"created",
		]);
		expect(await reloaded.getIssue(issue.id)).not.toHaveProperty("artifacts");
	});
});

it("should ensure that file-backed tracker preserves workflow data and issue allocation across fresh adapters", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		const { issue: spec } = await tracker.createWorkflowIssue({
			title: "Durable Spec",
			workflow: { kind: "spec", state: "ready", action: "plan" },
			initialLog: { type: "workflow_created" },
		});
		const { issue: ticket } = await tracker.createWorkflowIssue({
			title: "Durable Ticket",
			workflow: {
				kind: "ticket",
				state: "ready",
				action: "implement",
				data: { subkind: "research" },
			},
			initialLog: { type: "workflow_created" },
		});
		const { issue: blocker } = await tracker.createWorkflowIssue({
			title: "Durable Blocker",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});

		await tracker.changeRelationship({
			type: "add-child",
			parentId: spec.id,
			childId: ticket.id,
		});
		await tracker.changeRelationship({
			type: "add-dependency",
			issueId: ticket.id,
			blockedById: blocker.id,
		});
		const started = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id: ticket.id },
					expect: {
						version: ticket.workflow.version,
						hash: ticket.workflow.hash,
					},
					workflow: { state: "running" },
				},
				{
					type: "record-command",
					issue: { id: ticket.id },
					log: { type: "action_started" },
				},
			],
		});
		const startedIssue =
			started.issues[ticket.id] ?? (await tracker.getIssue(ticket.id));
		await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id: ticket.id },
					expect: {
						version: startedIssue.workflow.version,
						hash: startedIssue.workflow.hash,
					},
					workflow: { state: "done", action: "none" },
				},
				{
					type: "record-command",
					issue: { id: ticket.id },
					log: { type: "action_succeeded" },
				},
			],
		});

		const reloaded = createFileSystemTracker({ path: trackerDir });
		const reloadedTicket = await reloaded.getIssue(ticket.id);
		const nextIssue = await reloaded.createWorkflowIssue({
			title: "Created after reload",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});

		expect((await reloaded.listIssues()).map((issue) => issue.id)).toEqual([
			spec.id,
			ticket.id,
			blocker.id,
			nextIssue.issue.id,
		]);
		expect(
			(await reloaded.readLogs(ticket.id)).map((log) => ({
				sequence: log.sequence,
				type: log.type,
			})),
		).toEqual([
			{ sequence: 1, type: "workflow_created" },
			{ sequence: 2, type: "action_started" },
			{ sequence: 3, type: "action_succeeded" },
		]);
		expect((await reloaded.getIssue(spec.id)).relationships.children).toEqual([
			ticket.id,
		]);
		expect(reloadedTicket.workflow.kind).toBe("ticket");
		expect(reloadedTicket.workflow.data).toEqual({ subkind: "research" });
		expect(reloadedTicket.relationships.parent).toBe(spec.id);
		expect(reloadedTicket.relationships.dependencies).toEqual([blocker.id]);
		expect(
			(await reloaded.getIssue(blocker.id)).relationships.dependents,
		).toEqual([ticket.id]);
		expect(reloadedTicket).not.toHaveProperty("artifacts");
		expect(reloadedTicket).not.toHaveProperty("changes");
		expect(nextIssue.issue.id).toBe("4");
	});
});

it("should ensure that file-backed tracker loads numeric issue files in numeric order and ignores unrelated markdown files", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		await tracker.createIssue({
			id: "10",
			title: "Ten",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await tracker.createIssue({
			id: "2",
			title: "Two",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await tracker.createIssue({
			id: "1",
			title: "One",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await writeFile(join(trackerDir, "notes.md"), "# Not an issue\n", "utf8");

		const reloaded = createFileSystemTracker({ path: trackerDir });

		expect((await reloaded.listIssues()).map((issue) => issue.id)).toEqual([
			"1",
			"2",
			"10",
		]);
	});
});

it("should ensure that file-backed tracker allocates issue ids from existing numeric issue files", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		await mkdir(trackerDir);
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			id: "7",
			title: "Existing high id",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});

		const reloaded = createFileSystemTracker({ path: trackerDir });
		const nextIssue = await reloaded.createIssue({
			title: "After high id",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});

		expect(issue.id).toBe("7");
		expect(nextIssue.id).toBe("8");
	});
});

it("should ensure that file-backed tracker read-only operations do not rewrite state", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		await tracker.createIssue({
			title: "Read me",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		const issueFile = join(trackerDir, "1.md");
		const before = await stat(issueFile, { bigint: true });

		await tracker.listIssues();
		await tracker.getIssue("1");
		await tracker.readLogs("1");

		const after = await stat(issueFile, { bigint: true });
		expect(after.mtimeNs).toBe(before.mtimeNs);
	});
});

it("should lock the readable filesystem tracker issue markdown format against a golden file", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		const issue = await tracker.createIssue({
			title: "Readable issue",
			body: "Issue **body**\n\nWith markdown.",
			workflow: {
				kind: "ticket",
				state: "ready",
				action: "none",
				data: { subkind: "work" },
			},
		});
		await tracker.appendLog(issue.id, { type: "created", message: "Created" });
		await tracker.appendLog(issue.id, {
			type: "commented",
			message: "First line\n\n  indented second line",
		});

		const entries = await readdir(trackerDir);
		expect(entries).toEqual(["1.md", "logs"]);
		const raw = await readFile(join(trackerDir, "1.md"), "utf8");
		const golden = await readFile(
			join(fixturesDir, "readable-issue.md"),
			"utf8",
		);
		expect(raw).toBe(golden);
		expect(raw).not.toContain("labels:");
		expect(raw).not.toContain("## Logs");
		const logEntries = await readdir(join(trackerDir, "logs", "1"));
		expect(logEntries).toEqual(["1-created.md", "2-commented.md"]);
		const firstLog = await readFile(
			join(trackerDir, "logs", "1", "1-created.md"),
			"utf8",
		);
		expect(firstLog).toContain('sequence: 1\nissue: "1"\nevent: "created"');
		expect(firstLog).toMatch(/createdAt: "\d{4}-\d{2}-\d{2}T/u);
		expect(firstLog).toContain("Created\n");
		expect(firstLog).not.toContain("```json");
		expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
	});
});

it("should ensure that file-backed tracker reads idiomatic YAML issue frontmatter", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "YAML issue",
			body: "Body",
			workflow: {
				kind: "ticket",
				state: "ready",
				action: "none",
				data: { subkind: "work" },
			},
		});
		const original = await readFile(join(trackerDir, "1.md"), "utf8");
		const yaml = original
			.replace('id: "1"', "id: '1'")
			.replace('title: "YAML issue"', "title: YAML issue")
			.replace(
				`workflow: ${JSON.stringify(issue.workflow)}`,
				[
					"workflow:",
					"  kind: ticket",
					"  state: ready",
					"  action: none",
					"  data:",
					"    subkind: work",
					`  version: ${issue.workflow.version}`,
					`  hash: ${issue.workflow.hash}`,
				].join("\n"),
			)
			.replace(
				'relationships: {"children":[],"dependencies":[],"dependents":[]}',
				[
					"relationships:",
					"  children: []",
					"  dependencies: []",
					"  dependents: []",
				].join("\n"),
			);
		await writeFile(join(trackerDir, "1.md"), yaml, "utf8");

		const reloaded = createFileSystemTracker({ path: trackerDir });

		expect(await reloaded.getIssue("1")).toMatchObject({
			id: "1",
			title: "YAML issue",
			body: "Body",
			workflow: issue.workflow,
			relationships: { children: [], dependencies: [], dependents: [] },
		});
	});
});

it("should ensure that file-backed tracker reads legacy inline JSON issue frontmatter", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "Legacy JSON issue",
			body: "Legacy body",
			workflow: {
				kind: "ticket",
				state: "ready",
				action: "none",
				data: { subkind: "work" },
			},
		});
		await writeFile(
			join(trackerDir, "1.md"),
			[
				"---",
				`id: ${JSON.stringify(issue.id)}`,
				`title: ${JSON.stringify(issue.title)}`,
				`workflow: ${JSON.stringify(issue.workflow)}`,
				`relationships: ${JSON.stringify(issue.relationships)}`,
				"---",
				"",
				"Legacy body",
				"",
			].join("\n"),
			"utf8",
		);

		const reloaded = createFileSystemTracker({ path: trackerDir });

		expect(await reloaded.getIssue("1")).toMatchObject({
			id: "1",
			title: "Legacy JSON issue",
			body: "Legacy body",
			workflow: issue.workflow,
			relationships: { children: [], dependencies: [], dependents: [] },
		});
	});
});

it("should lock the filesystem tracker external log markdown format against canonical text", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2024-02-03T04:05:06.789Z"));
	try {
		await withTempDir(async (dir) => {
			const trackerDir = join(dir, "tracker");
			const tracker = createFileSystemTracker({ path: trackerDir });

			const issue = await tracker.createIssue({
				title: "Log target",
				workflow: { kind: "ticket", state: "ready", action: "none" },
			});
			await tracker.appendLog(issue.id, {
				type: "commented",
				message: "Canonical prose body",
			});

			await expect(
				readFile(join(trackerDir, "logs", "1", "1-commented.md"), "utf8"),
			).resolves.toBe(
				[
					"---",
					"sequence: 1",
					'issue: "1"',
					'event: "commented"',
					'createdAt: "2024-02-03T04:05:06.789Z"',
					"---",
					"",
					"Canonical prose body",
					"",
				].join("\n"),
			);
		});
	} finally {
		vi.useRealTimers();
	}
});

it("should ensure that file-backed tracker reads legacy inline JSON external log frontmatter", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "Legacy log target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await mkdir(join(trackerDir, "logs", issue.id), { recursive: true });
		await writeFile(
			join(trackerDir, "logs", issue.id, "1-commented.md"),
			[
				"---",
				"sequence: 1",
				`issue: ${JSON.stringify(issue.id)}`,
				`event: ${JSON.stringify("commented")}`,
				`createdAt: ${JSON.stringify("2024-02-03T04:05:06.789Z")}`,
				"---",
				"",
				"Legacy log body",
				"",
			].join("\n"),
			"utf8",
		);

		const reloaded = createFileSystemTracker({ path: trackerDir });

		expect(await reloaded.readLogs(issue.id)).toEqual([
			{
				issueId: "1",
				sequence: 1,
				type: "commented",
				message: "Legacy log body",
			},
		]);
	});
});

it("should ensure that file-backed tracker writes log messages directly as prose Markdown bodies", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		const issue = await tracker.createIssue({
			title: "Log target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await tracker.appendLog(issue.id, { type: "created" });
		await tracker.appendLog(issue.id, {
			type: "commented",
			message:
				'First line\n\n```json\n{"prose":true}\n```\n\n  indented second line\n',
		});

		const raw = await readFile(join(trackerDir, "1.md"), "utf8");
		expect(raw).not.toContain("## Logs");
		const emptyLog = await readFile(
			join(trackerDir, "logs", "1", "1-created.md"),
			"utf8",
		);
		expect(emptyLog).toMatch(
			/^---\nsequence: 1\nissue: "1"\nevent: "created"\ncreatedAt: ".+"\n---\n\n$/u,
		);
		expect(emptyLog).not.toContain("No payload.");
		const storedLog = await readFile(
			join(trackerDir, "logs", "1", "2-commented.md"),
			"utf8",
		);
		expect(storedLog).toContain('event: "commented"');
		expect(storedLog).toContain(
			'First line\n\n```json\n{"prose":true}\n```\n\n  indented second line\n',
		);

		const reloaded = createFileSystemTracker({ path: trackerDir });
		expect(await reloaded.readLogs(issue.id)).toEqual([
			{ issueId: "1", sequence: 1, type: "created" },
			{
				issueId: "1",
				sequence: 2,
				type: "commented",
				message:
					'First line\n\n```json\n{"prose":true}\n```\n\n  indented second line',
			},
		]);
	});
});

it("should ensure that file-backed tracker retries external log filename collisions with a fresh sequence", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const firstAdapter = createFileSystemTracker({ path: trackerDir });
		const issue = await firstAdapter.createIssue({
			title: "Collision target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await firstAdapter.appendLog(issue.id, { type: "created" });
		const staleAdapter = createFileSystemTracker({ path: trackerDir });
		await firstAdapter.appendLog(issue.id, {
			type: "commented",
			message: "first writer",
		});

		await staleAdapter.appendLog(issue.id, {
			type: "commented",
			message: "stale writer",
		});

		expect(await readdir(join(trackerDir, "logs", issue.id))).toEqual([
			"1-created.md",
			"2-commented.md",
			"3-commented.md",
		]);
		const reloaded = createFileSystemTracker({ path: trackerDir });
		expect(
			(await reloaded.readLogs(issue.id)).map((log) => ({
				sequence: log.sequence,
				type: log.type,
				message: log.message,
			})),
		).toEqual([
			{ sequence: 1, type: "created", message: undefined },
			{ sequence: 2, type: "commented", message: "first writer" },
			{ sequence: 3, type: "commented", message: "stale writer" },
		]);
	});
});

it("should ensure that file-backed tracker ignores legacy embedded markdown log list entries when external logs are absent", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "Legacy log target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		const original = await readFile(join(trackerDir, "1.md"), "utf8");
		await writeFile(
			join(trackerDir, "1.md"),
			`${original}\n## Logs\n\n<!-- awf:logs v1 -->\n\n- bad legacy log\n`,
			"utf8",
		);

		const reloaded = createFileSystemTracker({ path: trackerDir });

		expect(await reloaded.readLogs(issue.id)).toEqual([]);
	});
});

it("should ensure that file-backed tracker skips malformed external logs and warns without blocking valid logs", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "Malformed log target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await tracker.appendLog(issue.id, { type: "created" });
		await mkdir(join(trackerDir, "logs", issue.id), { recursive: true });
		await writeFile(
			join(trackerDir, "logs", issue.id, "2-broken.md"),
			"{not markdown",
			"utf8",
		);
		await writeFile(
			join(trackerDir, "logs", issue.id, "3-unknown-field.md"),
			[
				"---",
				"sequence: 3",
				'issue: "1"',
				'event: "commented"',
				'createdAt: "2024-02-03T04:05:06.789Z"',
				"extra: true",
				"---",
				"",
				"unknown field",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			join(trackerDir, "logs", issue.id, "4-duplicate-field.md"),
			[
				"---",
				"sequence: 4",
				'issue: "1"',
				'event: "commented"',
				'event: "duplicated"',
				'createdAt: "2024-02-03T04:05:06.789Z"',
				"---",
				"",
				"duplicate field",
			].join("\n"),
			"utf8",
		);
		await tracker.appendLog(issue.id, { type: "commented", message: "valid" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const reloaded = createFileSystemTracker({ path: trackerDir });

			expect((await reloaded.getIssue(issue.id)).title).toBe(
				"Malformed log target",
			);
			expect(
				(await reloaded.readLogs(issue.id)).map((log) => ({
					sequence: log.sequence,
					type: log.type,
					message: log.message,
				})),
			).toEqual([
				{ sequence: 1, type: "created", message: undefined },
				{ sequence: 2, type: "commented", message: "valid" },
			]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("Filesystem tracker log file"),
			);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("2-broken.md"));
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("unknown frontmatter field 'extra'"),
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("duplicate frontmatter field 'event'"),
			);
		} finally {
			warn.mockRestore();
		}
	});
});

it("should ensure that file-backed tracker removes deleted numeric markdown files and rewrites related issue files", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		const parent = await tracker.createIssue({
			title: "Parent",
			workflow: { kind: "spec", state: "ready", action: "plan" },
		});
		const child = await tracker.createIssue({
			title: "Child",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});
		const blocker = await tracker.createIssue({
			title: "Blocker",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});
		await tracker.addChild(parent.id, child.id);
		await tracker.addDependency(child.id, blocker.id);
		const parentBefore = await readFile(join(trackerDir, "1.md"), "utf8");
		const blockerBefore = await readFile(join(trackerDir, "3.md"), "utf8");

		await tracker.deleteIssue(child.id);

		expect(await readdir(trackerDir)).toEqual(["1.md", "3.md"]);
		await expect(stat(join(trackerDir, "2.md"))).rejects.toThrow();
		const parentAfter = await readFile(join(trackerDir, "1.md"), "utf8");
		const blockerAfter = await readFile(join(trackerDir, "3.md"), "utf8");
		expect(parentAfter).not.toBe(parentBefore);
		expect(blockerAfter).not.toBe(blockerBefore);
		expect(parentAfter).toContain(
			"relationships:\n  children: []\n  dependencies: []\n  dependents: []",
		);
		expect(blockerAfter).toContain(
			"relationships:\n  children: []\n  dependencies: []\n  dependents: []",
		);

		const reloaded = createFileSystemTracker({ path: trackerDir });
		expect((await reloaded.listIssues()).map((issue) => issue.id)).toEqual([
			parent.id,
			blocker.id,
		]);
		expect((await reloaded.getIssue(parent.id)).relationships.children).toEqual(
			[],
		);
		expect(
			(await reloaded.getIssue(blocker.id)).relationships.dependents,
		).toEqual([]);
	});
});

it("should ensure that file-backed tracker rewrites markdown issue files atomically on issue updates", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		const issue = await tracker.createIssue({
			title: "Before",
			body: "Before body",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		const before = await readFile(join(trackerDir, "1.md"), "utf8");
		const updated = await tracker.updateIssue(issue.id, {
			title: "After",
			body: "After body",
			workflow: { state: "done" },
			expect: { version: issue.workflow.version, hash: issue.workflow.hash },
		});

		const raw = await readFile(join(trackerDir, "1.md"), "utf8");
		expect(raw).not.toBe(before);
		expect(raw).toContain('title: "After"');
		expect(raw).toContain("After body\n");
		expect(raw).not.toContain("<!-- awf:logs v1 -->");
		expect(raw).toContain(`  version: ${updated.workflow.version}`);
		expect(raw).toContain(`  hash: "${updated.workflow.hash}"`);
		expect(
			(await readdir(trackerDir)).filter((entry) => entry.includes(".tmp-")),
		).toEqual([]);
	});
});

it("should ensure that file-backed tracker rejects unsupported markdown projection schema", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		await mkdir(trackerDir);
		await writeFile(
			join(trackerDir, "1.md"),
			[
				"---",
				'id: "1"',
				'title: "Corrupt metadata"',
				'workflow: "not workflow metadata"',
				'relationships: {"children":[],"dependencies":[],"dependents":[]}',
				"---",
				"",
				"<!-- awf:logs v1 -->",
				"",
				'1. type: "created"',
				"",
			].join("\n"),
			"utf8",
		);

		expect(() => createFileSystemTracker({ path: trackerDir })).toThrow(
			/invalid markdown projection data|unsupported or malformed schema/,
		);
	});
});

it("should ensure that file-backed tracker rejects corrupt markdown storage during load", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "Corruption target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		const original = await readFile(join(trackerDir, "1.md"), "utf8");

		const corruptions = [
			{
				name: "unknown frontmatter field",
				fileName: "1.md",
				content: original.replace(
					'title: "Corruption target"',
					'title: "Corruption target"\nextra: true',
				),
				message: /unknown frontmatter field 'extra'/,
			},
			{
				name: "duplicate frontmatter field",
				fileName: "1.md",
				content: original.replace(
					'title: "Corruption target"',
					'title: "Corruption target"\ntitle: duplicate',
				),
				message: /duplicate frontmatter field 'title'/,
			},
			{
				name: "aliased frontmatter value",
				fileName: "1.md",
				content: original.replace('id: "1"', "id: &id '1'\ntitle: *id"),
				message: /must not use aliases/,
			},
			{
				name: "mismatched filename id",
				fileName: "2.md",
				content: original,
				message: /filename id '2' does not match frontmatter id '1'/,
			},
			{
				name: "malformed relationships",
				fileName: "1.md",
				content: original.replace("  children: []", '  children: "2"'),
				message: /malformed relationships/,
			},
			{
				name: "stale workflow hash",
				fileName: "1.md",
				content: original.replace(
					`  hash: "${issue.workflow.hash}"`,
					'  hash: "stale"',
				),
				message: /stale workflow hash/,
			},
		];

		for (const corruption of corruptions) {
			const caseDir = join(dir, corruption.name.replaceAll(" ", "-"));
			await mkdir(caseDir);
			await writeFile(
				join(caseDir, corruption.fileName),
				corruption.content,
				"utf8",
			);

			expect(() => createFileSystemTracker({ path: caseDir })).toThrow(
				CorruptWorkflowProjectionError,
			);
			expect(() => createFileSystemTracker({ path: caseDir })).toThrow(
				corruption.message,
			);
		}
	});
});

it("should ensure that file-backed tracker rejects corrupted JSON clearly", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		await mkdir(trackerDir);
		await writeFile(join(trackerDir, "1.md"), "{not markdown", "utf8");

		expect(() => createFileSystemTracker({ path: trackerDir })).toThrow(
			CorruptWorkflowProjectionError,
		);
		expect(() => createFileSystemTracker({ path: trackerDir })).toThrow(
			/invalid markdown projection data/,
		);
	});
});
