import path from "node:path";

import { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";
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
	readJsonEffect,
	readStoreManifestEffect,
	writeJsonFileEffect,
} from "./filesystem-store.ts";
import { runForgePromise } from "./runtime.ts";
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

export function createWorkflowRecord(options: {
	readonly storePath: AbsolutePath;
	readonly input: CreateWorkflowRecordInput;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(createWorkflowRecordEffect(options));
}

export function createWorkflowRecordEffect(options: {
	readonly storePath: AbsolutePath;
	readonly input: CreateWorkflowRecordInput;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const now = iso(options.now ?? new Date());
		const manifest = yield* readStoreManifestEffect(options.storePath);
		const allocation = allocateRecordId({ manifest, now: options.now });
		const { body, ...frontmatterInput } = options.input;
		const record = yield* Effect.try({
			try: () =>
				parseRecordFrontmatter({
					...frontmatterInput,
					id: allocation.recordId,
					state: "ready",
					resolution: null,
					createdAt: now,
					updatedAt: now,
				}),
			catch: (error) => error,
		});
		const withBody = { ...record, body } satisfies WorkflowRecord;

		yield* assertRecordPathIsFreeEffect(options.storePath, withBody.id);
		yield* validateRecordReferencesEffect(options.storePath, withBody);

		yield* writeJsonFileEffect(
			storeRootPaths(options.storePath).manifest,
			allocation.manifest,
		);
		yield* writeRecordFileEffect(options.storePath, withBody);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: withBody.id,
			type: "create",
			summary: "Created record.",
			data: { kind: withBody.kind },
			now: options.now,
		});
		return withBody;
	});
}

export function readWorkflowRecord(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<WorkflowRecord> {
	return runForgePromise(readWorkflowRecordEffect(storePath, recordId));
}

export function readWorkflowRecordEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const locator = yield* locateWorkflowRecordEffect(storePath, recordId);
		return yield* readWorkflowRecordAtPathEffect(storePath, locator.path, {
			expectedId: recordId,
			expectedKind: locator.kind,
		});
	});
}

export function locateWorkflowRecord(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<RecordLocator> {
	return runForgePromise(locateWorkflowRecordEffect(storePath, recordId));
}

export function locateWorkflowRecordEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const index = yield* readByIdIndexEffect(storePath);
		const locator = index[String(recordId)];
		if (locator === undefined) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "record-not-found",
					message: `Record '${recordId}' was not found.`,
					details: { recordId },
				}),
			);
		}
		return locator;
	});
}

export function listWorkflowRecords(
	storePath: AbsolutePath,
): Promise<Array<WorkflowRecord>> {
	return readAllWorkflowRecords(storePath);
}

export function listWorkflowRecordsEffect(storePath: AbsolutePath) {
	return readAllWorkflowRecordsEffect(storePath);
}

export function readRecordRelationships(
	storePath: AbsolutePath,
): Promise<RelationshipRecordIndex> {
	return runForgePromise(readRecordRelationshipsEffect(storePath));
}

export function readRecordRelationshipsEffect(storePath: AbsolutePath) {
	return readJsonEffect(
		storeRootPaths(storePath).relationshipsIndex,
	) as Effect.Effect<RelationshipRecordIndex, unknown, FileSystem>;
}

export function addWorkflowRecordDependency(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly dependsOn: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(addWorkflowRecordDependencyEffect(options));
}

export function addWorkflowRecordDependencyEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly dependsOn: RecordId;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(options.storePath);
		const { record, updated } = yield* Effect.try({
			try: () => {
				const record = requireRecordFromList(records, options.recordId);
				const dependsOn = requireRecordFromList(records, options.dependsOn);
				if (record.dependsOn.includes(options.dependsOn)) {
					return { record, dependsOn, updated: record };
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
				return { record, dependsOn, updated };
			},
			catch: (error) => error,
		});
		if (updated === record) {
			return record;
		}
		yield* writeRecordFileEffect(options.storePath, updated);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: updated.id,
			type: "dependency-add",
			summary: `Added dependency ${options.dependsOn}.`,
			data: { dependsOn: options.dependsOn },
			now: options.now,
		});
		return updated;
	});
}

export function removeWorkflowRecordDependency(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly dependsOn: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(removeWorkflowRecordDependencyEffect(options));
}

export function removeWorkflowRecordDependencyEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly dependsOn: RecordId;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const record = yield* readWorkflowRecordEffect(
			options.storePath,
			options.recordId,
		);
		if (!record.dependsOn.includes(options.dependsOn)) {
			return record;
		}
		const updated: WorkflowRecord = {
			...record,
			dependsOn: record.dependsOn.filter((id) => id !== options.dependsOn),
			updatedAt: iso(options.now ?? new Date()),
		};
		yield* writeRecordFileEffect(options.storePath, updated);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: updated.id,
			type: "dependency-remove",
			summary: `Removed dependency ${options.dependsOn}.`,
			data: { dependsOn: options.dependsOn },
			now: options.now,
		});
		return updated;
	});
}

export function attachWorkflowRecordToInitiative(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly initiativeId: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(attachWorkflowRecordToInitiativeEffect(options));
}

export function attachWorkflowRecordToInitiativeEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly initiativeId: RecordId;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(options.storePath);
		const { record, updated } = yield* Effect.try({
			try: () => {
				const record = requireRecordFromList(records, options.recordId);
				const initiative = requireRecordFromList(records, options.initiativeId);
				if (record.initiative === options.initiativeId) {
					return { record, updated: record };
				}
				const updated: WorkflowRecord = {
					...record,
					initiative: options.initiativeId,
					updatedAt: iso(options.now ?? new Date()),
				};
				validateInitiativeMembership(updated, initiative);
				return { record, updated };
			},
			catch: (error) => error,
		});
		if (updated === record) {
			return record;
		}
		yield* writeRecordFileEffect(options.storePath, updated);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: updated.id,
			type: "initiative-attach",
			summary: `Attached to initiative ${options.initiativeId}.`,
			data: { initiative: options.initiativeId },
			now: options.now,
		});
		return updated;
	});
}

export function detachWorkflowRecordFromInitiative(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly initiativeId: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(detachWorkflowRecordFromInitiativeEffect(options));
}

export function detachWorkflowRecordFromInitiativeEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly initiativeId: RecordId;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const record = yield* readWorkflowRecordEffect(
			options.storePath,
			options.recordId,
		);
		if (record.initiative !== options.initiativeId) {
			return record;
		}
		const updated: WorkflowRecord = {
			...record,
			initiative: null,
			updatedAt: iso(options.now ?? new Date()),
		};
		yield* writeRecordFileEffect(options.storePath, updated);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: updated.id,
			type: "initiative-detach",
			summary: `Detached from initiative ${options.initiativeId}.`,
			data: { initiative: options.initiativeId },
			now: options.now,
		});
		return updated;
	});
}

export function addInitiativeDeclaredProject(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(addInitiativeDeclaredProjectEffect(options));
}

export function addInitiativeDeclaredProjectEffect(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly now?: Date;
}) {
	return mutateInitiativeDeclaredProjectsEffect({
		...options,
		operation: "add",
	});
}

export function removeInitiativeDeclaredProject(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(removeInitiativeDeclaredProjectEffect(options));
}

export function removeInitiativeDeclaredProjectEffect(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly now?: Date;
}) {
	return mutateInitiativeDeclaredProjectsEffect({
		...options,
		operation: "remove",
	});
}

export function readRecordTree(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<RecordTreeNode> {
	return runForgePromise(readRecordTreeEffect(storePath, recordId));
}

export function readRecordTreeEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(storePath);
		return yield* Effect.try({
			try: () =>
				buildRecordTree(requireRecordFromList(records, recordId), records),
			catch: (error) => error,
		});
	});
}

export function readRecordDependencyView(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<RecordDependencyView> {
	return runForgePromise(readRecordDependencyViewEffect(storePath, recordId));
}

export function readRecordDependencyViewEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(storePath);
		return yield* Effect.try({
			try: () =>
				buildRecordDependencyView(
					requireRecordFromList(records, recordId),
					records,
				),
			catch: (error) => error,
		});
	});
}

export function startWorkflowRecord(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(startWorkflowRecordEffect(options));
}

export function startWorkflowRecordEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(options.storePath);
		const { record, result } = yield* Effect.try({
			try: () => {
				const record = requireRecordFromList(records, options.recordId);
				return {
					record,
					result: startRecordLifecycle(record, records, options.now),
				};
			},
			catch: (error) => error,
		});
		if (!result.changed) {
			return record;
		}
		const updated = { ...record, ...result.record };
		yield* writeRecordFileEffect(options.storePath, updated);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: record.id,
			type: "start",
			summary: "Started record.",
			data: { state: "in-progress" },
			now: options.now,
		});
		yield* rebuildRecordIndexesEffect(options.storePath);
		return updated;
	});
}

