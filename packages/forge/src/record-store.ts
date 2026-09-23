import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseDocument, stringify } from "yaml";

import type { AbsolutePath, IsoDateTime, ProjectId } from "./domain.ts";
import { parseAbsolutePath } from "./domain.ts";
import { ForgeError } from "./errors.ts";
import {
	allocateNextCommentId,
	allocateRecordId,
	buildCombinedRecordHistory,
	buildRecordDependencyView,
	buildRecordTree,
	completeRecordLifecycle,
	createRecordUpdate,
	diagnoseRecordReadiness,
	parseRecordComment,
	parseRecordFrontmatter,
	parseRecordUpdate,
	selectNextRecord,
	startRecordLifecycle,
	validateCommentEdit,
	validateDependencyEdge,
	validateInitiativeDeclaredProjectsEdit,
	type CommentId,
	type NextRecordOptions,
	type ReadinessDiagnosis,
	type RecordComment,
	type RecordDependencyView,
	type RecordFrontmatter,
	type RecordHistoryEntry,
	type RecordId,
	type RecordKind,
	type RecordTreeNode,
	type RecordUpdate,
	validateFrontmatterEdit,
	validateInitiativeMembership,
	validateRecordPlacement,
	type WorkflowRecord,
} from "./record-domain.ts";
import {
	readJson,
	readStoreManifest,
	writeJsonFile,
} from "./filesystem-store.ts";
import {
	commentFilePath,
	recordFilePath,
	recordRelativePath,
	storeRootPaths,
	updateFilePath,
} from "./store-paths.ts";

export type CreateWorkflowRecordInput = Omit<
	RecordFrontmatter,
	"id" | "state" | "resolution" | "createdAt" | "updatedAt"
> & {
	readonly body: string;
};

export type RecordLocator = {
	readonly kind: RecordKind;
	readonly path: string;
};

export type ByIdRecordIndex = Readonly<Record<string, RecordLocator>>;
export type ByProjectRecordIndex = Readonly<
	Record<string, ReadonlyArray<number>>
>;
export type RelationshipRecordIndexEntry = {
	readonly parent: number | null;
	readonly children: ReadonlyArray<number>;
	readonly initiative: number | null;
	readonly initiativeMembers: ReadonlyArray<number>;
	readonly dependsOn: ReadonlyArray<number>;
	readonly dependents: ReadonlyArray<number>;
	readonly generatedBy: number | null;
	readonly generated: ReadonlyArray<number>;
};

export type RelationshipRecordIndex = Readonly<
	Record<string, RelationshipRecordIndexEntry>
>;

export type ByInitiativeRecordIndexEntry = {
	readonly declaredProjects: ReadonlyArray<string>;
	readonly projects: ReadonlyArray<string>;
	readonly members: ReadonlyArray<number>;
};

export type ByInitiativeRecordIndex = Readonly<
	Record<string, ByInitiativeRecordIndexEntry>
>;

export type WorkflowRecordReadinessQueryOptions = NextRecordOptions & {
	readonly blocked?: boolean;
};

type MutableRelationshipRecordIndexEntry = {
	parent: number | null;
	children: Array<number>;
	initiative: number | null;
	initiativeMembers: Array<number>;
	dependsOn: Array<number>;
	dependents: Array<number>;
	generatedBy: number | null;
	generated: Array<number>;
};

type ByInitiativeRecordIndexEntryMutable = {
	declaredProjects: Array<string>;
	projects: Array<string>;
	members: Array<number>;
};

const recordFrontmatterKeys = [
	"id",
	"title",
	"kind",
	"subkind",
	"state",
	"resolution",
	"scope",
	"parent",
	"initiative",
	"dependsOn",
	"generatedBy",
	"tags",
	"profile",
	"createdAt",
	"updatedAt",
] as const;

const recordKindsForStorage = [
	"initiative",
	"wayfinder",
	"spec",
	"task",
	"grilling",
] as const;

