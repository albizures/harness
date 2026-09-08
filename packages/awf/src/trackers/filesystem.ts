import {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isJsonRecord } from "../json.ts";
import { createTrackerAdapter } from "../tracker-intents.ts";
import type { TrackerAdapter } from "../tracker.ts";
import { WorkflowStateTracker } from "./memory.ts";
import {
	WorkflowTrackerState,
	type WorkflowTrackerStateSnapshot,
} from "./state.ts";
import { CorruptWorkflowProjectionError } from "../workflow/projection.ts";

const HEX_RADIX = 16;
const RANDOM_SUFFIX_START = 2;

export type FileSystemTrackerOptions = {
	path: string;
};

export function createFileSystemTracker(
	options: FileSystemTrackerOptions,
): TrackerAdapter {
	const filePath = resolve(options.path);
	const state = readState(filePath);
	return createTrackerAdapter(
		new WorkflowStateTracker(state, () =>
			writeState(filePath, state.snapshot()),
		),
	);
}

function readState(filePath: string): WorkflowTrackerState {
	if (!fileExists(filePath)) {
		return new WorkflowTrackerState();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker state at '${filePath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isWorkflowTrackerStateSnapshot(parsed)) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker state at '${filePath}' has an unsupported or malformed schema.`,
		);
	}
	return WorkflowTrackerState.fromSnapshot(parsed);
}

function writeState(
	filePath: string,
	snapshot: WorkflowTrackerStateSnapshot,
): void {
	const directory = dirname(filePath);
	mkdirSync(directory, { recursive: true });
	const randomSuffix = Math.random()
		.toString(HEX_RADIX)
		.slice(RANDOM_SUFFIX_START);
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomSuffix}`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
		renameSync(tempPath, filePath);
	} catch (error) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker state at '${filePath}' could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function fileExists(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return false;
		}
		throw error;
	}
}

function isWorkflowTrackerStateSnapshot(
	value: unknown,
): value is WorkflowTrackerStateSnapshot {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<WorkflowTrackerStateSnapshot>;
	return (
		candidate.version === 1 &&
		typeof candidate.nextIssueNumber === "number" &&
		Number.isInteger(candidate.nextIssueNumber) &&
		candidate.nextIssueNumber >= 1 &&
		Array.isArray(candidate.issues) &&
		candidate.issues.every(isStoredIssueLike) &&
		(candidate.artifacts === undefined ||
			isStoredArtifactsByIssue(candidate.artifacts)) &&
		(candidate.changes === undefined ||
			isStoredChangesByIssue(candidate.changes))
	);
}

function isStoredIssueLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const issue = value as Record<string, unknown>;
	return (
		typeof issue.id === "string" &&
		typeof issue.title === "string" &&
		issue.workflow !== null &&
		typeof issue.workflow === "object" &&
		issue.relationships !== null &&
		typeof issue.relationships === "object" &&
		issue.artifacts === undefined &&
		issue.changes === undefined &&
		Array.isArray(issue.logs) &&
		issue.logs.every(isStoredLogLike)
	);
}

function isStoredArtifactLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const artifact = value as Record<string, unknown>;
	return (
		typeof artifact.id === "string" &&
		typeof artifact.kind === "string" &&
		typeof artifact.uri === "string" &&
		(artifact.metadata === undefined || isJsonRecord(artifact.metadata))
	);
}

function isStoredChangesByIssue(value: unknown): boolean {
	return (
		isJsonRecord(value) &&
		Object.values(value).every(
			(changes) => Array.isArray(changes) && changes.every(isStoredChangeLike),
		)
	);
}

function isStoredArtifactsByIssue(value: unknown): boolean {
	return (
		isJsonRecord(value) &&
		Object.values(value).every(
			(artifacts) =>
				Array.isArray(artifacts) && artifacts.every(isStoredArtifactLike),
		)
	);
}

function isStoredChangeLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const change = value as Record<string, unknown>;
	return (
		typeof change.id === "string" &&
		typeof change.kind === "string" &&
		typeof change.uri === "string" &&
		(change.summary === undefined || typeof change.summary === "string")
	);
}

function isStoredLogLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const log = value as Record<string, unknown>;
	return (
		typeof log.sequence === "number" &&
		typeof log.issueId === "string" &&
		typeof log.type === "string" &&
		(log.runId === undefined || typeof log.runId === "string") &&
		(log.message === undefined || typeof log.message === "string") &&
		log.payload === undefined
	);
}
