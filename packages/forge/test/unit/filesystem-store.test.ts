import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { parseAbsolutePath } from "../../src/domain.ts";
import {
	ensureStoreRoot,
	loadForgeConfig,
	readStoreManifest,
	storeDoctor,
	writeForgeConfig,
} from "../../src/filesystem-store.ts";
import { storeRootPaths } from "../../src/store-paths.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");

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
