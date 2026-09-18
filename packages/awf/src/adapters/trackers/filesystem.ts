import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
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
const LOGS_DIRECTORY = "logs";
const LOGS_SECTION_MARKER = "<!-- awf:logs v1 -->";
const LOGS_SECTION = `## Logs\n\n${LOGS_SECTION_MARKER}`;
const FRONTMATTER_KEYS = ["id", "title", "workflow", "relationships"];

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
	const issue = {
		...parsed,
		logs: readExternalLogs(directoryPath, parsed.id),
	};
	validateLoadedIssue(filePath, fileName, issue);
	return issue;
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
		writeExternalLogs(directoryPath, issue);
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
	const frontmatter = formatConstrainedFrontmatter(
		{
			id: issue.id,
			title: issue.title,
			workflow: issue.workflow,
			relationships: issue.relationships,
		},
		FRONTMATTER_KEYS,
	);
	const body = issue.body ?? "";
	return `${frontmatter}\n\n${body}\n`;
}

function parseIssueMarkdown(
	filePath: string,
	content: string,
): WorkflowTrackerStateSnapshot["issues"][number] {
	try {
		const { frontmatter, bodyAndLogs } = splitFrontmatter(content);
		const section = findLogsSection(bodyAndLogs);
		const body = (
			section === undefined ? bodyAndLogs : bodyAndLogs.slice(0, section.index)
		).replace(/\n{0,2}$/u, "");
		const metadata = parseFrontmatter(frontmatter);
		const id = requireStringMetadata(metadata, "id");
		const logs: Array<unknown> = [];
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
	return parseConstrainedFrontmatter(frontmatter, FRONTMATTER_KEYS);
}

function formatConstrainedFrontmatter(
	metadata: Record<string, unknown>,
	orderedKeys: Array<string>,
): string {
	const lines = [FRONTMATTER_DELIMITER];
	for (const key of orderedKeys) {
		if (!Object.hasOwn(metadata, key)) {
			continue;
		}
		assertPlainJsonValue(metadata[key], `frontmatter '${key}'`);
		lines.push(...formatYamlField(key, metadata[key], 0));
	}
	for (const key of Object.keys(metadata)) {
		if (!orderedKeys.includes(key)) {
			throw new Error(`unknown frontmatter field '${key}'`);
		}
	}
	lines.push(FRONTMATTER_DELIMITER);
	return lines.join("\n");
}

function formatYamlField(
	key: string,
	value: unknown,
	indent: number,
): Array<string> {
	const prefix = " ".repeat(indent);
	const formattedKey = formatYamlKey(key);
	if (isBlockYamlValue(value)) {
		return [`${prefix}${formattedKey}:`, ...formatYamlValue(value, indent + 2)];
	}
	return [`${prefix}${formattedKey}: ${formatYamlScalar(value)}`];
}

function formatYamlValue(value: unknown, indent: number): Array<string> {
	const prefix = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return [`${prefix}[]`];
		}
		return value.flatMap((item) => {
			if (isBlockYamlValue(item)) {
				return [`${prefix}-`, ...formatYamlValue(item, indent + 2)];
			}
			return [`${prefix}- ${formatYamlScalar(item)}`];
		});
	}
	if (isPlainRecord(value)) {
		const entries = Object.entries(value).filter(
			([, child]) => child !== undefined,
		);
		if (entries.length === 0) {
			return [`${prefix}{}`];
		}
		return entries.flatMap(([childKey, child]) =>
			formatYamlField(childKey, child, indent),
		);
	}
	return [`${prefix}${formatYamlScalar(value)}`];
}

