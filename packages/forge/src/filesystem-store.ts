import { randomUUID } from "node:crypto";
import path from "node:path";

import { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";

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
import { runForgePromise } from "./runtime.ts";
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

export function loadForgeConfig(options: {
	readonly homeDirectory: AbsolutePath;
	readonly storePathOverride?: AbsolutePath;
}): Promise<ForgeConfig> {
	return runForgePromise(loadForgeConfigEffect(options));
}

export function loadForgeConfigEffect(options: {
	readonly homeDirectory: AbsolutePath;
	readonly storePathOverride?: AbsolutePath;
}) {
	return Effect.gen(function* () {
		if (options.storePathOverride !== undefined) {
			return { storePath: options.storePathOverride };
		}
		const configPath = forgeConfigPath(options.homeDirectory);
		const configJson = yield* readJsonEffect(configPath).pipe(
			Effect.catchAll((error) => {
				if (isMissingFile(error)) {
					return Effect.fail(
						new ForgeError({
							kind: "config-missing",
							message:
								"Forge config is missing. Run `forge config set storePath <absolute-path>`.",
							cause: error,
							details: { configPath },
						}),
					);
				}
				return Effect.fail(error);
			}),
		);
		return yield* Effect.try({
			try: () => decodeForgeConfig(configJson),
			catch: (error) => error,
		});
	});
}

export function writeForgeConfig(options: {
	readonly homeDirectory: AbsolutePath;
	readonly config: ForgeConfig;
}): Promise<void> {
	return runForgePromise(writeForgeConfigEffect(options));
}

export function writeForgeConfigEffect(options: {
	readonly homeDirectory: AbsolutePath;
	readonly config: ForgeConfig;
}) {
	return writeJsonFileEffect(
		forgeConfigPath(options.homeDirectory),
		options.config,
	);
}

export function ensureStoreRoot(options: {
	readonly storePath: AbsolutePath;
	readonly now?: Date;
}): Promise<void> {
	return runForgePromise(ensureStoreRootEffect(options));
}

export function ensureStoreRootEffect(options: {
	readonly storePath: AbsolutePath;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const now = iso(options.now ?? new Date());
		const paths = storeRootPaths(options.storePath);
		yield* makeDirectoryEffect(paths.root);
		yield* Effect.all(
			[
				makeDirectoryEffect(paths.projects),
				makeDirectoryEffect(paths.records),
				makeDirectoryEffect(paths.comments),
				makeDirectoryEffect(paths.updates),
				makeDirectoryEffect(paths.indexes),
			],
			{ concurrency: "unbounded" },
		);
		yield* writeFileIfMissingEffect(paths.lock, "");
		yield* writeJsonFileIfMissingEffect(paths.manifest, {
			schemaVersion: 1,
			nextRecordId: 1,
			createdAt: now,
			updatedAt: now,
		} satisfies StoreManifest);
		yield* ensureIndexFilesEffect(options.storePath);
	});
}

export function readStoreManifest(
	storePath: AbsolutePath,
): Promise<StoreManifest> {
	return runForgePromise(readStoreManifestEffect(storePath));
}

export function readStoreManifestEffect(storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const manifestJson = yield* readJsonEffect(
			storeRootPaths(storePath).manifest,
		);
		return yield* Effect.try({
			try: () => decodeStoreManifest(manifestJson),
			catch: (error) => error,
		});
	});
}

export function ensureIndexFiles(storePath: AbsolutePath): Promise<void> {
	return runForgePromise(ensureIndexFilesEffect(storePath));
}

export function ensureIndexFilesEffect(storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const paths = storeRootPaths(storePath);
		yield* makeDirectoryEffect(paths.indexes);
		yield* Effect.all(
			[
				writeJsonFileIfMissingEffect(paths.byIdIndex, defaultIndexes.byId),
				writeJsonFileIfMissingEffect(
					paths.byProjectIndex,
					defaultIndexes.byProject,
				),
				writeJsonFileIfMissingEffect(
					paths.byInitiativeIndex,
					defaultIndexes.byInitiative,
				),
				writeJsonFileIfMissingEffect(
					paths.relationshipsIndex,
					defaultIndexes.relationships,
				),
			],
			{ concurrency: "unbounded" },
		);
	});
}

