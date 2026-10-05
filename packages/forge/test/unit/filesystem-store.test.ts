import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";

const fsPromisesMock = vi.hoisted(() => ({
	writeFile: vi.fn<typeof import("node:fs/promises").writeFile>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	fsPromisesMock.writeFile.mockImplementation(actual.writeFile);
	return { ...actual, writeFile: fsPromisesMock.writeFile };
});

import { parseAbsolutePath } from "../../src/domain.ts";
import { isForgeError } from "../../src/errors.ts";
import {
	acquireStoreWriteLockEffect,
	ensureStoreRootEffect,
	loadForgeConfigEffect,
	readJsonEffect,
	readStoreManifestEffect,
	releaseStoreWriteLockEffect,
	storeDoctorEffect,
	withStoreWriteLockEffect,
	writeForgeConfigEffect,
	writeJsonFileEffect,
	writeJsonFileIfMissingEffect,
} from "../../src/filesystem-store.ts";
import { runTestEffect } from "../support/effect.ts";
import { storeRootPaths } from "../../src/store-paths.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");
const sharedWriteTimestamp = 1_800_000_000_000;
const concurrentWriteCount = 50;
const contendedLockHoldMs = 40;

const ensureStoreRoot = (...args: Parameters<typeof ensureStoreRootEffect>) =>
	runTestEffect(ensureStoreRootEffect(...args));
const loadForgeConfig = (...args: Parameters<typeof loadForgeConfigEffect>) =>
	runTestEffect(loadForgeConfigEffect(...args));
const readStoreManifest = (
	...args: Parameters<typeof readStoreManifestEffect>
) => runTestEffect(readStoreManifestEffect(...args));
const storeDoctor = (...args: Parameters<typeof storeDoctorEffect>) =>
	runTestEffect(storeDoctorEffect(...args));
const writeForgeConfig = (...args: Parameters<typeof writeForgeConfigEffect>) =>
	runTestEffect(writeForgeConfigEffect(...args));
const writeJsonFile = (...args: Parameters<typeof writeJsonFileEffect>) =>
	runTestEffect(writeJsonFileEffect(...args));
const acquireStoreWriteLock = (
	...args: Parameters<typeof acquireStoreWriteLockEffect>
) => runTestEffect(acquireStoreWriteLockEffect(...args));
const releaseStoreWriteLock = (
	...args: Parameters<typeof releaseStoreWriteLockEffect>
) => runTestEffect(releaseStoreWriteLockEffect(...args));
const withStoreWriteLock = <A, E>(
	...args: Parameters<typeof withStoreWriteLockEffect<A, E, never>>
) => runTestEffect(withStoreWriteLockEffect(...args));

function failureFromExit(exit: Exit.Exit<unknown, unknown>) {
	if (!Exit.isFailure(exit)) {
		throw new Error("Expected Effect to fail.");
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag !== "Some") {
		throw new Error("Expected typed Effect failure.");
	}
	return failure.value;
}

it("when ensuring a store root, it should create root files and indexes conservatively", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-store-")),
	);
	await ensureStoreRoot({ storePath: directory, now: fixedDate });
	const manifest = await readStoreManifest(directory);
	expect(manifest.nextRecordId).toBe(1);
	expect(manifest.createdAt).toBe(fixedDate.toISOString());

	const paths = storeRootPaths(directory);
	await ensureStoreRoot({
		storePath: directory,
		now: new Date("2027-01-01T00:00:00.000Z"),
	});
	expect((await readStoreManifest(directory)).createdAt).toBe(
		fixedDate.toISOString(),
	);
	expect(await readFile(paths.byIdIndex, "utf8")).toBe("{}\n");
});

it("when ensuring a store root through the Effect API, it should create readable manifest and index files", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-store-effect-")),
	);

	await runTestEffect(
		ensureStoreRootEffect({ storePath: directory, now: fixedDate }),
	);

	const manifest = await runTestEffect(readStoreManifestEffect(directory));
	expect(manifest).toMatchObject({
		nextRecordId: 1,
		createdAt: fixedDate.toISOString(),
	});
	expect(
		await readFile(storeRootPaths(directory).relationshipsIndex, "utf8"),
	).toBe("{}\n");
});

it("when an Effect JSON write is asked to create only missing files, it should preserve existing content", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-json-effect-")),
	);
	const filePath = parseAbsolutePath(path.join(directory, "data.json"));

	await expect(
		runTestEffect(writeJsonFileIfMissingEffect(filePath, { first: true })),
	).resolves.toBe(true);
	await expect(
		runTestEffect(writeJsonFileIfMissingEffect(filePath, { first: false })),
	).resolves.toBe(false);

	expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ first: true });
});

it("when an Effect JSON read receives invalid JSON, it should fail with a store-invalid ForgeError", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-json-invalid-effect-")),
	);
	const filePath = parseAbsolutePath(path.join(directory, "invalid.json"));
	await writeFile(filePath, "{not json", "utf8");

	const exit = await runTestEffect(Effect.exit(readJsonEffect(filePath)));
	const error = failureFromExit(exit);

	expect(isForgeError(error)).toBe(true);
	if (isForgeError(error)) {
		expect(error.kind).toBe("store-invalid");
		expect(error.details).toEqual({ path: filePath });
	}
});