function isBlockYamlValue(value: unknown): boolean {
	return (
		(Array.isArray(value) && value.length > 0) ||
		(isPlainRecord(value) && Object.keys(value).length > 0)
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function formatYamlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

function formatYamlScalar(value: unknown): string {
	return JSON.stringify(value);
}

function parseConstrainedFrontmatter(
	frontmatter: string,
	allowedKeys: Array<string>,
): Record<string, unknown> {
	const document = parseDocument(frontmatter, {
		schema: "core",
		uniqueKeys: false,
	});
	if (document.errors.length > 0) {
		throw new Error(document.errors.map((error) => error.message).join("; "));
	}
	if (document.contents === null) {
		return {};
	}
	if (!isMap(document.contents)) {
		throw new Error("frontmatter must be a plain object");
	}
	const result: Record<string, unknown> = {};
	for (const item of document.contents.items) {
		if (!isScalar(item.key) || typeof item.key.value !== "string") {
			throw new Error("frontmatter keys must be strings");
		}
		const key = item.key.value;
		if (!allowedKeys.includes(key)) {
			throw new Error(`unknown frontmatter field '${key}'`);
		}
		if (Object.hasOwn(result, key)) {
			throw new Error(`duplicate frontmatter field '${key}'`);
		}
		assertPlainYamlNode(item.value, `frontmatter '${key}'`);
		result[key] = item.value?.toJSON() ?? null;
	}
	return result;
}

function assertPlainJsonValue(value: unknown, path: string): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			assertPlainJsonValue(item, path);
		}
		return;
	}
	if (
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		for (const [key, item] of Object.entries(value)) {
			if (key === "") {
				throw new Error(`${path} object keys must be non-empty strings`);
			}
			assertPlainJsonValue(item, path);
		}
		return;
	}
	throw new Error(`${path} must be a plain JSON value`);
}

function assertPlainYamlNode(node: unknown, path: string): void {
	if (node === null || isScalar(node)) {
		return;
	}
	if (isAlias(node)) {
		throw new Error(`${path} must not use aliases`);
	}
	if (isSeq(node)) {
		for (const item of node.items) {
			assertPlainYamlNode(item, path);
		}
		return;
	}
	if (isMap(node)) {
		for (const item of node.items) {
			if (!isScalar(item.key) || typeof item.key.value !== "string") {
				throw new Error(`${path} object keys must be strings`);
			}
			assertPlainYamlNode(item.value, path);
		}
		return;
	}
	throw new Error(`${path} must be a plain YAML value`);
}

function writeExternalLogs(
	directoryPath: string,
	issue: WorkflowTrackerStateSnapshot["issues"][number],
): void {
	for (const log of issue.logs) {
		if (!isStoredLogLike(log, issue.id)) {
			throw new Error("workflow log is not an object");
		}
		const storedLog = log as {
			issueId: string;
			sequence: number;
			type: string;
			message?: string;
		};
		writeExternalLogWithCollisionRetry(directoryPath, storedLog);
	}
}

function readExternalLogs(
	directoryPath: string,
	issueId: string,
): Array<unknown> {
	const issueLogDirectory = join(directoryPath, LOGS_DIRECTORY, issueId);
	if (!directoryExists(issueLogDirectory)) {
		return [];
	}
	const logs: Array<{
		issueId: string;
		sequence: number;
		type: string;
		message?: string;
	}> = [];
	for (const entry of readdirSync(issueLogDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !/^\d+-.+\.md$/u.test(entry.name)) {
			continue;
		}
		const filePath = join(issueLogDirectory, entry.name);
		try {
			logs.push(
				parseExternalLogFile(filePath, readFileSync(filePath, "utf8"), issueId),
			);
		} catch (error) {
			console.warn(error instanceof Error ? error.message : String(error));
		}
	}
	return logs.sort((left, right) => left.sequence - right.sequence);
}

function externalLogPath(
	directoryPath: string,
	log: { issueId: string; sequence: number; type: string },
): string {
	return join(
		directoryPath,
		LOGS_DIRECTORY,
		log.issueId,
		`${log.sequence}-${slugifyLogEvent(log.type)}.md`,
	);
}

function writeExternalLogWithCollisionRetry(
	directoryPath: string,
	log: { issueId: string; sequence: number; type: string; message?: string },
): void {
	let candidate = log;
	while (true) {
		const filePath = externalLogPath(directoryPath, candidate);
		if (existsSync(filePath)) {
			if (externalLogMatches(filePath, candidate)) {
				return;
			}
			candidate = {
				...log,
				sequence:
					maxExistingExternalLogSequence(directoryPath, log.issueId) + 1,
			};
			continue;
		}
		if (writeExternalLogAtomically(filePath, candidate)) {
			return;
		}
		candidate = {
			...log,
			sequence: maxExistingExternalLogSequence(directoryPath, log.issueId) + 1,
		};
	}
}

