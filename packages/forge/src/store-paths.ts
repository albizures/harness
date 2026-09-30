import path from "node:path";

import type { AbsolutePath, ProjectId } from "./domain.ts";
import { parseAbsolutePath } from "./domain.ts";
import type { CommentId, RecordId, RecordKind } from "./record-domain.ts";

export const configFileRelativePath = ".config/forge/config.json";

const recordIdWidth = 6;
const recordShardWidth = 3;
const commentSequenceWidth = 4;
const recordsPerShard = 1000;

export type StoreRootPaths = {
	readonly root: AbsolutePath;
	readonly manifest: AbsolutePath;
	readonly lock: AbsolutePath;
	readonly projects: AbsolutePath;
	readonly records: AbsolutePath;
	readonly comments: AbsolutePath;
	readonly updates: AbsolutePath;
	readonly indexes: AbsolutePath;
	readonly byIdIndex: AbsolutePath;
	readonly byProjectIndex: AbsolutePath;
	readonly byInitiativeIndex: AbsolutePath;
	readonly relationshipsIndex: AbsolutePath;
};

export function forgeConfigPath(homeDirectory: AbsolutePath): AbsolutePath {
	return parseAbsolutePath(
		path.join(homeDirectory, configFileRelativePath),
		"configPath",
	);
}

export function storeRootPaths(storePath: AbsolutePath): StoreRootPaths {
	return {
		root: storePath,
		manifest: joinAbsolute(storePath, "manifest.json"),
		lock: joinAbsolute(storePath, "lock"),
		projects: joinAbsolute(storePath, "projects"),
		records: joinAbsolute(storePath, "records"),
		comments: joinAbsolute(storePath, "comments"),
		updates: joinAbsolute(storePath, "updates"),
		indexes: joinAbsolute(storePath, "indexes"),
		byIdIndex: joinAbsolute(storePath, "indexes", "by-id.json"),
		byProjectIndex: joinAbsolute(storePath, "indexes", "by-project.json"),
		byInitiativeIndex: joinAbsolute(storePath, "indexes", "by-initiative.json"),
		relationshipsIndex: joinAbsolute(
			storePath,
			"indexes",
			"relationships.json",
		),
	};
}

export function projectFilePath(
	storePath: AbsolutePath,
	projectId: ProjectId,
): AbsolutePath {
	return joinAbsolute(storePath, "projects", `${projectId}.json`);
}

export function recordFilePath(
	storePath: AbsolutePath,
	kind: RecordKind,
	recordId: RecordId,
): AbsolutePath {
	return joinAbsolute(
		storePath,
		"records",
		kind,
		recordShard(recordId),
		`${paddedRecordId(recordId)}.md`,
	);
}

export function recordRelativePath(
	kind: RecordKind,
	recordId: RecordId,
): string {
	return path.join(
		"records",
		kind,
		recordShard(recordId),
		`${paddedRecordId(recordId)}.md`,
	);
}

export function commentFilePath(
	storePath: AbsolutePath,
	recordId: RecordId,
	commentId: CommentId,
): AbsolutePath {
	return joinAbsolute(
		storePath,
		"comments",
		recordShard(recordId),
		paddedRecordId(recordId),
		`${commentId.toString().padStart(commentSequenceWidth, "0")}.md`,
	);
}

export function updateFilePath(
	storePath: AbsolutePath,
	recordId: RecordId,
	sequence: number,
	type: string,
): AbsolutePath {
	return joinAbsolute(
		storePath,
		"updates",
		recordShard(recordId),
		paddedRecordId(recordId),
		`${sequence.toString().padStart(commentSequenceWidth, "0")}-${sanitizeUpdateType(type)}.json`,
	);
}

export function paddedRecordId(recordId: number): string {
	return recordId.toString().padStart(recordIdWidth, "0");
}

export function recordShard(recordId: number): string {
	return Math.floor(recordId / recordsPerShard)
		.toString()
		.padStart(recordShardWidth, "0");
}

export function joinAbsolute(
	root: AbsolutePath,
	...segments: Array<string>
): AbsolutePath {
	return parseAbsolutePath(path.join(root, ...segments));
}

function sanitizeUpdateType(type: string): string {
	return type.replace(/[^a-z0-9-]/g, "-");
}
