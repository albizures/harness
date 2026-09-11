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
import { expect, it } from "vitest";
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
		expect(entries).toEqual(["1.md"]);
		const raw = await readFile(join(trackerDir, "1.md"), "utf8");
		const golden = await readFile(
			join(fixturesDir, "readable-issue.md"),
			"utf8",
		);
		expect(raw).toBe(golden);
		expect(raw).not.toContain("labels:");
		expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
	});
});

it("should ensure that file-backed tracker round-trips readable markdown list logs with multiline messages", async () => {
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
			message: "First line\n\n  indented second line\n",
		});

		const raw = await readFile(join(trackerDir, "1.md"), "utf8");
		expect(raw).toContain('1. type: "created"');
		expect(raw).toContain(
			[
				'2. type: "commented"',
				"   message: |",
				"     First line",
				"     ",
				"       indented second line",
			].join("\n"),
		);

		const reloaded = createFileSystemTracker({ path: trackerDir });
		expect(await reloaded.readLogs(issue.id)).toEqual([
			{ issueId: "1", sequence: 1, type: "created" },
			{
				issueId: "1",
				sequence: 2,
				type: "commented",
				message: "First line\n\n  indented second line\n",
			},
		]);
	});
});

it("should ensure that file-backed tracker rejects malformed markdown log list entries", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });
		const issue = await tracker.createIssue({
			title: "Log corruption target",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		await tracker.appendLog(issue.id, { type: "created" });
		const original = await readFile(join(trackerDir, "1.md"), "utf8");

		const corruptions = [
			{
				name: "invalid sequence",
				content: original.replace('1. type: "created"', '2. type: "created"'),
				message: /invalid workflow log sequence '2'/,
			},
			{
				name: "unsupported payload",
				content: original.replace(
					'1. type: "created"',
					'1. type: {"type":"created"}',
				),
				message: /workflow log 1 has invalid type/,
			},
			{
				name: "malformed entry",
				content: original.replace('1. type: "created"', "- bad log"),
				message: /malformed workflow log entry '- bad log'/,
			},
		];

		for (const corruption of corruptions) {
			const caseDir = join(dir, corruption.name.replaceAll(" ", "-"));
			await mkdir(caseDir);
			await writeFile(join(caseDir, "1.md"), corruption.content, "utf8");

			expect(() => createFileSystemTracker({ path: caseDir })).toThrow(
				CorruptWorkflowProjectionError,
			);
			expect(() => createFileSystemTracker({ path: caseDir })).toThrow(
				corruption.message,
			);
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
			'relationships: {"children":[],"dependencies":[],"dependents":[]}',
		);
		expect(blockerAfter).toContain(
			'relationships: {"children":[],"dependencies":[],"dependents":[]}',
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
		expect(raw).toContain("After body\n\n## Logs\n\n<!-- awf:logs v1 -->");
		expect(raw).toContain(`"version":${updated.workflow.version}`);
		expect(raw).toContain(`"hash":"${updated.workflow.hash}"`);
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
				name: "mismatched filename id",
				fileName: "2.md",
				content: original,
				message: /filename id '2' does not match frontmatter id '1'/,
			},
			{
				name: "malformed relationships",
				fileName: "1.md",
				content: original.replace(
					'relationships: {"children":[],"dependencies":[],"dependents":[]}',
					'relationships: {"children":"2","dependencies":[],"dependents":[]}',
				),
				message: /malformed relationships/,
			},
			{
				name: "stale workflow hash",
				fileName: "1.md",
				content: original.replace(
					`"hash":"${issue.workflow.hash}"`,
					'"hash":"stale"',
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
