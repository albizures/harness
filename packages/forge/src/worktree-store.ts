import path from "node:path";

import { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";

import {
	decodeWorktreeRecord,
	parseAbsolutePath,
	type AbsolutePath,
	type WorktreeId,
	type WorktreeRecord,
} from "./domain.ts";
import { ForgeError } from "./errors.ts";
import {
	readJsonEffect,
	withStoreWriteLockEffect,
	writeJsonFileEffect,
} from "./filesystem-store.ts";
import { storeRootPaths, worktreeRecordFilePath } from "./store-paths.ts";

export function writeWorktreeRecordEffect(options: {
	readonly storePath: AbsolutePath;
	readonly record: WorktreeRecord;
}) {
	return withStoreWriteLockEffect(
		{ storePath: options.storePath },
		Effect.gen(function* () {
			const record = yield* Effect.try({
				try: () => decodeWorktreeRecord(options.record),
				catch: (error) => error,
			});
			yield* writeJsonFileEffect(
				worktreeRecordFilePath(options.storePath, record.id),
				record,
			);
			return record;
		}),
	);
}

export function readWorktreeRecordEffect(options: {
	readonly storePath: AbsolutePath;
	readonly worktreeId: WorktreeId;
}) {
	return Effect.gen(function* () {
		const json = yield* readJsonEffect(
			worktreeRecordFilePath(options.storePath, options.worktreeId),
		).pipe(
			Effect.catchAll((error) => {
				if (isMissingFile(error)) {
					return Effect.fail(
						new ForgeError({
							kind: "record-not-found",
							message: `Worktree record '${options.worktreeId}' was not found.`,
							details: { worktreeId: options.worktreeId },
						}),
					);
				}
				return Effect.fail(error);
			}),
		);
		return yield* Effect.try({
			try: () => decodeWorktreeRecord(json),
			catch: (error) => error,
		});
	});
}

export function listWorktreeRecordsEffect(storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const directory = storeRootPaths(storePath).worktreeRecords;
		const files = yield* readDirectoryEffect(directory).pipe(
			Effect.catchAll((error) => {
				if (isMissingFile(error)) {
					return Effect.succeed([]);
				}
				return Effect.fail(error);
			}),
		);
		const records = yield* Effect.all(
			files
				.filter((file) => file.endsWith(".json"))
				.sort()
				.map((file) =>
					Effect.gen(function* () {
						const json = yield* readJsonEffect(
							parseAbsolutePath(path.join(directory, file)),
						);
						return yield* Effect.try({
							try: () => decodeWorktreeRecord(json),
							catch: (error) => error,
						});
					}),
				),
			{ concurrency: "unbounded" },
		);
		return records.sort((left, right) => left.id.localeCompare(right.id));
	});
}

function readDirectoryEffect(directoryPath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.readDirectory(directoryPath);
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
