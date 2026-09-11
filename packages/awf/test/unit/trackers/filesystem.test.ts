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
import { join } from "node:path";
import { expect, it } from "vitest";
import { CorruptWorkflowProjectionError } from "../../../src/domain/workflow/projection.ts";
import { createFileSystemTracker } from "../../../src/adapters/trackers/filesystem.ts";

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
		const issueFile = join(trackerDir, "1");
		const before = await stat(issueFile, { bigint: true });

		await tracker.listIssues();
		await tracker.getIssue("1");
		await tracker.readLogs("1");

		const after = await stat(issueFile, { bigint: true });
		expect(after.mtimeNs).toBe(before.mtimeNs);
	});
});

it("should ensure that file-backed tracker writes complete JSON issue files without leftover temp files", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		const tracker = createFileSystemTracker({ path: trackerDir });

		await tracker.createIssue({
			title: "Atomic",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});

		const raw = await readFile(join(trackerDir, "1"), "utf8");
		expect(JSON.parse(raw).title).toBe("Atomic");
		expect(
			(await readdir(trackerDir)).filter((entry) => entry.includes(".tmp-")),
		).toEqual([]);
	});
});

it("should ensure that file-backed tracker rejects unsupported stored issue fields", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		await mkdir(trackerDir);
		await writeFile(
			join(trackerDir, "1"),
			JSON.stringify({
				id: "1",
				title: "Corrupt metadata",
				workflow: { kind: "ticket", state: "ready", action: "none" },
				relationships: {
					children: [],
					dependencies: [],
					dependents: [],
				},
				unexpectedRecords: [],
				logs: [],
			}),
			"utf8",
		);

		expect(() => createFileSystemTracker({ path: trackerDir })).toThrow(
			/unsupported or malformed schema/,
		);
	});
});

it("should ensure that file-backed tracker rejects corrupted JSON clearly", async () => {
	await withTempDir(async (dir) => {
		const trackerDir = join(dir, "tracker");
		await mkdir(trackerDir);
		await writeFile(join(trackerDir, "1"), "{not json", "utf8");

		expect(() => createFileSystemTracker({ path: trackerDir })).toThrow(
			CorruptWorkflowProjectionError,
		);
		expect(() => createFileSystemTracker({ path: trackerDir })).toThrow(
			/not valid JSON/,
		);
	});
});
