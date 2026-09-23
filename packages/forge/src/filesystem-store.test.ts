import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseAbsolutePath } from "./domain.ts";
import {
	ensureStoreRoot,
	loadForgeConfig,
	readStoreManifest,
	storeDoctor,
	writeForgeConfig,
} from "./filesystem-store.ts";
import { storeRootPaths } from "./store-paths.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");

test("when ensuring a store root, it should create root files and indexes conservatively", async () => {
	const directory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-store-")),
	);
	await ensureStoreRoot({ storePath: directory, now: fixedDate });
	const manifest = await readStoreManifest(directory);
	assert.equal(manifest.nextRecordId, 1);
	assert.equal(manifest.createdAt, fixedDate.toISOString());

	const paths = storeRootPaths(directory);
	await ensureStoreRoot({
		storePath: directory,
		now: new Date("2027-01-01T00:00:00.000Z"),
	});
	assert.equal(
		(await readStoreManifest(directory)).createdAt,
		fixedDate.toISOString(),
	);
	assert.equal(await readFile(paths.byIdIndex, "utf8"), "{}\n");
});

test("when config is written, it should round-trip an absolute store path", async () => {
	const homeDirectory = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-home-")),
	);
	const storePath = parseAbsolutePath(path.join(homeDirectory, "store"));
	await writeForgeConfig({ homeDirectory, config: { storePath } });
	assert.deepEqual(await loadForgeConfig({ homeDirectory }), { storePath });
});

test("when doctor checks a valid store, it should report ok", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-doctor-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const report = await storeDoctor({ storePath });
	assert.equal(report.ok, true);
	assert.deepEqual(report.problems, []);
});