export async function createWorkflowRecord(options: {
	readonly storePath: AbsolutePath;
	readonly input: CreateWorkflowRecordInput;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const now = iso(options.now ?? new Date());
	const manifest = await readStoreManifest(options.storePath);
	const allocation = allocateRecordId({ manifest, now: options.now });
	const { body, ...frontmatterInput } = options.input;
	const record = parseRecordFrontmatter({
		...frontmatterInput,
		id: allocation.recordId,
		state: "ready",
		resolution: null,
		createdAt: now,
		updatedAt: now,
	});
	const withBody = { ...record, body } satisfies WorkflowRecord;

	await assertRecordPathIsFree(options.storePath, withBody.id);
	await validateRecordReferences(options.storePath, withBody);

	await writeJsonFile(
		storeRootPaths(options.storePath).manifest,
		allocation.manifest,
	);
	await writeRecordFile(options.storePath, withBody);
	await rebuildRecordIndexes(options.storePath);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: withBody.id,
		type: "create",
		summary: "Created record.",
		data: { kind: withBody.kind },
		now: options.now,
	});
	return withBody;
}

export async function readWorkflowRecord(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<WorkflowRecord> {
	const locator = await locateWorkflowRecord(storePath, recordId);
	return readWorkflowRecordAtPath(storePath, locator.path, {
		expectedId: recordId,
		expectedKind: locator.kind,
	});
}

export async function locateWorkflowRecord(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<RecordLocator> {
	const index = await readByIdIndex(storePath);
	const locator = index[String(recordId)];
	if (locator === undefined) {
		throw new ForgeError({
			kind: "record-not-found",
			message: `Record '${recordId}' was not found.`,
			details: { recordId },
		});
	}
	return locator;
}

export async function listWorkflowRecords(
	storePath: AbsolutePath,
): Promise<Array<WorkflowRecord>> {
	return readAllWorkflowRecords(storePath);
}

export async function readRecordRelationships(
	storePath: AbsolutePath,
): Promise<RelationshipRecordIndex> {
	return (await readJson(
		storeRootPaths(storePath).relationshipsIndex,
	)) as RelationshipRecordIndex;
}

export async function addWorkflowRecordDependency(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly dependsOn: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const records = await readAllWorkflowRecords(options.storePath);
	const record = requireRecordFromList(records, options.recordId);
	const dependsOn = requireRecordFromList(records, options.dependsOn);
	if (record.dependsOn.includes(options.dependsOn)) {
		return record;
	}
	const updated: WorkflowRecord = {
		...record,
		dependsOn: sortedUnique([...record.dependsOn, options.dependsOn]),
		updatedAt: iso(options.now ?? new Date()),
	};
	validateDependencyEdge({
		record: updated,
		dependsOn,
		records: records.map((candidate) =>
			candidate.id === updated.id ? updated : candidate,
		),
	});
	await writeRecordFile(options.storePath, updated);
	await rebuildRecordIndexes(options.storePath);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: updated.id,
		type: "dependency-add",
		summary: `Added dependency ${options.dependsOn}.`,
		data: { dependsOn: options.dependsOn },
		now: options.now,
	});
	return updated;
}

export async function removeWorkflowRecordDependency(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly dependsOn: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const record = await readWorkflowRecord(options.storePath, options.recordId);
	if (!record.dependsOn.includes(options.dependsOn)) {
		return record;
	}
	const updated: WorkflowRecord = {
		...record,
		dependsOn: record.dependsOn.filter((id) => id !== options.dependsOn),
		updatedAt: iso(options.now ?? new Date()),
	};
	await writeRecordFile(options.storePath, updated);
	await rebuildRecordIndexes(options.storePath);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: updated.id,
		type: "dependency-remove",
		summary: `Removed dependency ${options.dependsOn}.`,
		data: { dependsOn: options.dependsOn },
		now: options.now,
	});
	return updated;
}

export async function attachWorkflowRecordToInitiative(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly initiativeId: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const records = await readAllWorkflowRecords(options.storePath);
	const record = requireRecordFromList(records, options.recordId);
	const initiative = requireRecordFromList(records, options.initiativeId);
	if (record.initiative === options.initiativeId) {
		return record;
	}
	const updated: WorkflowRecord = {
		...record,
		initiative: options.initiativeId,
		updatedAt: iso(options.now ?? new Date()),
	};
	validateInitiativeMembership(updated, initiative);
	await writeRecordFile(options.storePath, updated);
	await rebuildRecordIndexes(options.storePath);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: updated.id,
		type: "initiative-attach",
		summary: `Attached to initiative ${options.initiativeId}.`,
		data: { initiative: options.initiativeId },
		now: options.now,
	});
	return updated;
}

