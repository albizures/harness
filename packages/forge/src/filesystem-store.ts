import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileSystem } from "@effect/platform/FileSystem";
import type { FileSystem as FileSystemService } from "@effect/platform/FileSystem";
import { Effect } from "effect";
import { parseDocument } from "yaml";

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

export type StoreWriteLockMetadata = {
	readonly pid: number;
	readonly createdAt: string;
	readonly storePath: AbsolutePath;
};

export type StoreWriteLockOptions = {
	readonly storePath: AbsolutePath;
	readonly now?: Date;
	readonly retryDelayMs?: number;
	readonly timeoutMs?: number;
};

const defaultIndexes: StoreIndexFiles = {
	byId: {},
	byProject: {},
	byInitiative: {},
	relationships: {},
};

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

export function writeForgeConfigEffect(options: {
	readonly homeDirectory: AbsolutePath;
	readonly config: ForgeConfig;
}) {
	return writeJsonFileEffect(
		forgeConfigPath(options.homeDirectory),
		options.config,
	);
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
		yield* migrateLegacyLockPathEffect(paths.lock);
		yield* writeJsonFileIfMissingEffect(paths.manifest, {
			schemaVersion: 1,
			nextRecordId: 1,
			createdAt: now,
			updatedAt: now,
		} satisfies StoreManifest);
		yield* ensureIndexFilesEffect(options.storePath);
	});
}

export function withStoreWriteLockEffect<A, E, R>(
	options: StoreWriteLockOptions,
	program: Effect.Effect<A, E, R>,
) {
	return Effect.gen(function* () {
		yield* acquireStoreWriteLockEffect(options);
		return yield* program.pipe(
			Effect.ensuring(
				releaseStoreWriteLockEffect(options.storePath).pipe(Effect.ignore),
			),
		);
	});
}

export function acquireStoreWriteLockEffect(options: StoreWriteLockOptions) {
	return Effect.tryPromise({
		try: async () => {
			const retryDelayMs = options.retryDelayMs ?? 25;
			const timeoutMs = options.timeoutMs ?? 30_000;
			const startedAt = Date.now();
			const lockPath = storeRootPaths(options.storePath).lock;
			const metadata: StoreWriteLockMetadata = {
				pid: process.pid,
				createdAt: iso(options.now ?? new Date()),
				storePath: options.storePath,
			};

			for (;;) {
				let createdLockDirectory = false;
				try {
					await mkdir(lockPath);
					createdLockDirectory = true;
					await writeFile(
						path.join(lockPath, "metadata.json"),
						`${JSON.stringify(metadata, null, "\t")}\n`,
						"utf8",
					);
					return metadata;
				} catch (error) {
					if (!isAlreadyExistsError(error)) {
						if (createdLockDirectory) {
							await rm(lockPath, { recursive: true, force: true });
						}
						throw error;
					}
					if (Date.now() - startedAt >= timeoutMs) {
						throw new ForgeError({
							kind: "store-invalid",
							message: `Timed out acquiring Forge store write lock at ${lockPath}.`,
							details: { lockPath, timeoutMs },
						});
					}
					await sleep(retryDelayMs);
				}
			}
		},
		catch: (error) => error,
	});
}

export function releaseStoreWriteLockEffect(storePath: AbsolutePath) {
	return Effect.tryPromise({
		try: () =>
			rm(storeRootPaths(storePath).lock, { recursive: true, force: true }),
		catch: (error) => error,
	});
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
		yield* checkDuplicateRecordIdsEffect(paths.records, problems);

		return { ok: problems.length === 0, problems, repaired };
	});
}

export function readTextFileEffect(filePath: string) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.readFileString(filePath, "utf8");
	});
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

export function removeFileIfExistsEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		yield* fileSystem
			.remove(filePath, { recursive: false })
			.pipe(Effect.catchIf(isMissingFile, () => Effect.void));
	});
}

function migrateLegacyLockPathEffect(lockPath: AbsolutePath) {
	return Effect.gen(function* () {
		if (yield* isDirectoryEffect(lockPath)) {
			return;
		}
		if (yield* existsEffect(lockPath)) {
			yield* removeFileIfExistsEffect(lockPath);
		}
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

function checkDuplicateRecordIdsEffect(
	recordsDirectory: AbsolutePath,
	problems: Array<StoreDoctorProblem>,
): Effect.Effect<void, unknown, FileSystemService> {
	return Effect.gen(function* () {
		const recordFiles = yield* listMarkdownFilesEffect(recordsDirectory).pipe(
			Effect.catchAll(() => Effect.succeed<Array<AbsolutePath>>([])),
		);
		const pathsById = new Map<number, Array<AbsolutePath>>();

		for (const filePath of recordFiles) {
			const id = yield* readRecordFrontmatterIdEffect(filePath).pipe(
				Effect.catchAll(() => Effect.succeed(undefined)),
			);
			if (id === undefined) {
				continue;
			}
			pathsById.set(id, [...(pathsById.get(id) ?? []), filePath]);
		}

		for (const [id, filePaths] of [...pathsById.entries()].sort(
			([left], [right]) => left - right,
		)) {
			if (filePaths.length < 2) {
				continue;
			}
			const sortedPaths = [...filePaths].sort();
			problems.push({
				path: recordsDirectory,
				message: `Duplicate record id '${id}' found in record files: ${sortedPaths.join(", ")}.`,
				repairable: false,
			});
		}
	});
}

function listMarkdownFilesEffect(
	directoryPath: AbsolutePath,
): Effect.Effect<Array<AbsolutePath>, unknown, FileSystemService> {
	return Effect.gen(function* () {
		const files = yield* readDirectoryEffect(directoryPath);
		const markdownFiles: Array<AbsolutePath> = [];
		for (const file of files) {
			const filePath = parseAbsolutePath(path.join(directoryPath, file));
			if (yield* isDirectoryEffect(filePath)) {
				markdownFiles.push(...(yield* listMarkdownFilesEffect(filePath)));
			} else if (file.endsWith(".md")) {
				markdownFiles.push(filePath);
			}
		}
		return markdownFiles;
	});
}

function readRecordFrontmatterIdEffect(
	filePath: AbsolutePath,
): Effect.Effect<number | undefined, unknown, FileSystemService> {
	return Effect.gen(function* () {
		const markdown = yield* readTextFileEffect(filePath);
		const frontmatter = splitRecordFrontmatter(markdown);
		const document = parseDocument(frontmatter, {
			keepSourceTokens: true,
			uniqueKeys: false,
		});
		if (document.errors.length > 0) {
			return undefined;
		}
		const value = document.toJSON();
		if (
			typeof value === "object" &&
			value !== null &&
			"id" in value &&
			Number.isInteger(value.id)
		) {
			return value.id;
		}
		return undefined;
	});
}

function splitRecordFrontmatter(markdown: string) {
	const lines = markdown.split("\n");
	if (lines[0] !== "---") {
		throw new ForgeError({
			kind: "store-invalid",
			message: "Record Markdown is missing frontmatter.",
		});
	}
	const end = lines.indexOf("---", 1);
	if (end === -1) {
		throw new ForgeError({
			kind: "store-invalid",
			message: "Record Markdown has unterminated frontmatter.",
		});
	}
	return lines.slice(1, end).join("\n");
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

function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

function sleep(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