export function storeDoctor(options: {
	readonly storePath: AbsolutePath;
	readonly repair?: boolean;
}): Promise<StoreDoctorReport> {
	return runForgePromise(storeDoctorEffect(options));
}

export function storeDoctorEffect(options: {
	readonly storePath: AbsolutePath;
	readonly repair?: boolean;
}) {
	return Effect.gen(function* () {
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
			if (!(yield* isDirectoryEffect(directory))) {
				problems.push({
					path: directory,
					message: "Required store directory is missing.",
					repairable: true,
				});
				if (options.repair) {
					yield* makeDirectoryEffect(directory);
					repaired.push(directory);
				}
			}
		}

		yield* checkJsonEffect(
			paths.manifest,
			problems,
			decodeStoreManifest,
			options.repair,
		);
		if (options.repair) {
			yield* ensureIndexFilesEffect(options.storePath);
		}
		for (const indexPath of [
			paths.byIdIndex,
			paths.byProjectIndex,
			paths.byInitiativeIndex,
			paths.relationshipsIndex,
		]) {
			yield* checkJsonEffect(indexPath, problems, (value) => value, false);
		}
		yield* checkProjectFilesEffect(paths.projects, problems);

		return { ok: problems.length === 0, problems, repaired };
	});
}

export function readTextFile(filePath: string): Promise<string> {
	return runForgePromise(readTextFileEffect(filePath));
}

export function readTextFileEffect(filePath: string) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.readFileString(filePath, "utf8");
	});
}

export function readJson(filePath: AbsolutePath): Promise<unknown> {
	return runForgePromise(readJsonEffect(filePath));
}

export function readJsonEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const content = yield* readTextFileEffect(filePath).pipe(
			Effect.catchAll((error) => Effect.fail(normalizeMissingFile(error))),
		);
		return yield* Effect.try({
			try: () => JSON.parse(content) as unknown,
			catch: (error) => {
				if (error instanceof SyntaxError) {
					return new ForgeError({
						kind: "store-invalid",
						message: `Invalid JSON at ${filePath}.`,
						cause: error,
						details: { path: filePath },
					});
				}
				return error;
			},
		});
	});
}

export function writeJsonFile(
	filePath: AbsolutePath,
	value: unknown,
): Promise<void> {
	return runForgePromise(writeJsonFileEffect(filePath, value));
}

export function writeJsonFileEffect(filePath: AbsolutePath, value: unknown) {
	return Effect.gen(function* () {
		const temporaryPath = parseAbsolutePath(
			`${filePath}.tmp-${process.pid}-${randomUUID()}`,
			"temporaryPath",
		);
		yield* Effect.gen(function* () {
			yield* writeFileEffect(
				temporaryPath,
				`${JSON.stringify(value, null, "\t")}\n`,
			);
			const fileSystem = yield* FileSystem;
			yield* fileSystem.rename(temporaryPath, filePath);
		}).pipe(
			Effect.ensuring(
				removeFileIfExistsEffect(temporaryPath).pipe(Effect.ignore),
			),
		);
	});
}

export function writeJsonFileIfMissing(
	filePath: AbsolutePath,
	value: unknown,
): Promise<boolean> {
	return runForgePromise(writeJsonFileIfMissingEffect(filePath, value));
}

export function writeJsonFileIfMissingEffect(
	filePath: AbsolutePath,
	value: unknown,
) {
	return Effect.gen(function* () {
		if (yield* existsEffect(filePath)) {
			return false;
		}
		yield* writeJsonFileEffect(filePath, value);
		return true;
	});
}

export function removeFileIfExists(filePath: AbsolutePath): Promise<void> {
	return runForgePromise(removeFileIfExistsEffect(filePath));
}