export async function detachWorkflowRecordFromInitiative(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly initiativeId: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const record = await readWorkflowRecord(options.storePath, options.recordId);
	if (record.initiative !== options.initiativeId) {
		return record;
	}
	const updated: WorkflowRecord = {
		...record,
		initiative: null,
		updatedAt: iso(options.now ?? new Date()),
	};
	await writeRecordFile(options.storePath, updated);
	await rebuildRecordIndexes(options.storePath);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: updated.id,
		type: "initiative-detach",
		summary: `Detached from initiative ${options.initiativeId}.`,
		data: { initiative: options.initiativeId },
		now: options.now,
	});
	return updated;
}

export async function addInitiativeDeclaredProject(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return mutateInitiativeDeclaredProjects({
		...options,
		operation: "add",
	});
}

export async function removeInitiativeDeclaredProject(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return mutateInitiativeDeclaredProjects({
		...options,
		operation: "remove",
	});
}

export async function readRecordTree(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<RecordTreeNode> {
	const records = await readAllWorkflowRecords(storePath);
	return buildRecordTree(requireRecordFromList(records, recordId), records);
}

export async function readRecordDependencyView(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<RecordDependencyView> {
	const records = await readAllWorkflowRecords(storePath);
	return buildRecordDependencyView(
		requireRecordFromList(records, recordId),
		records,
	);
}

export async function startWorkflowRecord(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const records = await readAllWorkflowRecords(options.storePath);
	const record = requireRecordFromList(records, options.recordId);
	const result = startRecordLifecycle(record, records, options.now);
	if (!result.changed) {
		return record;
	}
	const updated = { ...record, ...result.record };
	await writeRecordFile(options.storePath, updated);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: record.id,
		type: "start",
		summary: "Started record.",
		data: { state: "in-progress" },
		now: options.now,
	});
	await rebuildRecordIndexes(options.storePath);
	return updated;
}

export async function completeWorkflowRecord(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly resolution: string;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const records = await readAllWorkflowRecords(options.storePath);
	const record = requireRecordFromList(records, options.recordId);
	const result = completeRecordLifecycle(
		record,
		records,
		options.resolution,
		options.now,
	);
	if (!result.changed) {
		return record;
	}
	const updated = { ...record, ...result.record };
	await writeRecordFile(options.storePath, updated);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: record.id,
		type: "done",
		summary: `Completed record with resolution ${options.resolution}.`,
		data: { resolution: result.record.resolution },
		now: options.now,
	});
	await rebuildRecordIndexes(options.storePath);
	return updated;
}

export async function addRecordComment(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly body: string;
	readonly now?: Date;
}): Promise<RecordComment> {
	await readWorkflowRecord(options.storePath, options.recordId);
	const comments = await listRecordComments(
		options.storePath,
		options.recordId,
	);
	const now = iso(options.now ?? new Date());
	const comment = parseRecordComment({
		id: allocateNextCommentId(options.recordId, comments),
		recordId: options.recordId,
		createdAt: now,
		updatedAt: now,
		body: options.body,
	});
	await writeCommentFile(options.storePath, comment);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: options.recordId,
		type: "comment",
		summary: `Added comment ${comment.id}.`,
		data: { commentId: comment.id },
		now: options.now,
	});
	return comment;
}

export async function listRecordComments(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<Array<RecordComment>> {
	await readWorkflowRecord(storePath, recordId);
	return readRecordCommentsFromDisk(storePath, recordId);
}

export async function replaceRecordCommentFromEditedMarkdown(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly commentId: CommentId;
	readonly markdown: string;
	readonly now?: Date;
}): Promise<RecordComment> {
	const before = await readRecordComment(
		options.storePath,
		options.recordId,
		options.commentId,
	);
	const parsed = parseRecordCommentMarkdown(options.markdown, {
		expectedRecordId: options.recordId,
		expectedCommentId: options.commentId,
	});
	validateCommentEdit(before, parsed);
	const edited = { ...parsed, updatedAt: iso(options.now ?? new Date()) };
	await writeCommentFile(options.storePath, edited);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: options.recordId,
		type: "comment-edit",
		summary: `Edited comment ${options.commentId}.`,
		data: { commentId: options.commentId },
		now: options.now,
	});
	return edited;
}