export function completeWorkflowRecord(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly resolution: string;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(completeWorkflowRecordEffect(options));
}

export function completeWorkflowRecordEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly resolution: string;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(options.storePath);
		const { record, result } = yield* Effect.try({
			try: () => {
				const record = requireRecordFromList(records, options.recordId);
				return {
					record,
					result: completeRecordLifecycle(
						record,
						records,
						options.resolution,
						options.now,
					),
				};
			},
			catch: (error) => error,
		});
		if (!result.changed) {
			return record;
		}
		const updated = { ...record, ...result.record };
		yield* writeRecordFileEffect(options.storePath, updated);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: record.id,
			type: "done",
			summary: `Completed record with resolution ${options.resolution}.`,
			data: { resolution: result.record.resolution },
			now: options.now,
		});
		yield* rebuildRecordIndexesEffect(options.storePath);
		return updated;
	});
}

export function addRecordComment(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly body: string;
	readonly now?: Date;
}): Promise<RecordComment> {
	return runForgePromise(addRecordCommentEffect(options));
}

export function addRecordCommentEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly body: string;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		yield* readWorkflowRecordEffect(options.storePath, options.recordId);
		const comments = yield* readRecordCommentsFromDiskEffect(
			options.storePath,
			options.recordId,
		);
		const now = iso(options.now ?? new Date());
		const comment = yield* Effect.try({
			try: () =>
				parseRecordComment({
					id: allocateNextCommentId(options.recordId, comments),
					recordId: options.recordId,
					createdAt: now,
					updatedAt: now,
					body: options.body,
				}),
			catch: (error) => error,
		});
		yield* writeCommentFileEffect(options.storePath, comment);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: options.recordId,
			type: "comment",
			summary: `Added comment ${comment.id}.`,
			data: { commentId: comment.id },
			now: options.now,
		});
		return comment;
	});
}

export function listRecordComments(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<Array<RecordComment>> {
	return runForgePromise(listRecordCommentsEffect(storePath, recordId));
}

export function listRecordCommentsEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		yield* readWorkflowRecordEffect(storePath, recordId);
		return yield* readRecordCommentsFromDiskEffect(storePath, recordId);
	});
}

export function replaceRecordCommentFromEditedMarkdown(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly commentId: CommentId;
	readonly markdown: string;
	readonly now?: Date;
}): Promise<RecordComment> {
	return runForgePromise(replaceRecordCommentFromEditedMarkdownEffect(options));
}

export function replaceRecordCommentFromEditedMarkdownEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly commentId: CommentId;
	readonly markdown: string;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const before = yield* readRecordCommentEffect(
			options.storePath,
			options.recordId,
			options.commentId,
		);
		const edited = yield* Effect.try({
			try: () => {
				const parsed = parseRecordCommentMarkdown(options.markdown, {
					expectedRecordId: options.recordId,
					expectedCommentId: options.commentId,
				});
				validateCommentEdit(before, parsed);
				return { ...parsed, updatedAt: iso(options.now ?? new Date()) };
			},
			catch: (error) => error,
		});
		yield* writeCommentFileEffect(options.storePath, edited);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: options.recordId,
			type: "comment-edit",
			summary: `Edited comment ${options.commentId}.`,
			data: { commentId: options.commentId },
			now: options.now,
		});
		return edited;
	});
}

export function listRecordUpdates(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<Array<RecordUpdate>> {
	return runForgePromise(listRecordUpdatesEffect(storePath, recordId));
}

export function listRecordUpdatesEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		yield* readWorkflowRecordEffect(storePath, recordId);
		return yield* readRecordUpdatesFromDiskEffect(storePath, recordId);
	});
}

export function listRecordHistory(
	storePath: AbsolutePath,
	recordId: RecordId,
): Promise<ReadonlyArray<RecordHistoryEntry>> {
	return runForgePromise(listRecordHistoryEffect(storePath, recordId));
}

export function listRecordHistoryEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		return buildCombinedRecordHistory({
			comments: yield* listRecordCommentsEffect(storePath, recordId),
			updates: yield* listRecordUpdatesEffect(storePath, recordId),
		});
	});
}

