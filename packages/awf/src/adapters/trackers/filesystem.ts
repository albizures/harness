import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createTrackerAdapter } from "../../runtime/tracker-intents.ts";
import type { TrackerAdapter } from "../../ports/tracker.ts";
import { WorkflowStateTracker } from "./memory.ts";
import {
	WorkflowTrackerState,
	type WorkflowTrackerStateSnapshot,
} from "./state.ts";
import { CorruptWorkflowProjectionError } from "../../domain/workflow/projection.ts";

const HEX_RADIX = 16;
const RANDOM_SUFFIX_START = 2;

export type FileSystemTrackerOptions = {
	path: string;
};

export function createFileSystemTracker(
	options: FileSystemTrackerOptions,
): TrackerAdapter {
	const directoryPath = resolve(options.path);
	const state = readState(directoryPath);
	return createTrackerAdapter(
		new WorkflowStateTracker(state, () =>
			writeState(directoryPath, state.snapshot()),
		),
	);
}

function readState(directoryPath: string): WorkflowTrackerState {
	if (!directoryExists(directoryPath)) {
		return new WorkflowTrackerState();
	}
	const issueFileNames = readStoredIssueFileNames(directoryPath);
	const issues = issueFileNames.map((fileName) =>
		readIssueFile(directoryPath, fileName),
	);
	return WorkflowTrackerState.fromSnapshot({
		version: 1,
		nextIssueNumber: nextIssueNumber(issueFileNames),
		issues,
	});
}

function readIssueFile(
	directoryPath: string,
	fileName: string,
): WorkflowTrackerStateSnapshot["issues"][number] {
	const filePath = join(directoryPath, fileName);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker issue at '${filePath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isStoredIssueLike(parsed)) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker issue at '${filePath}' has an unsupported or malformed schema.`,
		);
	}
	return parsed;
}

function writeState(
	directoryPath: string,
	snapshot: WorkflowTrackerStateSnapshot,
): void {
	mkdirSync(directoryPath, { recursive: true });
	const expectedIssueFiles = new Set(
		snapshot.issues.map((issue) => issueFileName(issue.id)),
	);
	for (const issue of snapshot.issues) {
		const filePath = join(directoryPath, issueFileName(issue.id));
		writeJsonAtomically(filePath, issue);
	}
	for (const fileName of readStoredIssueFileNames(directoryPath)) {
		if (!expectedIssueFiles.has(fileName)) {
			rmSync(join(directoryPath, fileName), { force: true });
		}
	}
}

function writeJsonAtomically(filePath: string, value: unknown): void {
	const randomSuffix = Math.random()
		.toString(HEX_RADIX)
		.slice(RANDOM_SUFFIX_START);
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomSuffix}`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(tempPath, filePath);
	} catch (error) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker issue at '${filePath}' could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function directoryExists(directoryPath: string): boolean {
	try {
		return statSync(directoryPath).isDirectory();
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

function readStoredIssueFileNames(directoryPath: string): Array<string> {
	return readdirSync(directoryPath, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.includes(".tmp-"))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

function nextIssueNumber(issueFileNames: Array<string>): number {
	const highest = Math.max(
		0,
		...issueFileNames.map((fileName) => numericIssueId(fileName) ?? 0),
	);
	return highest + 1;
}

function issueFileName(id: string): string {
	return id;
}

function numericIssueId(fileName: string): number | undefined {
	if (!/^\d+$/u.test(fileName)) {
		return undefined;
	}
	const numeric = Number(fileName);
	return Number.isSafeInteger(numeric) && numeric >= 1 ? numeric : undefined;
}

function isStoredIssueLike(
	value: unknown,
): value is WorkflowTrackerStateSnapshot["issues"][number] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const issue = value as Record<string, unknown>;
	return (
		Object.keys(issue).every((key) =>
			[
				"id",
				"title",
				"body",
				"workflow",
				"relationships",
				"logs",
				"labels",
				"projectionError",
			].includes(key),
		) &&
		typeof issue.id === "string" &&
		typeof issue.title === "string" &&
		issue.workflow !== null &&
		typeof issue.workflow === "object" &&
		issue.relationships !== null &&
		typeof issue.relationships === "object" &&
		Array.isArray(issue.logs) &&
		issue.logs.every(isStoredLogLike)
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
		(log.message === undefined || typeof log.message === "string") &&
		log.payload === undefined
	);
}