export function removeFileIfExistsEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		yield* fileSystem
			.remove(filePath, { recursive: false })
			.pipe(Effect.catchIf(isMissingFile, () => Effect.void));
	});
}

function writeFileIfMissingEffect(filePath: AbsolutePath, content: string) {
	return Effect.gen(function* () {
		if (yield* existsEffect(filePath)) {
			return false;
		}
		yield* writeFileEffect(filePath, content);
		return true;
	});
}

function writeFileEffect(filePath: AbsolutePath, content: string) {
	return Effect.gen(function* () {
		yield* makeDirectoryEffect(parseAbsolutePath(path.dirname(filePath)));
		const fileSystem = yield* FileSystem;
		yield* fileSystem.writeFileString(filePath, content);
	});
}

function makeDirectoryEffect(directoryPath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		yield* fileSystem.makeDirectory(directoryPath, { recursive: true });
	});
}

function checkProjectFilesEffect(
	projectsDirectory: AbsolutePath,
	problems: Array<StoreDoctorProblem>,
) {
	return Effect.gen(function* () {
		const files = yield* readDirectoryEffect(projectsDirectory).pipe(
			Effect.catchAll(() => {
				problems.push({
					path: projectsDirectory,
					message: "Project registry directory is unreadable.",
					repairable: true,
				});
				return Effect.succeed(undefined);
			}),
		);
		if (files === undefined) {
			return;
		}

		const seenRoots = new Map<string, string>();
		for (const file of files.filter((candidate) =>
			candidate.endsWith(".json"),
		)) {
			const filePath = parseAbsolutePath(path.join(projectsDirectory, file));
			yield* Effect.gen(function* () {
				const projectJson = yield* readJsonEffect(filePath);
				const project = yield* Effect.try({
					try: () => decodeProjectRegistryEntry(projectJson),
					catch: (error) => error,
				});
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
			}).pipe(
				Effect.catchAll(() => {
					problems.push({
						path: filePath,
						message: "Project registry entry is invalid.",
						repairable: false,
					});
					return Effect.void;
				}),
			);
		}
	});
}

function checkJsonEffect<T>(
	filePath: AbsolutePath,
	problems: Array<StoreDoctorProblem>,
	decode: (value: unknown) => T,
	repairMissing: boolean | undefined,
) {
	return Effect.gen(function* () {
		yield* Effect.gen(function* () {
			const json = yield* readJsonEffect(filePath);
			yield* Effect.try({
				try: () => decode(json),
				catch: (error) => error,
			});
		}).pipe(
			Effect.catchAll((error) => {
				const missing = isMissingFile(error);
				problems.push({
					path: filePath,
					message: missing
						? "Required JSON file is missing."
						: "JSON file is invalid.",
					repairable: missing,
				});
				if (missing && repairMissing) {
					return writeJsonFileEffect(filePath, {});
				}
				return Effect.void;
			}),
		);
	});
}

function readDirectoryEffect(directoryPath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.readDirectory(directoryPath);
	});
}

function existsEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.exists(filePath);
	});
}

function isDirectoryEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		const info = yield* fileSystem
			.stat(filePath)
			.pipe(Effect.catchIf(isMissingFile, () => Effect.succeed(undefined)));
		return info?.type === "Directory";
	});
}

function normalizeMissingFile(error: unknown): unknown {
	if (
		!isMissingFile(error) &&
		!String(error).includes("NotFound: FileSystem.readFile")
	) {
		return error;
	}
	return Object.assign(new Error("File does not exist."), {
		code: "ENOENT",
		cause: error,
	});
}

function isMissingFile(error: unknown): boolean {
	return (
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT") ||
		(typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "SystemError" &&
			"reason" in error &&
			error.reason === "NotFound")
	);
}

function iso(date: Date): StoreManifest["createdAt"] {
	return date.toISOString() as StoreManifest["createdAt"];
}
