import { createHash } from "node:crypto";
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
const LOGS_SECTION = `## Logs\n\n${LOGS_SECTION_MARKER}`;
const FRONTMATTER_KEYS = ["id", "title", "workflow", "relationships"];
const LOG_MESSAGE_BLOCK_INDENT = "     ";

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
	validateRelationshipGraph(directoryPath, issues);
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
	validateLoadedIssue(filePath, fileName, parsed);
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
			`Filesystem tracker issue file '${filePath}' could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
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
		.sort(
			(left, right) =>
				(numericIssueId(left) ?? 0) - (numericIssueId(right) ?? 0),
		);
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
	const logs = formatLogs(issue.logs);
	return `${frontmatter}\n\n${body}\n\n${LOGS_SECTION}\n\n${logs}`;
}

function parseIssueMarkdown(
	filePath: string,
	content: string,
): WorkflowTrackerStateSnapshot["issues"][number] {
	try {
		const { frontmatter, bodyAndLogs } = splitFrontmatter(content);
		const section = findLogsSection(bodyAndLogs);
		if (section === undefined) {
			throw new Error("missing reserved logs section");
		}
		const body = bodyAndLogs.slice(0, section.index).replace(/\n{0,2}$/u, "");
		const logsSection = bodyAndLogs.slice(section.index + section.length);
		const metadata = parseFrontmatter(frontmatter);
		const id = requireStringMetadata(metadata, "id");
		const logs = parseLogs(logsSection, id);
		return {
			id,
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
			`Filesystem tracker issue file '${filePath}' has invalid markdown projection data: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function findLogsSection(
	bodyAndLogs: string,
): { index: number; length: number } | undefined {
	const currentIndex = bodyAndLogs.indexOf(LOGS_SECTION);
	if (currentIndex !== -1) {
		return { index: currentIndex, length: LOGS_SECTION.length };
	}
	const legacyIndex = bodyAndLogs.indexOf(LOGS_SECTION_MARKER);
	if (legacyIndex !== -1) {
		return { index: legacyIndex, length: LOGS_SECTION_MARKER.length };
	}
	return undefined;
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
		if (!FRONTMATTER_KEYS.includes(key)) {
			throw new Error(`unknown frontmatter field '${key}'`);
		}
		if (Object.hasOwn(result, key)) {
			throw new Error(`duplicate frontmatter field '${key}'`);
		}
		const raw = line.slice(separator + 1).trim();
		result[key] = JSON.parse(raw);
	}
	return result;
}

function formatLogs(logs: Array<unknown>): string {
	if (logs.length === 0) {
		return "";
	}
	return `${logs.map(formatLog).join("\n")}\n`;
}

function formatLog(log: unknown): string {
	if (!isRecord(log)) {
		throw new Error("workflow log is not an object");
	}
	const lines = [`${String(log.sequence)}. type: ${JSON.stringify(log.type)}`];
	if (log.message !== undefined) {
		const message = String(log.message);
		if (message.includes("\n")) {
			const endsWithNewline = message.endsWith("\n");
			lines.push(`   message: |${endsWithNewline ? "" : "-"}`);
			for (const line of (endsWithNewline
				? message.slice(0, -1)
				: message
			).split("\n")) {
				lines.push(`${LOG_MESSAGE_BLOCK_INDENT}${line}`);
			}
		} else {
			lines.push(`   message: ${JSON.stringify(message)}`);
		}
	}
	return lines.join("\n");
}