export async function listRecordUpdates(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<Array<RecordUpdate>> {
	await readWorkflowRecord(storePath, recordId);
	return readRecordUpdatesFromDisk(storePath, recordId);
}

export async function listRecordHistory(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<ReadonlyArray<RecordHistoryEntry>> {
	return buildCombinedRecordHistory({
		comments: await listRecordComments(storePath, recordId),
		updates: await listRecordUpdates(storePath, recordId),
	});
}

export async function listWorkflowRecordReadiness(
	storePath: AbsolutePath,
	options: WorkflowRecordReadinessQueryOptions = {},
): Promise<Array<ReadinessDiagnosis>> {
	const records = await readAllWorkflowRecords(storePath);
	return records
		.filter((record) => recordIsReadinessCandidate(record, records, options))
		.map((record) => diagnoseRecordReadiness(record, records))
		.filter((diagnosis) => diagnosis.ready !== (options.blocked === true));
}

export async function selectNextWorkflowRecord(
	storePath: AbsolutePath,
	options: NextRecordOptions = {},
): Promise<RecordFrontmatter | undefined> {
	return selectNextRecord(await readAllWorkflowRecords(storePath), options);
}

export async function replaceWorkflowRecordFromEditedMarkdown(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly markdown: string;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const before = await readWorkflowRecord(options.storePath, options.recordId);
	const parsed = parseWorkflowRecordMarkdown(options.markdown, {
		expectedId: before.id,
		expectedKind: before.kind,
	});
	const validation = validateFrontmatterEdit(before, parsed);
	const edited: WorkflowRecord = {
		...parsed,
		updatedAt: iso(options.now ?? new Date()),
	};
	await writeRecordFile(options.storePath, edited);
	await rebuildRecordIndexes(options.storePath);
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: edited.id,
		type: "edit",
		summary: "Edited record Markdown.",
		data: { changedFrontmatter: validation.changed },
		now: options.now,
	});
	return edited;
}

export function formatWorkflowRecordMarkdown(record: WorkflowRecord): string {
	const frontmatter: Record<string, unknown> = {};
	for (const key of recordFrontmatterKeys) {
		frontmatter[key] = record[key];
	}
	const yaml = stringify(frontmatter, {
		lineWidth: 0,
		sortMapEntries: false,
	})
		.trimEnd()
		.replace(
			/^(createdAt|updatedAt): (.+)$/gm,
			(_match, key: string, value: string) => `${key}: "${value}"`,
		);
	return `---\n${yaml}\n---\n\n${record.body}${record.body.endsWith("\n") ? "" : "\n"}`;
}

