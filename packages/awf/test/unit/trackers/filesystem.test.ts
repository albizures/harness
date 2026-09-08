import {
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { CorruptWorkflowProjectionError } from "../../../src/workflow/projection.ts";
import { createFileSystemTracker } from "../../../src/trackers/filesystem.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "awf-file-tracker-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

it("should ensure that file-backed tracker initializes missing state and persists mutations for later adapters", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "nested", "tracker.json");
		const tracker = createFileSystemTracker({ path: file });

		expect(await tracker.listIssues()).toEqual([]);
		await expect(stat(file)).rejects.toThrow();

		const issue = await tracker.createIssue({
			title: "Durable ticket",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});
		await tracker.appendLog(issue.id, { type: "created" });

		expect((await stat(dirname(file))).isDirectory()).toBe(true);
		const reloaded = createFileSystemTracker({ path: file });
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
		const file = join(dir, "tracker.json");
		const tracker = createFileSystemTracker({ path: file });

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
		const started = await tracker.startRun(ticket.id, {
			expect: {
				version: ticket.workflow.version,
				hash: ticket.workflow.hash,
			},
			runId: "run-1",
			workflow: { state: "running", activeRunId: "run-1" },
			log: { type: "action_started", runId: "run-1" },
		});
		await tracker.completeRun(ticket.id, {
			expect: {
				version: started.issue.workflow.version,
				hash: started.issue.workflow.hash,
			},
			runId: "run-1",
			workflow: { state: "done", action: "none" },
			log: { type: "action_succeeded", runId: "run-1" },
		});

		const reloaded = createFileSystemTracker({ path: file });
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

it("should ensure that file-backed tracker read-only operations do not rewrite state", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tracker.json");
		const tracker = createFileSystemTracker({ path: file });
		await tracker.createIssue({
			title: "Read me",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});
		const before = await stat(file, { bigint: true });

		await tracker.listIssues();
		await tracker.getIssue("1");
		await tracker.readLogs("1");

		const after = await stat(file, { bigint: true });
		expect(after.mtimeNs).toBe(before.mtimeNs);
	});
});

it("should ensure that file-backed tracker writes a complete JSON state file without leftover temp files", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tracker.json");
		const tracker = createFileSystemTracker({ path: file });

		await tracker.createIssue({
			title: "Atomic",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});

		const raw = await readFile(file, "utf8");
		expect(JSON.parse(raw).issues[0].title).toBe("Atomic");
		expect(
			(await readdir(dir)).filter((entry) => entry.includes(".tmp-")),
		).toEqual([]);
	});
});

it("should ensure that file-backed tracker rejects unsupported stored issue fields", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tracker.json");
		await writeFile(
			file,
			JSON.stringify({
				version: 1,
				nextIssueNumber: 2,
				issues: [
					{
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
					},
				],
			}),
			"utf8",
		);

		expect(() => createFileSystemTracker({ path: file })).toThrow(
			/unsupported or malformed schema/,
		);
	});
});

it("should ensure that file-backed tracker rejects corrupted JSON clearly", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tracker.json");
		await writeFile(file, "{not json", "utf8");

		expect(() => createFileSystemTracker({ path: file })).toThrow(
			CorruptWorkflowProjectionError,
		);
		expect(() => createFileSystemTracker({ path: file })).toThrow(
			/not valid JSON/,
		);
	});
});