function parseLogs(logsSection: string, issueId: string): Array<unknown> {
	const lines = logsSection.replace(/^\n/u, "").split("\n");
	const logs: Array<unknown> = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined || line.trim() === "") {
			index += 1;
			continue;
		}
		const match = /^(\d+)\. type: (.+)$/u.exec(line);
		if (match === null) {
			throw new Error(`malformed workflow log entry '${line}'`);
		}
		const sequence = Number(match[1]);
		if (!Number.isSafeInteger(sequence) || sequence !== logs.length + 1) {
			throw new Error(`invalid workflow log sequence '${match[1]}'`);
		}
		const parsedType = JSON.parse(match[2]);
		if (typeof parsedType !== "string" || parsedType === "") {
			throw new Error(`workflow log ${sequence} has invalid type`);
		}
		const log: Record<string, unknown> = {
			issueId,
			sequence,
			type: parsedType,
		};
		index += 1;
		if (lines[index]?.startsWith("   message:") === true) {
			const messageLine = lines[index];
			const inline = /^ {3}message: (.*)$/u.exec(messageLine);
			if (inline === null) {
				throw new Error(`malformed workflow log ${sequence} message`);
			}
			if (inline[1] === "|-" || inline[1] === "|") {
				const messageLines: Array<string> = [];
				index += 1;
				while (lines[index]?.startsWith(LOG_MESSAGE_BLOCK_INDENT) === true) {
					messageLines.push(
						lines[index].slice(LOG_MESSAGE_BLOCK_INDENT.length),
					);
					index += 1;
				}
				log.message = `${messageLines.join("\n")}${inline[1] === "|" ? "\n" : ""}`;
			} else {
				const parsedMessage = JSON.parse(inline[1]);
				if (typeof parsedMessage !== "string") {
					throw new Error(`workflow log ${sequence} has invalid message`);
				}
				log.message = parsedMessage;
				index += 1;
			}
		}
		logs.push(log);
	}
	return logs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

function validateLoadedIssue(
	filePath: string,
	fileName: string,
	issue: WorkflowTrackerStateSnapshot["issues"][number],
): void {
	const fileId = fileName.slice(0, -".md".length);
	if (issue.id !== fileId) {
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker issue file '${filePath}' filename id '${fileId}' does not match frontmatter id '${issue.id}'.`,
		);
	}
	if (!isWorkflowLike(issue.workflow)) {
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker issue file '${filePath}' has malformed workflow metadata.`,
		);
	}
	if (!isRelationshipsLike(issue.relationships)) {
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker issue file '${filePath}' has malformed relationships.`,
		);
	}
	if (!isStoredIssueLike(issue)) {
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker issue file '${filePath}' has an unsupported or malformed schema.`,
		);
	}
	validateWorkflowHash(filePath, issue.id, issue.workflow);
}