export function parseWorkflowRecordMarkdown(
	markdown: string,
	expectations: {
		readonly expectedId?: RecordId;
		readonly expectedKind?: RecordKind;
	} = {},
): WorkflowRecord {
	const { frontmatter, body } = splitFrontmatter(markdown);
	const document = parseDocument(frontmatter, {
		keepSourceTokens: true,
		uniqueKeys: false,
	});
	if (document.errors.length > 0) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Record frontmatter YAML is invalid: ${document.errors[0]?.message ?? "unknown parse error"}.`,
		});
	}
	const frontmatterValue = document.toJSON();
	const parsed = parseRecordFrontmatter(frontmatterValue);
	if (
		expectations.expectedId !== undefined &&
		parsed.id !== expectations.expectedId
	) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `record file id '${parsed.id}' does not match expected id '${expectations.expectedId}'`,
			details: { expectedId: expectations.expectedId, actualId: parsed.id },
		});
	}
	if (
		expectations.expectedKind !== undefined &&
		parsed.kind !== expectations.expectedKind
	) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `record file kind '${parsed.kind}' does not match expected kind '${expectations.expectedKind}'`,
			details: {
				expectedKind: expectations.expectedKind,
				actualKind: parsed.kind,
			},
		});
	}
	return { ...parsed, body };
}

export async function rebuildRecordIndexes(
	storePath: AbsolutePath,
): Promise<void> {
	const records = await readAllWorkflowRecords(storePath);
	const byId: Record<string, RecordLocator> = {};
	const byProject: Record<string, Array<number>> = {};
	const byInitiative: Record<string, ByInitiativeRecordIndexEntryMutable> = {};
	const relationships: Record<string, MutableRelationshipRecordIndexEntry> = {};

	for (const record of records) {
		byId[String(record.id)] = {
			kind: record.kind,
			path: recordRelativePath(record.kind, record.id),
		};
		for (const project of projectsForRecord(record)) {
			byProject[project] = byProject[project] ?? [];
			byProject[project].push(record.id);
		}
		if (record.kind === "initiative") {
			byInitiative[String(record.id)] = byInitiativeEntryFor(record);
		}
		if (record.initiative !== null) {
			const key = String(record.initiative);
			byInitiative[key] = byInitiative[key] ?? emptyInitiativeEntry();
			byInitiative[key].members.push(record.id);
			for (const project of projectsForRecord(record)) {
				byInitiative[key].projects.push(project);
			}
		}
		relationships[String(record.id)] = {
			parent: record.parent,
			children: [],
			initiative: record.initiative,
			initiativeMembers: [],
			dependsOn: [...record.dependsOn],
			dependents: [],
			generatedBy: record.generatedBy,
			generated: [],
		};
	}

	for (const record of records) {
		if (record.parent !== null) {
			relationships[String(record.parent)]?.children.push(record.id);
		}
		if (record.initiative !== null) {
			relationships[String(record.initiative)]?.initiativeMembers.push(
				record.id,
			);
		}
		for (const dependency of record.dependsOn) {
			relationships[String(dependency)]?.dependents.push(record.id);
		}
		if (record.generatedBy !== null) {
			relationships[String(record.generatedBy)]?.generated.push(record.id);
		}
	}

	for (const ids of Object.values(byProject)) {
		ids.sort((left, right) => left - right);
	}
	for (const initiative of Object.values(byInitiative)) {
		initiative.declaredProjects = sortedUnique(initiative.declaredProjects);
		initiative.members = sortedUnique(initiative.members);
		initiative.projects = sortedUnique(initiative.projects);
	}
	for (const relationship of Object.values(relationships)) {
		relationship.children = sortedUnique(relationship.children);
		relationship.initiativeMembers = sortedUnique(
			relationship.initiativeMembers,
		);
		relationship.dependents = sortedUnique(relationship.dependents);
		relationship.generated = sortedUnique(relationship.generated);
	}

	const paths = storeRootPaths(storePath);
	await writeJsonFile(paths.byIdIndex, sortRecordObject(byId));
	await writeJsonFile(paths.byProjectIndex, sortRecordObject(byProject));
	await writeJsonFile(paths.byInitiativeIndex, sortRecordObject(byInitiative));
	await writeJsonFile(
		paths.relationshipsIndex,
		sortRecordObject(relationships),
	);
}

async function mutateInitiativeDeclaredProjects(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly operation: "add" | "remove";
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	const records = await readAllWorkflowRecords(options.storePath);
	const before = requireRecordFromList(records, options.initiativeId);
	if (before.kind !== "initiative" || before.scope.type !== "project-set") {
		validateInitiativeDeclaredProjectsEdit(before, before, records);
	}
	const beforeProjects =
		before.scope.type === "project-set" ? before.scope.projects : [];
	const afterProjects =
		options.operation === "add"
			? sortedUnique([...beforeProjects, options.project])
			: beforeProjects.filter((project) => project !== options.project);
	if (sameProjectIds(beforeProjects, afterProjects)) {
		return before;
	}
	const validationAfter: WorkflowRecord = {
		...before,
		scope: { type: "project-set", projects: afterProjects },
	};
	const validation = validateInitiativeDeclaredProjectsEdit(
		before,
		validationAfter,
		records,
	);
	const updated: WorkflowRecord = {
		...validationAfter,
		updatedAt: iso(options.now ?? new Date()),
	};
	await writeRecordFile(options.storePath, updated);
	await rebuildRecordIndexes(options.storePath);
	const changedProjects =
		options.operation === "add" ? validation.added : validation.removed;
	await appendRecordUpdate({
		storePath: options.storePath,
		recordId: updated.id,
		type: `initiative-project-${options.operation}`,
		summary: `${options.operation === "add" ? "Added" : "Removed"} initiative project ${options.project}.`,
		data: { projects: changedProjects },
		now: options.now,
	});
	return updated;
}

async function validateRecordReferences(
	storePath: AbsolutePath,
	record: WorkflowRecord,
): Promise<void> {
	const records = await readAllWorkflowRecords(storePath);
	if (record.parent !== null) {
		validateRecordPlacement(record, {
			parent: requireRecordFromList(records, record.parent),
		});
	}
	for (const dependencyId of record.dependsOn) {
		validateDependencyEdge({
			record,
			dependsOn: requireRecordFromList(records, dependencyId),
			records: [...records, record],
		});
	}
	if (record.generatedBy !== null) {
		requireRecordFromList(records, record.generatedBy);
	}
	if (record.initiative !== null) {
		validateInitiativeMembership(
			record,
			requireRecordFromList(records, record.initiative),
		);
	}
}

async function assertRecordPathIsFree(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<void> {
	for (const candidateKind of recordKindsForStorage) {
		const targetPath = recordFilePath(storePath, candidateKind, recordId);
		try {
			await stat(targetPath);
		} catch (error) {
			if (isMissingFile(error)) {
				continue;
			}
			throw error;
		}
		throw new ForgeError({
			kind: "store-invalid",
			message: `Store manifest nextRecordId conflicts with existing record file '${targetPath}'. Run forge store doctor.`,
			details: { recordId, path: targetPath },
		});
	}
}

async function writeRecordFile(
	storePath: AbsolutePath,
	record: WorkflowRecord,
): Promise<void> {
	const filePath = recordFilePath(storePath, record.kind, record.id);
	await writeAtomicTextFile(filePath, formatWorkflowRecordMarkdown(record));
}

async function appendRecordUpdate(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly type: string;
	readonly summary: string;
	readonly data?: Readonly<Record<string, unknown>> | null;
	readonly now?: Date;
}): Promise<RecordUpdate> {
	await readWorkflowRecord(options.storePath, options.recordId);
	const update = createRecordUpdate({
		recordId: options.recordId,
		updates: await readRecordUpdatesFromDisk(
			options.storePath,
			options.recordId,
		),
		type: options.type,
		summary: options.summary,
		data: options.data,
		now: options.now,
	});
	await writeJsonFile(
		updateFilePath(
			options.storePath,
			options.recordId,
			update.sequence,
			update.type,
		),
		formatRecordUpdateJson(update),
	);
	return update;
}

async function readRecordComment(
	storePath: AbsolutePath,
	recordId: RecordId,
	commentId: CommentId,
): Promise<RecordComment> {
	return parseRecordCommentMarkdown(
		await readFile(commentFilePath(storePath, recordId, commentId), "utf8"),
		{ expectedRecordId: recordId, expectedCommentId: commentId },
	);
}

async function writeCommentFile(
	storePath: AbsolutePath,
	comment: RecordComment,
): Promise<void> {
	await writeAtomicTextFile(
		commentFilePath(storePath, comment.recordId, comment.id),
		formatRecordCommentMarkdown(comment),
	);
}

async function writeAtomicTextFile(
	filePath: AbsolutePath,
	content: string,
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = parseAbsolutePath(
		`${filePath}.tmp-${process.pid}-${Date.now()}`,
		"temporaryPath",
	);
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, filePath);
}

async function readByIdIndex(
	storePath: AbsolutePath,
): Promise<ByIdRecordIndex> {
	return (await readJson(
		storeRootPaths(storePath).byIdIndex,
	)) as ByIdRecordIndex;
}

async function readRecordCommentsFromDisk(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<Array<RecordComment>> {
	const commentsDirectory = path.dirname(
		commentFilePath(storePath, recordId, 1 as CommentId),
	);
	let files: Array<string>;
	try {
		files = await readdir(commentsDirectory);
	} catch (error) {
		if (isMissingFile(error)) {
			return [];
		}
		throw error;
	}
	const comments = await Promise.all(
		files
			.filter((file) => file.endsWith(".md"))
			.map(async (file) =>
				parseRecordCommentMarkdown(
					await readFile(path.join(commentsDirectory, file), "utf8"),
				),
			),
	);
	return comments.sort((left, right) => left.id - right.id);
}

async function readRecordUpdatesFromDisk(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<Array<RecordUpdate>> {
	const updatesDirectory = path.dirname(
		updateFilePath(storePath, recordId, 1, "x"),
	);
	let files: Array<string>;
	try {
		files = await readdir(updatesDirectory);
	} catch (error) {
		if (isMissingFile(error)) {
			return [];
		}
		throw error;
	}
	const updates = await Promise.all(
		files
			.filter((file) => file.endsWith(".json"))
			.map(async (file) =>
				parseRecordUpdateJson(
					await readJson(parseAbsolutePath(path.join(updatesDirectory, file))),
					recordId,
				),
			),
	);
	return updates.sort((left, right) => left.sequence - right.sequence);
}

async function readAllWorkflowRecords(
	storePath: AbsolutePath,
): Promise<Array<WorkflowRecord>> {
	const paths = storeRootPaths(storePath);
	const records: Array<WorkflowRecord> = [];
	for (const kind of recordKindsForStorage) {
		const kindDirectory = path.join(paths.records, kind);
		let shards: Array<string>;
		try {
			shards = await readdir(kindDirectory);
		} catch (error) {
			if (isMissingFile(error)) {
				continue;
			}
			throw error;
		}
		for (const shard of shards) {
			const shardDirectory = path.join(kindDirectory, shard);
			const files = await readdir(shardDirectory);
			for (const file of files.filter((candidate) =>
				candidate.endsWith(".md"),
			)) {
				const record = await readWorkflowRecordAtPath(
					storePath,
					path.relative(paths.root, path.join(shardDirectory, file)),
					{ expectedKind: kind },
				);
				records.push(record);
			}
		}
	}
	return records.sort((left, right) => left.id - right.id);
}

async function readWorkflowRecordAtPath(
	storePath: AbsolutePath,
	relativePath: string,
	expectations: {
		readonly expectedId?: RecordId;
		readonly expectedKind?: RecordKind;
	},
): Promise<WorkflowRecord> {
	const filePath = parseAbsolutePath(path.join(storePath, relativePath));
	return parseWorkflowRecordMarkdown(
		await readFile(filePath, "utf8"),
		expectations,
	);
}

export function formatRecordCommentMarkdown(comment: RecordComment): string {
	const yaml = stringify(
		{
			id: comment.id,
			record: comment.recordId,
			createdAt: comment.createdAt,
			updatedAt: comment.updatedAt,
		},
		{ lineWidth: 0, sortMapEntries: false },
	)
		.trimEnd()
		.replace(
			/^(createdAt|updatedAt): (.+)$/gm,
			(_match, key: string, value: string) => `${key}: "${value}"`,
		);
	return `---\n${yaml}\n---\n\n${comment.body}${comment.body.endsWith("\n") ? "" : "\n"}`;
}

export function parseRecordCommentMarkdown(
	markdown: string,
	expectations: {
		readonly expectedRecordId?: RecordId;
		readonly expectedCommentId?: CommentId;
	} = {},
): RecordComment {
	const { frontmatter, body } = splitFrontmatter(markdown);
	const document = parseDocument(frontmatter, {
		keepSourceTokens: true,
		uniqueKeys: false,
	});
	if (document.errors.length > 0) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Comment frontmatter YAML is invalid: ${document.errors[0]?.message ?? "unknown parse error"}.`,
		});
	}
	const value = document.toJSON() as { readonly record?: unknown };
	const parsed = parseRecordComment({
		...value,
		recordId: value.record,
		body,
	});
	if (
		expectations.expectedRecordId !== undefined &&
		parsed.recordId !== expectations.expectedRecordId
	) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `comment record '${parsed.recordId}' does not match expected record '${expectations.expectedRecordId}'`,
		});
	}
	if (
		expectations.expectedCommentId !== undefined &&
		parsed.id !== expectations.expectedCommentId
	) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `comment id '${parsed.id}' does not match expected id '${expectations.expectedCommentId}'`,
		});
	}
	return parsed;
}

