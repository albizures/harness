import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
	decodeForgeConfig,
	decodeProjectRegistryEntry,
	decodeStoreManifest,
	parseAbsolutePath,
	type AbsolutePath,
	type ForgeConfig,
	type StoreManifest,
} from "./domain.ts";
import { ForgeError } from "./errors.ts";
import { forgeConfigPath, storeRootPaths } from "./store-paths.ts";

export type StoreIndexFiles = {
	readonly byId: Readonly<Record<string, unknown>>;
	readonly byProject: Readonly<Record<string, unknown>>;
	readonly byInitiative: Readonly<Record<string, unknown>>;
	readonly relationships: Readonly<Record<string, unknown>>;
};

export type StoreDoctorProblem = {
	readonly path: string;
	readonly message: string;
	readonly repairable: boolean;
};

export type StoreDoctorReport = {
	readonly ok: boolean;
	readonly problems: ReadonlyArray<StoreDoctorProblem>;
	readonly repaired: ReadonlyArray<string>;
};

const defaultIndexes: StoreIndexFiles = {
	byId: {},
	byProject: {},
	byInitiative: {},
	relationships: {},
};

export async function loadForgeConfig(options: {
	readonly homeDirectory: AbsolutePath;
	readonly storePathOverride?: AbsolutePath;
}): Promise<ForgeConfig> {
	if (options.storePathOverride !== undefined) {
		return { storePath: options.storePathOverride };
	}
	const configPath = forgeConfigPath(options.homeDirectory);
	try {
		return decodeForgeConfig(await readJson(configPath));
	} catch (error) {
		if (isMissingFile(error)) {
			throw new ForgeError({
				kind: "config-missing",
				message:
					"Forge config is missing. Run `forge config set storePath <absolute-path>`.",
				cause: error,
				details: { configPath },
			});
		}
		throw error;
	}
}

export async function writeForgeConfig(options: {
	readonly homeDirectory: AbsolutePath;
	readonly config: ForgeConfig;
}): Promise<void> {
	const configPath = forgeConfigPath(options.homeDirectory);
	await writeJsonFile(configPath, options.config);
}

export async function ensureStoreRoot(options: {
	readonly storePath: AbsolutePath;
	readonly now?: Date;
}): Promise<void> {
	const now = iso(options.now ?? new Date());
	const paths = storeRootPaths(options.storePath);
	await mkdir(paths.root, { recursive: true });
	await Promise.all([
		mkdir(paths.projects, { recursive: true }),
		mkdir(paths.records, { recursive: true }),
		mkdir(paths.comments, { recursive: true }),
		mkdir(paths.updates, { recursive: true }),
		mkdir(paths.indexes, { recursive: true }),
	]);
	await writeFileIfMissing(paths.lock, "");
	await writeJsonFileIfMissing(paths.manifest, {
		schemaVersion: 1,
		nextRecordId: 1,
		createdAt: now,
		updatedAt: now,
	} satisfies StoreManifest);
	await ensureIndexFiles(options.storePath);
}

export async function readStoreManifest(
	storePath: AbsolutePath,
): Promise<StoreManifest> {
	return decodeStoreManifest(
		await readJson(storeRootPaths(storePath).manifest),
	);
}

export async function ensureIndexFiles(storePath: AbsolutePath): Promise<void> {
	const paths = storeRootPaths(storePath);
	await mkdir(paths.indexes, { recursive: true });
	await Promise.all([
		writeJsonFileIfMissing(paths.byIdIndex, defaultIndexes.byId),
		writeJsonFileIfMissing(paths.byProjectIndex, defaultIndexes.byProject),
		writeJsonFileIfMissing(
			paths.byInitiativeIndex,
			defaultIndexes.byInitiative,
		),
		writeJsonFileIfMissing(
			paths.relationshipsIndex,
			defaultIndexes.relationships,
		),
	]);
}