export function listWorkflowRecordReadiness(
	storePath: AbsolutePath,
	options: WorkflowRecordReadinessQueryOptions = {},
): Promise<Array<ReadinessDiagnosis>> {
	return runForgePromise(listWorkflowRecordReadinessEffect(storePath, options));
}

export function listWorkflowRecordReadinessEffect(
	storePath: AbsolutePath,
	options: WorkflowRecordReadinessQueryOptions = {},
) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(storePath);
		return records
			.filter((record) => recordIsReadinessCandidate(record, records, options))
			.map((record) => diagnoseRecordReadiness(record, records))
			.filter((diagnosis) => diagnosis.ready !== (options.blocked === true));
	});
}

export function selectNextWorkflowRecord(
	storePath: AbsolutePath,
	options: NextRecordOptions = {},
): Promise<RecordFrontmatter | undefined> {
	return runForgePromise(selectNextWorkflowRecordEffect(storePath, options));
}

export function selectNextWorkflowRecordEffect(
	storePath: AbsolutePath,
	options: NextRecordOptions = {},
) {
	return Effect.gen(function* () {
		return selectNextRecord(
			yield* readAllWorkflowRecordsEffect(storePath),
			options,
		);
	});
}

export function replaceWorkflowRecordFromEditedMarkdown(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly markdown: string;
	readonly now?: Date;
}): Promise<WorkflowRecord> {
	return runForgePromise(
		replaceWorkflowRecordFromEditedMarkdownEffect(options),
	);
}

export function replaceWorkflowRecordFromEditedMarkdownEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly markdown: string;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const before = yield* readWorkflowRecordEffect(
			options.storePath,
			options.recordId,
		);
		const { edited, validation } = yield* Effect.try({
			try: () => {
				const parsed = parseWorkflowRecordMarkdown(options.markdown, {
					expectedId: before.id,
					expectedKind: before.kind,
				});
				const validation = validateFrontmatterEdit(before, parsed);
				const edited: WorkflowRecord = {
					...parsed,
					updatedAt: iso(options.now ?? new Date()),
				};
				return { edited, validation };
			},
			catch: (error) => error,
		});
		yield* writeRecordFileEffect(options.storePath, edited);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: edited.id,
			type: "edit",
			summary: "Edited record Markdown.",
			data: { changedFrontmatter: validation.changed },
			now: options.now,
		});
		return edited;
	});
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

export function rebuildRecordIndexes(storePath: AbsolutePath): Promise<void> {
	return runForgePromise(rebuildRecordIndexesEffect(storePath));
}

export function rebuildRecordIndexesEffect(storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(storePath);
		const byId: Record<string, RecordLocator> = {};
		const byProject: Record<string, Array<number>> = {};
		const byInitiative: Record<string, ByInitiativeRecordIndexEntryMutable> =
			{};
		const relationships: Record<string, MutableRelationshipRecordIndexEntry> =
			{};

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
		yield* writeJsonFileEffect(paths.byIdIndex, sortRecordObject(byId));
		yield* writeJsonFileEffect(
			paths.byProjectIndex,
			sortRecordObject(byProject),
		);
		yield* writeJsonFileEffect(
			paths.byInitiativeIndex,
			sortRecordObject(byInitiative),
		);
		yield* writeJsonFileEffect(
			paths.relationshipsIndex,
			sortRecordObject(relationships),
		);
	});
}

function mutateInitiativeDeclaredProjectsEffect(options: {
	readonly storePath: AbsolutePath;
	readonly initiativeId: RecordId;
	readonly project: ProjectId;
	readonly operation: "add" | "remove";
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(options.storePath);
		const result = yield* Effect.try({
			try: () => {
				const before = requireRecordFromList(records, options.initiativeId);
				if (
					before.kind !== "initiative" ||
					before.scope.type !== "project-set"
				) {
					validateInitiativeDeclaredProjectsEdit(before, before, records);
				}
				const beforeProjects =
					before.scope.type === "project-set" ? before.scope.projects : [];
				const afterProjects =
					options.operation === "add"
						? sortedUnique([...beforeProjects, options.project])
						: beforeProjects.filter((project) => project !== options.project);
				if (sameProjectIds(beforeProjects, afterProjects)) {
					return { before, updated: before, changedProjects: [] };
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
				return {
					before,
					updated,
					changedProjects:
						options.operation === "add" ? validation.added : validation.removed,
				};
			},
			catch: (error) => error,
		});
		if (result.updated === result.before) {
			return result.before;
		}
		yield* writeRecordFileEffect(options.storePath, result.updated);
		yield* rebuildRecordIndexesEffect(options.storePath);
		yield* appendRecordUpdateEffect({
			storePath: options.storePath,
			recordId: result.updated.id,
			type: `initiative-project-${options.operation}`,
			summary: `${options.operation === "add" ? "Added" : "Removed"} initiative project ${options.project}.`,
			data: { projects: result.changedProjects },
			now: options.now,
		});
		return result.updated;
	});
}