function formatRecordUpdateJson(update: RecordUpdate): Record<string, unknown> {
	return {
		sequence: update.sequence,
		record: update.recordId,
		createdAt: update.createdAt,
		type: update.type,
		summary: update.summary,
		data: update.data,
	};
}

function parseRecordUpdateJson(
	value: unknown,
	recordId: RecordId,
): RecordUpdate {
	const raw = value as { readonly record?: unknown };
	const update = parseRecordUpdate({
		...raw,
		recordId: raw.record,
	});
	if (update.recordId !== recordId) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `update record '${update.recordId}' does not match expected record '${recordId}'`,
		});
	}
	return update;
}

function splitFrontmatter(markdown: string): {
	readonly frontmatter: string;
	readonly body: string;
} {
	const lines = markdown.split("\n");
	if (lines[0] !== "---") {
		throw new ForgeError({
			kind: "record-invalid",
			message: "Record Markdown is missing frontmatter.",
		});
	}
	const end = lines.indexOf("---", 1);
	if (end === -1) {
		throw new ForgeError({
			kind: "record-invalid",
			message: "Record Markdown has unterminated frontmatter.",
		});
	}
	return {
		frontmatter: lines.slice(1, end).join("\n"),
		body: lines
			.slice(end + 1)
			.join("\n")
			.replace(/^\n/, ""),
	};
}

