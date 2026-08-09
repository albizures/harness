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
