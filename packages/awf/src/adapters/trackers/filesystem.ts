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
const FRONTMATTER_DELIMITER = "---";
const LOGS_SECTION_MARKER = "<!-- awf:logs v1 -->";

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
	const parsed = parseIssueMarkdown(filePath, readFileSync(filePath, "utf8"));
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
		writeMarkdownAtomically(filePath, issue);
	}
	for (const fileName of readStoredIssueFileNames(directoryPath)) {
		if (!expectedIssueFiles.has(fileName)) {
			rmSync(join(directoryPath, fileName), { force: true });
		}
	}
}

function writeMarkdownAtomically(
	filePath: string,
	issue: WorkflowTrackerStateSnapshot["issues"][number],
): void {
	const randomSuffix = Math.random()
		.toString(HEX_RADIX)
		.slice(RANDOM_SUFFIX_START);
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomSuffix}`;
	try {
		writeFileSync(tempPath, formatIssueMarkdown(issue), "utf8");
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
		.filter(
			(entry) =>
				entry.isFile() &&
				!entry.name.includes(".tmp-") &&
				/^\d+\.md$/u.test(entry.name),
		)
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
	return `${id}.md`;
}

function numericIssueId(fileName: string): number | undefined {
	const match = /^(\d+)\.md$/u.exec(fileName);
	if (match === null) {
		return undefined;
	}
	const numeric = Number(match[1]);
	return Number.isSafeInteger(numeric) && numeric >= 1 ? numeric : undefined;
}

function formatIssueMarkdown(
	issue: WorkflowTrackerStateSnapshot["issues"][number],
): string {
	const frontmatter = [
		FRONTMATTER_DELIMITER,
		`id: ${JSON.stringify(issue.id)}`,
		`title: ${JSON.stringify(issue.title)}`,
		`workflow: ${JSON.stringify(issue.workflow)}`,
		`relationships: ${JSON.stringify(issue.relationships)}`,
		FRONTMATTER_DELIMITER,
	].join("\n");
	const body = issue.body ?? "";
	const logs = JSON.stringify(issue.logs, null, 2);
	return `${frontmatter}\n\n${body}\n\n${LOGS_SECTION_MARKER}\n\n\`\`\`json\n${logs}\n\`\`\`\n`;
}

function parseIssueMarkdown(
	filePath: string,
	content: string,
): WorkflowTrackerStateSnapshot["issues"][number] {
	try {
		const { frontmatter, bodyAndLogs } = splitFrontmatter(content);
		const logsIndex = bodyAndLogs.indexOf(LOGS_SECTION_MARKER);
		if (logsIndex === -1) {
			throw new Error("missing reserved logs section");
		}
		const body = bodyAndLogs.slice(0, logsIndex).replace(/\n{0,2}$/u, "");
		const logsSection = bodyAndLogs.slice(
			logsIndex + LOGS_SECTION_MARKER.length,
		);
		const logs = parseLogs(logsSection);
		const metadata = parseFrontmatter(frontmatter);
		return {
			id: requireStringMetadata(metadata, "id"),
			title: requireStringMetadata(metadata, "title"),
			...(body === "" ? {} : { body }),
			workflow: requireObjectMetadata(
				metadata,
				"workflow",
			) as WorkflowTrackerStateSnapshot["issues"][number]["workflow"],
			relationships: requireObjectMetadata(
				metadata,
				"relationships",
			) as WorkflowTrackerStateSnapshot["issues"][number]["relationships"],
			logs,
		};
	} catch (error) {
		throw new CorruptWorkflowProjectionError(
			`File-backed tracker issue at '${filePath}' has invalid markdown projection data: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function splitFrontmatter(content: string): {
	frontmatter: string;
	bodyAndLogs: string;
} {
	const lines = content.split("\n");
	if (lines[0] !== FRONTMATTER_DELIMITER) {
		throw new Error("missing frontmatter");
	}
	const end = lines.indexOf(FRONTMATTER_DELIMITER, 1);
	if (end === -1) {
		throw new Error("unterminated frontmatter");
	}
	return {
		frontmatter: lines.slice(1, end).join("\n"),
		bodyAndLogs: lines
			.slice(end + 1)
			.join("\n")
			.replace(/^\n/u, ""),
	};
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const line of frontmatter.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		const separator = line.indexOf(":");
		if (separator <= 0) {
			throw new Error(`malformed frontmatter line '${line}'`);
		}
		const key = line.slice(0, separator).trim();
		const raw = line.slice(separator + 1).trim();
		result[key] = JSON.parse(raw);
	}
	return result;
}

function parseLogs(logsSection: string): Array<unknown> {
	const match = /```json\n([\s\S]*?)\n```/u.exec(logsSection);
	if (match === null) {
		throw new Error("missing logs JSON block");
	}
	const logs = JSON.parse(match[1]);
	if (!Array.isArray(logs)) {
		throw new Error("logs section is not an array");
	}
	return logs;
}

function requireStringMetadata(
	metadata: Record<string, unknown>,
	key: string,
): string {
	const value = metadata[key];
	if (typeof value !== "string") {
		throw new Error(`frontmatter '${key}' must be a string`);
	}
	return value;
}

function requireObjectMetadata(
	metadata: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const value = metadata[key];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`frontmatter '${key}' must be an object`);
	}
	return value as Record<string, unknown>;
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