function validateWorkflowHash(
	filePath: string,
	id: string,
	workflow: WorkflowTrackerStateSnapshot["issues"][number]["workflow"],
): void {
	const { hash, ...withoutHash } = workflow;
	const expected = hashProjection(withoutHash);
	if (hash !== expected) {
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker issue file '${filePath}' has stale workflow hash for issue '${id}'.`,
		);
	}
}

function validateRelationshipGraph(
	directoryPath: string,
	issues: Array<WorkflowTrackerStateSnapshot["issues"][number]>,
): void {
	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	for (const issue of issues) {
		const filePath = join(directoryPath, issueFileName(issue.id));
		const parentId = issue.relationships.parent;
		if (parentId !== undefined) {
			const parent = byId.get(parentId);
			if (
				parent === undefined ||
				!parent.relationships.children.includes(issue.id)
			) {
				throw new CorruptWorkflowProjectionError(
					`Filesystem tracker issue file '${filePath}' has malformed relationships.`,
				);
			}
		}
		for (const childId of issue.relationships.children) {
			const child = byId.get(childId);
			if (child === undefined || child.relationships.parent !== issue.id) {
				throw new CorruptWorkflowProjectionError(
					`Filesystem tracker issue file '${filePath}' has malformed relationships.`,
				);
			}
		}
		for (const dependencyId of issue.relationships.dependencies) {
			const dependency = byId.get(dependencyId);
			if (
				dependency === undefined ||
				!dependency.relationships.dependents.includes(issue.id)
			) {
				throw new CorruptWorkflowProjectionError(
					`Filesystem tracker issue file '${filePath}' has malformed relationships.`,
				);
			}
		}
		for (const dependentId of issue.relationships.dependents) {
			const dependent = byId.get(dependentId);
			if (
				dependent === undefined ||
				!dependent.relationships.dependencies.includes(issue.id)
			) {
				throw new CorruptWorkflowProjectionError(
					`Filesystem tracker issue file '${filePath}' has malformed relationships.`,
				);
			}
		}
		if (
			issue.relationships.generatedBy !== undefined &&
			!byId.has(issue.relationships.generatedBy)
		) {
			throw new CorruptWorkflowProjectionError(
				`Filesystem tracker issue file '${filePath}' has malformed relationships.`,
			);
		}
	}
}

function isStoredIssueLike(
	value: unknown,
): value is WorkflowTrackerStateSnapshot["issues"][number] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const issue = value as Record<string, unknown>;
	if (typeof issue.id !== "string") {
		return false;
	}
	const issueId = issue.id;
	return (
		Object.keys(issue).every((key) =>
			["id", "title", "body", "workflow", "relationships", "logs"].includes(
				key,
			),
		) &&
		typeof issue.title === "string" &&
		(issue.body === undefined || typeof issue.body === "string") &&
		isWorkflowLike(issue.workflow) &&
		isRelationshipsLike(issue.relationships) &&
		Array.isArray(issue.logs) &&
		issue.logs.every((log) => isStoredLogLike(log, issueId))
	);
}

function isWorkflowLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const workflow = value as Record<string, unknown>;
	return (
		Object.keys(workflow).every((key) =>
			[
				"kind",
				"state",
				"action",
				"data",
				"semanticVersion",
				"version",
				"hash",
			].includes(key),
		) &&
		typeof workflow.kind === "string" &&
		workflow.kind !== "" &&
		typeof workflow.state === "string" &&
		workflow.state !== "" &&
		typeof workflow.action === "string" &&
		workflow.action !== "" &&
		(workflow.data === undefined || isJsonRecordLike(workflow.data)) &&
		(workflow.semanticVersion === undefined ||
			(typeof workflow.semanticVersion === "string" &&
				workflow.semanticVersion !== "")) &&
		typeof workflow.version === "number" &&
		Number.isSafeInteger(workflow.version) &&
		workflow.version >= 1 &&
		typeof workflow.hash === "string"
	);
}

function isRelationshipsLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const relationships = value as Record<string, unknown>;
	return (
		Object.keys(relationships).every((key) =>
			[
				"parent",
				"children",
				"dependencies",
				"dependents",
				"generatedBy",
			].includes(key),
		) &&
		(relationships.parent === undefined ||
			typeof relationships.parent === "string") &&
		Array.isArray(relationships.children) &&
		relationships.children.every((id) => typeof id === "string") &&
		Array.isArray(relationships.dependencies) &&
		relationships.dependencies.every((id) => typeof id === "string") &&
		Array.isArray(relationships.dependents) &&
		relationships.dependents.every((id) => typeof id === "string") &&
		(relationships.generatedBy === undefined ||
			typeof relationships.generatedBy === "string")
	);
}

function isStoredLogLike(value: unknown, issueId: string): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const log = value as Record<string, unknown>;
	return (
		Object.keys(log).every((key) =>
			["sequence", "issueId", "type", "message"].includes(key),
		) &&
		typeof log.sequence === "number" &&
		Number.isSafeInteger(log.sequence) &&
		log.sequence >= 1 &&
		log.issueId === issueId &&
		typeof log.type === "string" &&
		(log.message === undefined || typeof log.message === "string")
	);
}

function isJsonRecordLike(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	try {
		JSON.stringify(value);
		return true;
	} catch {
		return false;
	}
}

function hashProjection(
	projection: Omit<
		WorkflowTrackerStateSnapshot["issues"][number]["workflow"],
		"hash"
	>,
): string {
	return createHash("sha256").update(stableStringify(projection)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