function writeExternalLogAtomically(
	filePath: string,
	log: { issueId: string; sequence: number; type: string; message?: string },
): boolean {
	mkdirSync(resolve(filePath, ".."), { recursive: true });
	const randomSuffix = Math.random()
		.toString(HEX_RADIX)
		.slice(RANDOM_SUFFIX_START);
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomSuffix}`;
	try {
		writeFileSync(tempPath, formatExternalLogMarkdown(log), {
			encoding: "utf8",
			flag: "wx",
		});
		linkSync(tempPath, filePath);
		unlinkSync(tempPath);
		return true;
	} catch (error) {
		rmSync(tempPath, { force: true });
		if (isFileAlreadyExistsError(error)) {
			return false;
		}
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker log file '${filePath}' could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function externalLogMatches(
	filePath: string,
	log: { issueId: string; sequence: number; type: string; message?: string },
): boolean {
	try {
		const stored = parseExternalLogFile(
			filePath,
			readFileSync(filePath, "utf8"),
			log.issueId,
		);
		return (
			stored.sequence === log.sequence &&
			stored.type === log.type &&
			stored.message === log.message
		);
	} catch {
		return false;
	}
}

function maxExistingExternalLogSequence(
	directoryPath: string,
	issueId: string,
): number {
	const issueLogDirectory = join(directoryPath, LOGS_DIRECTORY, issueId);
	if (!directoryExists(issueLogDirectory)) {
		return 0;
	}
	return Math.max(
		0,
		...readdirSync(issueLogDirectory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => /^(\d+)-.+\.md$/u.exec(entry.name)?.[1])
			.filter((sequence): sequence is string => sequence !== undefined)
			.map((sequence) => Number(sequence))
			.filter((sequence) => Number.isSafeInteger(sequence) && sequence >= 1),
	);
}

function isFileAlreadyExistsError(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

function formatExternalLogMarkdown(log: {
	issueId: string;
	sequence: number;
	type: string;
	message?: string;
}): string {
	const frontmatter = formatConstrainedFrontmatter(
		{
			sequence: log.sequence,
			issue: log.issueId,
			event: log.type,
			createdAt: new Date().toISOString(),
		},
		["sequence", "issue", "event", "createdAt"],
	);
	const body = log.message ?? "";
	return `${frontmatter}\n\n${body}${body === "" || body.endsWith("\n") ? "" : "\n"}`;
}

function parseExternalLogFile(
	filePath: string,
	content: string,
	issueId: string,
): { issueId: string; sequence: number; type: string; message?: string } {
	try {
		const { frontmatter, bodyAndLogs: body } = splitFrontmatter(content);
		const metadata = parseConstrainedFrontmatter(frontmatter, [
			"sequence",
			"issue",
			"event",
			"createdAt",
		]);
		const sequence = Number(metadata.sequence);
		const logIssueId = requireStringMetadata(metadata, "issue");
		const type = requireStringMetadata(metadata, "event");
		if (!Number.isSafeInteger(sequence) || sequence < 1) {
			throw new Error("frontmatter 'sequence' must be a positive integer");
		}
		if (logIssueId !== issueId) {
			throw new Error(
				`frontmatter issue '${logIssueId}' does not match '${issueId}'`,
			);
		}
		const message = parseExternalLogMessage(body);
		return {
			issueId,
			sequence,
			type,
			...(message === undefined ? {} : { message }),
		};
	} catch (error) {
		throw new CorruptWorkflowProjectionError(
			`Filesystem tracker log file '${filePath}' has invalid markdown projection data: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseExternalLogMessage(body: string): string | undefined {
	const message = body.trim();
	return message === "" ? undefined : message;
}

function slugifyLogEvent(event: string): string {
	const slug = event
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "");
	return slug === "" ? "event" : slug;
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