function requireRecordFromList(
	records: ReadonlyArray<WorkflowRecord>,
	recordId: RecordId,
): WorkflowRecord {
	const record = records.find((candidate) => candidate.id === recordId);
	if (record === undefined) {
		throw new ForgeError({
			kind: "record-not-found",
			message: `Record '${recordId}' was not found.`,
			details: { recordId },
		});
	}
	return record;
}

function recordIsReadinessCandidate(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
	options: WorkflowRecordReadinessQueryOptions,
): boolean {
	if (record.kind === "grilling" && options.includeHitl !== true) {
		return false;
	}
	if (
		record.kind !== "task" &&
		record.kind !== "grilling" &&
		options.planning !== true
	) {
		return false;
	}
	if (
		options.initiative !== undefined &&
		!recordBelongsToInitiativeScope(record, options.initiative, records)
	) {
		return false;
	}
	if (options.project !== undefined) {
		return recordHasProjectContext(record, records, options.project);
	}
	return true;
}

function projectsForRecord(record: WorkflowRecord): Array<ProjectId> {
	if (record.scope.type === "project") {
		return [record.scope.project];
	}
	if (record.scope.type === "project-set") {
		return [...record.scope.projects];
	}
	return [];
}

function recordHasProjectContext(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
	project: ProjectId,
): boolean {
	if (projectsForRecord(record).includes(project)) {
		return true;
	}
	const initiativeId =
		record.scope.type === "initiative"
			? record.scope.initiative
			: record.initiative;
	if (initiativeId === null) {
		return false;
	}
	const initiative = records.find((candidate) => candidate.id === initiativeId);
	return initiative?.scope.type === "project-set"
		? initiative.scope.projects.includes(project)
		: false;
}

