import assert from "node:assert/strict";
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
import test from "node:test";
import { CorruptWorkflowProjectionError } from "./tracker.ts";
import { createFileSystemTracker } from "./trackers/filesystem.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "awf-file-tracker-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("file-backed tracker initializes missing state and persists mutations for later adapters", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "nested", "tracker.json");
		const tracker = createFileSystemTracker({ path: file });

		assert.deepEqual(await tracker.listIssues(), []);
		await assert.rejects(stat(file));

		const issue = await tracker.createIssue({
			title: "Durable ticket",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});
		await tracker.appendLog(issue.id, { type: "created" });
		await tracker.registerArtifact(issue.id, {
			kind: "file",
			uri: "docs/result.md",
		});

		assert.equal((await stat(dirname(file))).isDirectory(), true);
		const reloaded = createFileSystemTracker({ path: file });
		assert.deepEqual(
			(await reloaded.listIssues()).map((stored) => stored.title),
			["Durable ticket"],
		);
		assert.deepEqual(
			(await reloaded.readLogs(issue.id)).map((log) => log.type),
			["created"],
		);
		assert.equal(
			(await reloaded.getIssue(issue.id)).artifacts[0]?.uri,
			"docs/result.md",
		);
	});
});

test("file-backed tracker preserves workflow data and issue allocation across fresh adapters", async () => {
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
			workflow: { kind: "ticket", state: "ready", action: "implement" },
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
			artifacts: [
				{
					kind: "file",
					uri: "docs/implementation.md",
					name: "Implementation notes",
				},
			],
			changes: [
				{
					kind: "git-ref",
					uri: "abc123",
					summary: "Implemented filesystem persistence",
				},
			],
			log: { type: "action_succeeded", runId: "run-1" },
		});

		const reloaded = createFileSystemTracker({ path: file });
		const reloadedTicket = await reloaded.getIssue(ticket.id);
		const nextIssue = await reloaded.createWorkflowIssue({
			title: "Created after reload",
			workflow: { kind: "ticket", state: "ready", action: "implement" },
		});

		assert.deepEqual(
			(await reloaded.listIssues()).map((issue) => issue.id),
			[spec.id, ticket.id, blocker.id, nextIssue.issue.id],
		);
		assert.deepEqual(
			(await reloaded.readLogs(ticket.id)).map((log) => ({
				sequence: log.sequence,
				type: log.type,
			})),
			[
				{ sequence: 1, type: "workflow_created" },
				{ sequence: 2, type: "action_started" },
				{ sequence: 3, type: "action_succeeded" },
			],
		);
		assert.deepEqual(
			(await reloaded.getIssue(spec.id)).relationships.children,
			[ticket.id],
		);
		assert.equal(reloadedTicket.relationships.parent, spec.id);
		assert.deepEqual(reloadedTicket.relationships.dependencies, [blocker.id]);
		assert.deepEqual(
			(await reloaded.getIssue(blocker.id)).relationships.dependents,
			[ticket.id],
		);
		assert.deepEqual(reloadedTicket.artifacts, [
			{
				id: "artifact-1",
				kind: "file",
				uri: "docs/implementation.md",
				name: "Implementation notes",
				type: "file",
				path: "docs/implementation.md",
			},
		]);
		assert.deepEqual(reloadedTicket.changes, [
			{
				id: "change-1",
				kind: "git-ref",
				uri: "abc123",
				summary: "Implemented filesystem persistence",
			},
		]);
		assert.equal(nextIssue.issue.id, "4");
	});
});

test("file-backed tracker read-only operations do not rewrite state", async () => {
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
		assert.equal(after.mtimeNs, before.mtimeNs);
	});
});

test("file-backed tracker writes a complete JSON state file without leftover temp files", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tracker.json");
		const tracker = createFileSystemTracker({ path: file });

		await tracker.createIssue({
			title: "Atomic",
			workflow: { kind: "ticket", state: "ready", action: "none" },
		});

		const raw = await readFile(file, "utf8");
		assert.equal(JSON.parse(raw).issues[0].title, "Atomic");
		assert.deepEqual(
			(await readdir(dir)).filter((entry) => entry.includes(".tmp-")),
			[],
		);
	});
});

test("file-backed tracker rejects corrupted JSON clearly", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tracker.json");
		await writeFile(file, "{not json", "utf8");

		assert.throws(
			() => createFileSystemTracker({ path: file }),
			(error: unknown) =>
				error instanceof CorruptWorkflowProjectionError &&
				error.message.includes("not valid JSON"),
		);
	});
});
