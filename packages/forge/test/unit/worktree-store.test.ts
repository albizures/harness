import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import {
	parseAbsolutePath,
	parseProjectId,
	parseWorktreeId,
	type WorktreeRecord,
} from "../../src/domain.ts";
import { ensureStoreRootEffect } from "../../src/filesystem-store.ts";
import type { RecordId } from "../../src/record-domain.ts";
import {
	clearTaskWorktreeBindingEffect,
	createWorkflowRecordEffect,
	readTaskWorktreeBindingEffect,
	readWorkflowRecordEffect,
	writeTaskWorktreeBindingEffect,
} from "../../src/record-store.ts";
import {
	storeRootPaths,
	worktreeRecordFilePath,
} from "../../src/store-paths.ts";
import {
	listWorktreeRecordsEffect,
	readWorktreeRecordEffect,
	writeWorktreeRecordEffect,
} from "../../src/worktree-store.ts";
import { runTestEffect } from "../support/effect.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");
const laterDate = new Date("2026-09-20T00:00:00.000Z");

const ensureStoreRoot = (...args: Parameters<typeof ensureStoreRootEffect>) =>
	runTestEffect(ensureStoreRootEffect(...args));
const createWorkflowRecord = (
	...args: Parameters<typeof createWorkflowRecordEffect>
) => runTestEffect(createWorkflowRecordEffect(...args));
const readWorkflowRecord = (
	...args: Parameters<typeof readWorkflowRecordEffect>
) => runTestEffect(readWorkflowRecordEffect(...args));
const writeWorktreeRecord = (
	...args: Parameters<typeof writeWorktreeRecordEffect>
) => runTestEffect(writeWorktreeRecordEffect(...args));
const readWorktreeRecord = (
	...args: Parameters<typeof readWorktreeRecordEffect>
) => runTestEffect(readWorktreeRecordEffect(...args));
const listWorktreeRecords = (
	...args: Parameters<typeof listWorktreeRecordsEffect>
) => runTestEffect(listWorktreeRecordsEffect(...args));
const readTaskWorktreeBinding = (
	...args: Parameters<typeof readTaskWorktreeBindingEffect>
) => runTestEffect(readTaskWorktreeBindingEffect(...args));
const writeTaskWorktreeBinding = (
	...args: Parameters<typeof writeTaskWorktreeBindingEffect>
) => runTestEffect(writeTaskWorktreeBindingEffect(...args));
const clearTaskWorktreeBinding = (
	...args: Parameters<typeof clearTaskWorktreeBindingEffect>
) => runTestEffect(clearTaskWorktreeBindingEffect(...args));

async function tempStore() {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-worktree-store-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	return storePath;
}

function sampleWorktreeRecord(): WorktreeRecord {
	return {
		id: parseWorktreeId("wt_sample_1"),
		taskId: 2,
		projectId: parseProjectId("harness"),
		repositoryRoot: parseAbsolutePath("/repo"),
		worktreePath: parseAbsolutePath("/store/worktrees/harness/wt_sample_1"),
		branch: "forge/264-worktree-store",
		baseRef: "main",
		baseSha: "0123456789abcdef",
		status: "active",
		copyManifests: [
			{
				manifestPath: parseAbsolutePath("/repo/copy-manifest.json"),
				entries: [{ path: ".env.local", optional: true }],
			},
		],
		copiedPaths: [".env.local"],
		diagnostics: [{ code: "note", message: "bounded diagnostic" }],
		createdAt: "2026-09-19T00:00:00.000Z" as WorktreeRecord["createdAt"],
		updatedAt: "2026-09-19T00:00:00.000Z" as WorktreeRecord["updatedAt"],
	};
}

it("when ensuring the store root, it should create worktree collection directories", async () => {
	const storePath = await tempStore();
	const paths = storeRootPaths(storePath);

	expect(paths.worktrees).toBe(path.join(storePath, "worktrees"));
	expect(paths.worktreeRecords).toBe(path.join(storePath, "worktree-records"));
});

it("when writing worktree records, it should persist and list the separate collection", async () => {
	const storePath = await tempStore();
	const record = sampleWorktreeRecord();

	await writeWorktreeRecord({ storePath, record });

	expect(
		JSON.parse(
			await readFile(worktreeRecordFilePath(storePath, record.id), "utf8"),
		),
	).toEqual(record);
	expect(
		await readWorktreeRecord({ storePath, worktreeId: record.id }),
	).toEqual(record);
	expect(await listWorktreeRecords(storePath)).toEqual([record]);
});

it("when writing and clearing a task worktree binding, it should store only the active binding in task metadata", async () => {
	const storePath = await tempStore();
	const spec = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Deliver worktree primitives.\n",
		},
	});
	const task = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Task",
			kind: "task",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: spec.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Prepare persistence.\n",
		},
	});
	const binding = {
		id: parseWorktreeId("wt_task_2"),
		status: "active" as const,
	};

	await writeTaskWorktreeBinding({
		storePath,
		taskId: task.id,
		binding,
		now: laterDate,
	});

	expect(await readTaskWorktreeBinding({ storePath, taskId: task.id })).toEqual(
		binding,
	);
	expect((await readWorkflowRecord(storePath, task.id)).metadata).toEqual({
		forge: { worktreeBinding: binding },
	});

	await clearTaskWorktreeBinding({
		storePath,
		taskId: task.id as RecordId,
		now: laterDate,
	});

	expect(
		await readTaskWorktreeBinding({ storePath, taskId: task.id }),
	).toBeNull();
	expect(
		(await readWorkflowRecord(storePath, task.id)).metadata,
	).toBeUndefined();
});