function recordBelongsToInitiativeScope(
	record: WorkflowRecord,
	initiativeId: RecordId,
	records: ReadonlyArray<WorkflowRecord>,
): boolean {
	return effectiveInitiativeId(record, records) === initiativeId;
}

function effectiveInitiativeId(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
): RecordId | null {
	if (record.kind === "initiative") {
		return record.id;
	}
	if (record.initiative !== null) {
		return record.initiative;
	}
	if (record.scope.type === "initiative") {
		return record.scope.initiative;
	}
	if (record.parent === null) {
		return null;
	}
	const parent = records.find((candidate) => candidate.id === record.parent);
	return parent === undefined ? null : effectiveInitiativeId(parent, records);
}

function byInitiativeEntryFor(
	record: WorkflowRecord,
): ByInitiativeRecordIndexEntryMutable {
	return {
		...emptyInitiativeEntry(),
		declaredProjects:
			record.scope.type === "project-set" ? [...record.scope.projects] : [],
	};
}

function emptyInitiativeEntry(): ByInitiativeRecordIndexEntryMutable {
	return { declaredProjects: [], projects: [], members: [] };
}

function sameProjectIds(
	left: ReadonlyArray<ProjectId>,
	right: ReadonlyArray<ProjectId>,
): boolean {
	return (
		left.length === right.length &&
		left.every((project) => right.includes(project))
	);
}

function iso(date: Date): IsoDateTime {
	return date.toISOString() as IsoDateTime;
}

function sortedUnique<T extends number | string>(
	values: ReadonlyArray<T>,
): Array<T> {
	return [...new Set(values)].sort(comparePrimitive);
}

function comparePrimitive<T extends number | string>(
	left: T,
	right: T,
): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function sortRecordObject<T>(object: Record<string, T>): Record<string, T> {
	return Object.fromEntries(
		Object.entries(object).sort(([left], [right]) =>
			Number(left) < Number(right) || left < right ? -1 : 1,
		),
	);
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: string }).code === "ENOENT"
	);
}