export async function storeDoctor(options: {
	readonly storePath: AbsolutePath;
	readonly repair?: boolean;
}): Promise<StoreDoctorReport> {
	const paths = storeRootPaths(options.storePath);
	const problems: Array<StoreDoctorProblem> = [];
	const repaired: Array<string> = [];

	for (const directory of [
		paths.root,
		paths.projects,
		paths.records,
		paths.comments,
		paths.updates,
		paths.indexes,
	]) {
		if (!(await isDirectory(directory))) {
			problems.push({
				path: directory,
				message: "Required store directory is missing.",
				repairable: true,
			});
			if (options.repair) {
				await mkdir(directory, { recursive: true });
				repaired.push(directory);
			}
		}
	}

	await checkJson(
		paths.manifest,
		problems,
		decodeStoreManifest,
		options.repair,
	);
	if (options.repair) {
		await ensureIndexFiles(options.storePath);
	}
	for (const indexPath of [
		paths.byIdIndex,
		paths.byProjectIndex,
		paths.byInitiativeIndex,
		paths.relationshipsIndex,
	]) {
		await checkJson(indexPath, problems, (value) => value, false);
	}
	await checkProjectFiles(paths.projects, problems);

	return { ok: problems.length === 0, problems, repaired };
}

export async function readJson(filePath: AbsolutePath): Promise<unknown> {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new ForgeError({
				kind: "store-invalid",
				message: `Invalid JSON at ${filePath}.`,
				cause: error,
				details: { path: filePath },
			});
		}
		throw error;
	}
}

export async function writeJsonFile(
	filePath: AbsolutePath,
	value: unknown,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = parseAbsolutePath(
		`${filePath}.tmp-${process.pid}-${Date.now()}`,
		"temporaryPath",
	);
	await writeFile(
		temporaryPath,
		`${JSON.stringify(value, null, "\t")}\n`,
		"utf8",
	);
	await rename(temporaryPath, filePath);
}

export async function writeJsonFileIfMissing(
	filePath: AbsolutePath,
	value: unknown,
): Promise<boolean> {
	if (await exists(filePath)) {
		return false;
	}
	await writeJsonFile(filePath, value);
	return true;
}

export async function removeFileIfExists(
	filePath: AbsolutePath,
): Promise<void> {
	await rm(filePath, { force: true });
}

async function writeFileIfMissing(
	filePath: AbsolutePath,
	content: string,
): Promise<boolean> {
	if (await exists(filePath)) {
		return false;
	}
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
	return true;
}

async function checkProjectFiles(
	projectsDirectory: AbsolutePath,
	problems: Array<StoreDoctorProblem>,
): Promise<void> {
	let files: Array<string>;
	try {
		files = await readdir(projectsDirectory);
	} catch (_error) {
		problems.push({
			path: projectsDirectory,
			message: "Project registry directory is unreadable.",
			repairable: true,
		});
		return;
	}
	const seenRoots = new Map<string, string>();
	for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
		const filePath = parseAbsolutePath(path.join(projectsDirectory, file));
		try {
			const project = decodeProjectRegistryEntry(await readJson(filePath));
			for (const root of project.roots) {
				const existing = seenRoots.get(root);
				if (existing !== undefined) {
					problems.push({
						path: filePath,
						message: `Project root duplicates root registered by '${existing}'.`,
						repairable: false,
					});
				} else {
					seenRoots.set(root, project.id);
				}
			}
		} catch (_error) {
			problems.push({
				path: filePath,
				message: "Project registry entry is invalid.",
				repairable: false,
			});
		}
	}
}

async function checkJson<T>(
	filePath: AbsolutePath,
	problems: Array<StoreDoctorProblem>,
	decode: (value: unknown) => T,
	repairMissing: boolean | undefined,
): Promise<void> {
	try {
		decode(await readJson(filePath));
	} catch (error) {
		const missing = isMissingFile(error);
		problems.push({
			path: filePath,
			message: missing
				? "Required JSON file is missing."
				: "JSON file is invalid.",
			repairable: missing,
		});
		if (missing && repairMissing) {
			await writeJsonFile(filePath, {});
		}
	}
}

async function exists(filePath: AbsolutePath): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw error;
	}
}

async function isDirectory(filePath: AbsolutePath): Promise<boolean> {
	try {
		return (await stat(filePath)).isDirectory();
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw error;
	}
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function iso(date: Date): StoreManifest["createdAt"] {
	return date.toISOString() as StoreManifest["createdAt"];
}