function validateRecordReferencesEffect(
	storePath: AbsolutePath,
	record: WorkflowRecord,
) {
	return Effect.gen(function* () {
		const records = yield* readAllWorkflowRecordsEffect(storePath);
		yield* Effect.try({
			try: () => {
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
			},
			catch: (error) => error,
		});
	});
}

function assertRecordPathIsFreeEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		for (const candidateKind of recordKindsForStorage) {
			const targetPath = recordFilePath(storePath, candidateKind, recordId);
			const exists = yield* fileSystem.stat(targetPath).pipe(
				Effect.map(() => true),
				Effect.catchIf(isMissingFile, () => Effect.succeed(false)),
			);
			if (!exists) {
				continue;
			}
			return yield* Effect.fail(
				new ForgeError({
					kind: "store-invalid",
					message: `Store manifest nextRecordId conflicts with existing record file '${targetPath}'. Run forge store doctor.`,
					details: { recordId, path: targetPath },
				}),
			);
		}
	});
}

function writeRecordFileEffect(
	storePath: AbsolutePath,
	record: WorkflowRecord,
) {
	const filePath = recordFilePath(storePath, record.kind, record.id);
	return writeAtomicTextFileEffect(
		filePath,
		formatWorkflowRecordMarkdown(record),
	);
}

function appendRecordUpdateEffect(options: {
	readonly storePath: AbsolutePath;
	readonly recordId: RecordId;
	readonly type: string;
	readonly summary: string;
	readonly data?: Readonly<Record<string, unknown>> | null;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		yield* readWorkflowRecordEffect(options.storePath, options.recordId);
		const update = createRecordUpdate({
			recordId: options.recordId,
			updates: yield* readRecordUpdatesFromDiskEffect(
				options.storePath,
				options.recordId,
			),
			type: options.type,
			summary: options.summary,
			data: options.data,
			now: options.now,
		});
		yield* writeJsonFileEffect(
			updateFilePath(
				options.storePath,
				options.recordId,
				update.sequence,
				update.type,
			),
			formatRecordUpdateJson(update),
		);
		return update;
	});
}

function readRecordCommentEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
	commentId: CommentId,
) {
	return Effect.gen(function* () {
		const markdown = yield* readFileStringEffect(
			commentFilePath(storePath, recordId, commentId),
		);
		return yield* Effect.try({
			try: () =>
				parseRecordCommentMarkdown(markdown, {
					expectedRecordId: recordId,
					expectedCommentId: commentId,
				}),
			catch: (error) => error,
		});
	});
}

function writeCommentFileEffect(
	storePath: AbsolutePath,
	comment: RecordComment,
) {
	return writeAtomicTextFileEffect(
		commentFilePath(storePath, comment.recordId, comment.id),
		formatRecordCommentMarkdown(comment),
	);
}

function writeAtomicTextFileEffect(filePath: AbsolutePath, content: string) {
	return Effect.gen(function* () {
		const temporaryPath = parseAbsolutePath(
			`${filePath}.tmp-${process.pid}-${Date.now()}`,
			"temporaryPath",
		);
		yield* Effect.gen(function* () {
			const fileSystem = yield* FileSystem;
			yield* fileSystem.makeDirectory(path.dirname(filePath), {
				recursive: true,
			});
			yield* fileSystem.writeFileString(temporaryPath, content);
			yield* fileSystem.rename(temporaryPath, filePath);
		}).pipe(
			Effect.ensuring(
				Effect.gen(function* () {
					const fileSystem = yield* FileSystem;
					yield* fileSystem
						.remove(temporaryPath, { recursive: false })
						.pipe(Effect.catchIf(isMissingFile, () => Effect.void));
				}).pipe(Effect.ignore),
			),
		);
	});
}