it("when an Effect config load has no config file, it should fail with a config-missing ForgeError", async () => {
	const homeDirectory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-config-missing-effect-")),
	);

	const exit = await runTestEffect(
		Effect.exit(loadForgeConfigEffect({ homeDirectory })),
	);
	const error = failureFromExit(exit);

	expect(isForgeError(error)).toBe(true);
	if (isForgeError(error)) {
		expect(error.kind).toBe("config-missing");
	}
});

it("when config is written, it should round-trip an absolute store path", async () => {
	const homeDirectory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-home-")),
	);
	const storePath = parseAbsolutePath(path.join(homeDirectory, "store"));
	await writeForgeConfig({ homeDirectory, config: { storePath } });
	expect(await loadForgeConfig({ homeDirectory })).toEqual({ storePath });
});

it("when doctor checks a valid store, it should report ok", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-doctor-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const report = await storeDoctor({ storePath });
	expect(report.ok).toBe(true);
	expect(report.problems).toEqual([]);
});

it("when doctor scans records, it should report duplicate persisted ids", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-doctor-duplicate-ids-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const taskPath = path.join(storePath, "records", "task", "000", "000007.md");
	const grillingPath = path.join(
		storePath,
		"records",
		"grilling",
		"000",
		"000008.md",
	);
	await mkdir(path.dirname(taskPath), { recursive: true });
	await mkdir(path.dirname(grillingPath), { recursive: true });
	const recordMarkdown = (kind: "task" | "grilling") => `---
id: 7
title: Duplicate id
kind: ${kind}
---

Body
`;
	await writeFile(taskPath, recordMarkdown("task"));
	await writeFile(grillingPath, recordMarkdown("grilling"));

	const report = await storeDoctor({ storePath });

	expect(report.ok).toBe(false);
	expect(report.problems).toContainEqual({
		path: storeRootPaths(storePath).records,
		message: `Duplicate record id '7' found in record files: ${grillingPath}, ${taskPath}.`,
		repairable: false,
	});
});

it("when concurrent atomic JSON writes share a timestamp, they should use distinct temporary files", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-json-concurrent-write-")),
	);
	const filePath = parseAbsolutePath(path.join(directory, "data.json"));
	const now = vi.spyOn(Date, "now").mockReturnValue(sharedWriteTimestamp);
	try {
		await expect(
			Promise.all(
				Array.from({ length: concurrentWriteCount }, (_, index) =>
					writeJsonFile(filePath, { index }),
				),
			),
		).resolves.toHaveLength(concurrentWriteCount);
	} finally {
		now.mockRestore();
	}

	const files = await readdir(directory);
	expect(files).toEqual(["data.json"]);
	expect(JSON.parse(await readFile(filePath, "utf8"))).toHaveProperty("index");
});

it("when an atomic JSON write fails after creating a temporary file, it should remove the temporary file", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-json-write-")),
	);
	const targetDirectory = parseAbsolutePath(
		path.join(directory, "target.json"),
	);
	await mkdir(targetDirectory);
	await expect(writeJsonFile(targetDirectory, { ok: true })).rejects.toThrow();

	expect(await readdir(directory)).toEqual(["target.json"]);
});

it("when acquiring and releasing a store write lock, it should write diagnostic metadata and remove the lock", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-lock-acquire-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const paths = storeRootPaths(storePath);

	const metadata = await acquireStoreWriteLock({ storePath, now: fixedDate });

	expect(metadata).toEqual({
		pid: process.pid,
		createdAt: "2026-09-19T00:00:00.000Z",
		storePath,
	});
	expect(
		JSON.parse(await readFile(path.join(paths.lock, "metadata.json"), "utf8")),
	).toEqual(metadata);

	await releaseStoreWriteLock(storePath);
	await expect(
		readFile(path.join(paths.lock, "metadata.json")),
	).rejects.toMatchObject({
		code: "ENOENT",
	});
});

it("when a store write lock metadata write fails, it should remove the ownerless lock directory", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-lock-metadata-failure-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const paths = storeRootPaths(storePath);
	const failure = Object.assign(new Error("metadata write failed"), {
		code: "EACCES",
	});
	fsPromisesMock.writeFile.mockRejectedValueOnce(failure);

	await expect(
		acquireStoreWriteLock({ storePath, now: fixedDate }),
	).rejects.toBe(failure);
	await expect(readdir(paths.lock)).rejects.toMatchObject({ code: "ENOENT" });

	await acquireStoreWriteLock({ storePath, now: fixedDate });
	await releaseStoreWriteLock(storePath);
});

it("when a store write lock is contended, it should wait until the holder releases it", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-lock-contended-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const events: Array<string> = [];

	const first = withStoreWriteLock(
		{ storePath, now: fixedDate, retryDelayMs: 5 },
		Effect.tryPromise(async () => {
			events.push("first-start");
			await new Promise((resolve) => setTimeout(resolve, contendedLockHoldMs));
			events.push("first-end");
		}),
	);
	const second = withStoreWriteLock(
		{ storePath, now: fixedDate, retryDelayMs: 5 },
		Effect.tryPromise(async () => {
			events.push("second-start");
		}),
	);

	await Promise.all([first, second]);

	expect(events).toEqual(["first-start", "first-end", "second-start"]);
});

it("when the protected operation fails, it should still release the store write lock", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-lock-failing-work-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const paths = storeRootPaths(storePath);

	await expect(
		withStoreWriteLock(
			{ storePath, now: fixedDate },
			Effect.fail(new Error("boom")),
		),
	).rejects.toThrow("boom");

	await expect(
		readFile(path.join(paths.lock, "metadata.json")),
	).rejects.toMatchObject({
		code: "ENOENT",
	});
});