function readByIdIndexEffect(storePath: AbsolutePath) {
	return readJsonEffect(storeRootPaths(storePath).byIdIndex) as Effect.Effect<
		ByIdRecordIndex,
		unknown,
		FileSystem
	>;
}

function readRecordCommentsFromDiskEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const commentsDirectory = parseAbsolutePath(
			path.dirname(commentFilePath(storePath, recordId, 1 as CommentId)),
		);
		const files = yield* readDirectoryEffect(commentsDirectory).pipe(
			Effect.catchAll((error) => {
				if (isMissingFile(error)) {
					return Effect.succeed([]);
				}
				return Effect.fail(error);
			}),
		);
		const comments = yield* Effect.all(
			files
				.filter((file) => file.endsWith(".md"))
				.map((file) =>
					Effect.gen(function* () {
						const markdown = yield* readFileStringEffect(
							parseAbsolutePath(path.join(commentsDirectory, file)),
						);
						return yield* Effect.try({
							try: () => parseRecordCommentMarkdown(markdown),
							catch: (error) => error,
						});
					}),
				),
			{ concurrency: "unbounded" },
		);
		return comments.sort((left, right) => left.id - right.id);
	});
}

function readRecordUpdatesFromDiskEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
) {
	return Effect.gen(function* () {
		const updatesDirectory = parseAbsolutePath(
			path.dirname(updateFilePath(storePath, recordId, 1, "x")),
		);
		const files = yield* readDirectoryEffect(updatesDirectory).pipe(
			Effect.catchAll((error) => {
				if (isMissingFile(error)) {
					return Effect.succeed([]);
				}
				return Effect.fail(error);
			}),
		);
		const updates = yield* Effect.all(
			files
				.filter((file) => file.endsWith(".json"))
				.map((file) =>
					Effect.gen(function* () {
						const value = yield* readJsonEffect(
							parseAbsolutePath(path.join(updatesDirectory, file)),
						);
						return yield* Effect.try({
							try: () => parseRecordUpdateJson(value, recordId),
							catch: (error) => error,
						});
					}),
				),
			{ concurrency: "unbounded" },
		);
		return updates.sort((left, right) => left.sequence - right.sequence);
	});
}

function readAllWorkflowRecords(
	storePath: AbsolutePath,
): Promise<Array<WorkflowRecord>> {
	return runForgePromise(readAllWorkflowRecordsEffect(storePath));
}

function readAllWorkflowRecordsEffect(storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const paths = storeRootPaths(storePath);
		const records: Array<WorkflowRecord> = [];
		for (const kind of recordKindsForStorage) {
			const kindDirectory = parseAbsolutePath(path.join(paths.records, kind));
			const shards = yield* readDirectoryEffect(kindDirectory).pipe(
				Effect.catchAll((error) => {
					if (isMissingFile(error)) {
						return Effect.succeed([]);
					}
					return Effect.fail(error);
				}),
			);
			for (const shard of shards) {
				const shardDirectory = parseAbsolutePath(
					path.join(kindDirectory, shard),
				);
				const files = yield* readDirectoryEffect(shardDirectory);
				for (const file of files.filter((candidate) =>
					candidate.endsWith(".md"),
				)) {
					const record = yield* readWorkflowRecordAtPathEffect(
						storePath,
						path.relative(paths.root, path.join(shardDirectory, file)),
						{ expectedKind: kind },
					);
					records.push(record);
				}
			}
		}
		return records.sort((left, right) => left.id - right.id);
	});
}

function readWorkflowRecordAtPathEffect(
	storePath: AbsolutePath,
	relativePath: string,
	expectations: {
		readonly expectedId?: RecordId;
		readonly expectedKind?: RecordKind;
	},
) {
	return Effect.gen(function* () {
		const filePath = parseAbsolutePath(path.join(storePath, relativePath));
		const markdown = yield* readFileStringEffect(filePath);
		return yield* Effect.try({
			try: () => parseWorkflowRecordMarkdown(markdown, expectations),
			catch: (error) => error,
		});
	});
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

function readFileStringEffect(filePath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.readFileString(filePath, "utf8");
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
			(error as { readonly code?: string }).code === "ENOENT") ||
		(typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "SystemError" &&
			"reason" in error &&
			error.reason === "NotFound")
	);
}
