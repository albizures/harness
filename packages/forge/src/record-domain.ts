import { Schema as S } from "effect";

import {
	decodeStoreManifest,
	projectIdPattern,
	resolutionSlugPattern,
	type IsoDateTime,
	type ProjectId,
	type StoreManifest,
} from "./domain.ts";
import { ForgeError } from "./errors.ts";

export type RecordId = number & { readonly __brand: "RecordId" };

export type RecordKind =
	| "initiative"
	| "wayfinder"
	| "spec"
	| "task"
	| "grilling";
export type TaskSubkind = "research" | "prototype" | "review";
export type RecordSubkind = TaskSubkind | null;
export type RecordState = "ready" | "in-progress" | "done";
export type LifecycleResolution = string & {
	readonly __brand: "LifecycleResolution";
};
export type CommentId = number & { readonly __brand: "CommentId" };

export type RecordScope =
	| { readonly type: "project"; readonly project: ProjectId }
	| {
			readonly type: "project-set";
			readonly projects: ReadonlyArray<ProjectId>;
	  }
	| { readonly type: "initiative"; readonly initiative: RecordId }
	| { readonly type: "global" };

export type RecordFrontmatter = {
	readonly id: RecordId;
	readonly title: string;
	readonly kind: RecordKind;
	readonly subkind: RecordSubkind;
	readonly state: RecordState;
	readonly resolution: string | null;
	readonly scope: RecordScope;
	readonly parent: RecordId | null;
	readonly initiative: RecordId | null;
	readonly dependsOn: ReadonlyArray<RecordId>;
	readonly generatedBy: RecordId | null;
	readonly tags: ReadonlyArray<string>;
	readonly profile: string | null;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
};

export type WorkflowRecord = RecordFrontmatter & {
	readonly body: string;
};

export type RecordComment = {
	readonly id: CommentId;
	readonly recordId: RecordId;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
	readonly body: string;
};

export type RecordUpdate = {
	readonly sequence: number;
	readonly recordId: RecordId;
	readonly createdAt: IsoDateTime;
	readonly type: string;
	readonly summary: string;
	readonly data: Readonly<Record<string, unknown>> | null;
};

export type RecordHistoryEntry =
	| {
			readonly kind: "comment";
			readonly createdAt: IsoDateTime;
			readonly comment: RecordComment;
	  }
	| {
			readonly kind: "update";
			readonly createdAt: IsoDateTime;
			readonly update: RecordUpdate;
	  };

export type LifecycleTransitionResult = {
	readonly record: RecordFrontmatter;
	readonly changed: boolean;
};

export type RecordValidationIssue = {
	readonly field: string;
	readonly message: string;
};

export class RecordValidationError extends ForgeError {
	readonly issues: ReadonlyArray<RecordValidationIssue>;

	constructor(message: string, issues: ReadonlyArray<RecordValidationIssue>) {
		const issueSummary = issues.map((issue) => issue.message).join("; ");
		super({
			kind: "record-invalid",
			message: issueSummary === "" ? message : `${message}: ${issueSummary}`,
			details: { issues },
		});
		this.name = "RecordValidationError";
		this.issues = issues;
	}
}

export type AllocateRecordIdResult = {
	readonly recordId: RecordId;
	readonly manifest: StoreManifest;
};

export type FrontmatterEditValidation = {
	readonly changed: ReadonlyArray<EditableFrontmatterField>;
};

export type InitiativeDeclaredProjectsEditValidation = {
	readonly added: ReadonlyArray<ProjectId>;
	readonly removed: ReadonlyArray<ProjectId>;
};

export type DependencyGraphEntry = {
	readonly dependsOn: ReadonlyArray<RecordId>;
	readonly dependents: ReadonlyArray<RecordId>;
};

export type DependencyGraph = Readonly<Record<string, DependencyGraphEntry>>;

export type RecordTreeNode = {
	readonly record: RecordFrontmatter;
	readonly children: ReadonlyArray<RecordTreeNode>;
};

export type RecordDependencyView = {
	readonly record: RecordFrontmatter;
	readonly dependsOn: ReadonlyArray<RecordFrontmatter>;
	readonly dependents: ReadonlyArray<RecordFrontmatter>;
	readonly missingDependencies: ReadonlyArray<RecordId>;
};

export const relationshipIndexRequirementFields = [
	"parent",
	"children",
	"initiative",
	"initiativeMembers",
	"dependsOn",
	"dependents",
	"generatedBy",
	"generated",
] as const;

export type RelationshipIndexRequirementField =
	(typeof relationshipIndexRequirementFields)[number];

export type ReadinessBlockerKind =
	| "record-done"
	| "dependency-open"
	| "dependency-missing"
	| "parent-done"
	| "parent-missing"
	| "initiative-empty"
	| "initiative-member-invalid";

export type ReadinessBlocker = {
	readonly kind: ReadinessBlockerKind;
	readonly recordId?: RecordId;
	readonly message: string;
};

export type ReadinessDiagnosis = {
	readonly recordId: RecordId;
	readonly ready: boolean;
	readonly reasons: ReadonlyArray<ReadinessBlocker>;
};

export type NextRecordOptions = {
	readonly includeHitl?: boolean;
	readonly planning?: boolean;
	readonly project?: ProjectId;
	readonly initiative?: RecordId;
};

export const recordKinds = [
	"initiative",
	"wayfinder",
	"spec",
	"task",
	"grilling",
] as const;
export const taskSubkinds = ["research", "prototype", "review"] as const;
export const editableFrontmatterFields = ["title", "tags", "profile"] as const;
export const immutableFrontmatterFields = [
	"id",
	"kind",
	"subkind",
	"scope",
	"parent",
	"initiative",
	"createdAt",
] as const;
export const lifecycleFrontmatterFields = ["state", "resolution"] as const;
export const relationshipFrontmatterFields = [
	"parent",
	"initiative",
	"dependsOn",
	"generatedBy",
] as const;
export const toolOwnedFrontmatterFields = ["updatedAt"] as const;

export type EditableFrontmatterField =
	(typeof editableFrontmatterFields)[number];

const frontmatterKeys = [
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

const projectIdSchema = S.String.pipe(
	S.filter((value) => projectIdPattern.test(value), {
		message: () =>
			"must be lowercase kebab-case matching [a-z0-9][a-z0-9-]*[a-z0-9]",
	}),
);

const isoDateTimeSchema = S.String.pipe(
	S.filter((value) => !Number.isNaN(Date.parse(value)), {
		message: () => "must be an ISO-compatible date-time string",
	}),
);

export const recordIdSchema: S.Schema<RecordId> = S.Number.pipe(
	S.int(),
	S.greaterThan(0),
	S.filter((value) => Number.isSafeInteger(value), {
		message: () => "must be a safe integer",
	}),
) as unknown as S.Schema<RecordId>;

export const recordScopeSchema: S.Schema<RecordScope> = S.Union(
	S.Struct({ type: S.Literal("project"), project: projectIdSchema }),
	S.Struct({
		type: S.Literal("project-set"),
		projects: S.Array(projectIdSchema).pipe(S.minItems(1)),
	}),
	S.Struct({ type: S.Literal("initiative"), initiative: recordIdSchema }),
	S.Struct({ type: S.Literal("global") }),
) as unknown as S.Schema<RecordScope>;

export const recordCommentSchema: S.Schema<RecordComment> = S.Struct({
	id: recordIdSchema as unknown as S.Schema<CommentId>,
	recordId: recordIdSchema,
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
	body: S.String,
}) as unknown as S.Schema<RecordComment>;

export const recordUpdateSchema: S.Schema<RecordUpdate> = S.Struct({
	sequence: S.Number.pipe(S.int(), S.greaterThan(0)),
	recordId: recordIdSchema,
	createdAt: isoDateTimeSchema,
	type: S.NonEmptyString,
	summary: S.NonEmptyString,
	data: S.Union(S.Record({ key: S.String, value: S.Unknown }), S.Null),
}) as unknown as S.Schema<RecordUpdate>;

export const recordFrontmatterSchema: S.Schema<RecordFrontmatter> = S.Struct({
	id: recordIdSchema,
	title: S.NonEmptyString,
	kind: S.Literal("initiative", "wayfinder", "spec", "task", "grilling"),
	subkind: S.Union(S.Literal("research", "prototype", "review"), S.Null),
	state: S.Literal("ready", "in-progress", "done"),
	resolution: S.Union(
		S.String.pipe(
			S.filter((value) => resolutionSlugPattern.test(value), {
				message: () =>
					"must be lowercase kebab-case matching [a-z0-9][a-z0-9-]*[a-z0-9]",
			}),
		),
		S.Null,
	),
	scope: recordScopeSchema,
	parent: S.Union(recordIdSchema, S.Null),
	initiative: S.Union(recordIdSchema, S.Null),
	dependsOn: S.Array(recordIdSchema),
	generatedBy: S.Union(recordIdSchema, S.Null),
	tags: S.Array(S.NonEmptyString),
	profile: S.Union(S.NonEmptyString, S.Null),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
}) as unknown as S.Schema<RecordFrontmatter>;

export function parseRecordId(value: unknown): RecordId {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return value as RecordId;
	}
	throw new RecordValidationError("record id must be a positive integer", [
		{ field: "id", message: "record id must be a positive integer" },
	]);
}

export function parseRecordComment(value: unknown): RecordComment {
	const decoded = S.decodeUnknownEither(recordCommentSchema)(value);
	if (decoded._tag === "Right") {
		return decoded.right;
	}
	throw new RecordValidationError("record comment is invalid", [
		{
			field: "comment",
			message: "record comment does not match the comment schema",
		},
	]);
}

export function parseRecordUpdate(value: unknown): RecordUpdate {
	const decoded = S.decodeUnknownEither(recordUpdateSchema)(value);
	if (decoded._tag === "Right") {
		return decoded.right;
	}
	throw new RecordValidationError("record update is invalid", [
		{
			field: "update",
			message: "record update does not match the update schema",
		},
	]);
}

export function parseLifecycleResolution(value: string): LifecycleResolution {
	if (resolutionSlugPattern.test(value)) {
		return value as LifecycleResolution;
	}
	throw new RecordValidationError("resolution is invalid", [
		{
			field: "resolution",
			message:
				"resolution must be lowercase kebab-case matching [a-z0-9][a-z0-9-]*[a-z0-9]",
		},
	]);
}

export function parseRecordFrontmatter(value: unknown): RecordFrontmatter {
	const issues = collectObjectShapeIssues(value);
	const decoded = S.decodeUnknownEither(recordFrontmatterSchema)(value);
	if (decoded._tag === "Left") {
		issues.push({
			field: "frontmatter",
			message: "record frontmatter does not match the record schema",
		});
		throw new RecordValidationError("record frontmatter is invalid", issues);
	}
	if (issues.length > 0) {
		throw new RecordValidationError("record frontmatter is invalid", issues);
	}
	const record = decoded.right;
	validateRecordPlacement(record);
	return normalizeRecordFrontmatter(record);
}

export function allocateRecordId(options: {
	readonly manifest: StoreManifest | unknown;
	readonly now?: Date;
}): AllocateRecordIdResult {
	const manifest = decodeStoreManifest(options.manifest);
	const recordId = parseRecordId(manifest.nextRecordId);
	return {
		recordId,
		manifest: {
			...manifest,
			nextRecordId: manifest.nextRecordId + 1,
			updatedAt: (options.now ?? new Date()).toISOString() as IsoDateTime,
		},
	};
}

export function validateRecordPlacement(
	record: RecordFrontmatter,
	options: { readonly parent?: RecordFrontmatter } = {},
): void {
	const issues: Array<RecordValidationIssue> = [];

	if (record.kind === "initiative") {
		if (record.parent !== null) {
			issues.push({
				field: "parent",
				message: "record-kind 'initiative' cannot have a parent",
			});
		}
		if (record.subkind !== null) {
			issues.push({
				field: "subkind",
				message: "record-kind 'initiative' requires subkind null",
			});
		}
		if (record.scope.type !== "project-set") {
			issues.push({
				field: "scope",
				message: "record-kind 'initiative' requires project-set scope",
			});
		}
		if (record.initiative !== null) {
			issues.push({
				field: "initiative",
				message: "record-kind 'initiative' cannot belong to an initiative",
			});
		}
	}

	if (record.kind === "spec") {
		if (record.parent !== null) {
			issues.push({
				field: "parent",
				message: "record-kind 'spec' cannot have a parent",
			});
		}
		if (record.subkind !== null) {
			issues.push({
				field: "subkind",
				message: "record-kind 'spec' requires subkind null",
			});
		}
		if (record.scope.type !== "project") {
			issues.push({
				field: "scope",
				message: "record-kind 'spec' requires project scope",
			});
		}
	}

	if (record.kind === "wayfinder") {
		if (record.parent !== null) {
			issues.push({
				field: "parent",
				message: "record-kind 'wayfinder' cannot have a parent",
			});
		}
		if (record.subkind !== null) {
			issues.push({
				field: "subkind",
				message: "record-kind 'wayfinder' requires subkind null",
			});
		}
	}

	if (record.kind === "grilling") {
		if (record.parent === null) {
			issues.push({
				field: "parent",
				message: "record-kind 'grilling' requires a parent",
			});
		}
		if (record.subkind !== null) {
			issues.push({
				field: "subkind",
				message: "record-kind 'grilling' requires subkind null",
			});
		}
	}

	if (record.kind === "task") {
		if (record.parent === null) {
			issues.push({
				field: "parent",
				message: "record-kind 'task' requires a parent",
			});
		}
	}

	if (
		record.initiative !== null &&
		record.kind !== "spec" &&
		record.kind !== "wayfinder"
	) {
		issues.push({
			field: "initiative",
			message: "only spec and wayfinder records may belong to an initiative",
		});
	}

	if (record.state === "done" && record.resolution === null) {
		issues.push({
			field: "resolution",
			message: "done records require a resolution",
		});
	}
	if (record.state !== "done" && record.resolution !== null) {
		issues.push({
			field: "resolution",
			message: "open records cannot have a resolution",
		});
	}
	if (record.dependsOn.includes(record.id)) {
		issues.push({
			field: "dependsOn",
			message: "records cannot depend on themselves",
		});
	}
	if (record.generatedBy === record.id) {
		issues.push({
			field: "generatedBy",
			message: "records cannot be generated by themselves",
		});
	}

	if (options.parent !== undefined) {
		issues.push(...validateParent(record, options.parent));
	}

	if (issues.length > 0) {
		throw new RecordValidationError(
			"error validating record placement",
			issues,
		);
	}
}

export function validateFrontmatterEdit(
	before: RecordFrontmatter,
	after: RecordFrontmatter,
): FrontmatterEditValidation {
	const changed = frontmatterKeys.filter(
		(key) => !deepEqual(before[key], after[key]),
	);
	const invalid = changed.filter(
		(field) =>
			!editableFrontmatterFields.includes(field as EditableFrontmatterField),
	);
	if (invalid.length > 0) {
		throw new RecordValidationError(
			"error validating record frontmatter edit",
			[
				...invalid.map((field) => ({
					field,
					message: `field '${field}' is not editable through record frontmatter edits`,
				})),
			],
		);
	}
	return { changed: changed as ReadonlyArray<EditableFrontmatterField> };
}

export function validateInitiativeMembership(
	member: RecordFrontmatter,
	initiative: RecordFrontmatter,
): void {
	const issues = collectInitiativeMembershipIssues(member, initiative);
	if (issues.length > 0) {
		throw new RecordValidationError(
			"error validating initiative membership",
			issues,
		);
	}
}

export function validateInitiativeDeclaredProjectsEdit(
	before: RecordFrontmatter,
	after: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
): InitiativeDeclaredProjectsEditValidation {
	const issues: Array<RecordValidationIssue> = [];
	if (before.kind !== "initiative" || after.kind !== "initiative") {
		issues.push({
			field: "kind",
			message: "declared project edits require initiative records",
		});
	}
	const changed = frontmatterKeys.filter(
		(key) => !deepEqual(before[key], after[key]),
	);
	const invalid = changed.filter((field) => field !== "scope");
	for (const field of invalid) {
		issues.push({
			field,
			message: `field '${field}' is not editable through initiative declared project edits`,
		});
	}
	if (
		before.scope.type !== "project-set" ||
		after.scope.type !== "project-set"
	) {
		issues.push({
			field: "scope",
			message: "initiative declared projects require project-set scope",
		});
	}
	if (issues.length > 0) {
		throw new RecordValidationError(
			"error validating initiative declared project edit",
			issues,
		);
	}

	const beforeProjects =
		before.scope.type === "project-set" ? before.scope.projects : [];
	const afterProjects =
		after.scope.type === "project-set" ? after.scope.projects : [];
	const added = afterProjects.filter(
		(project) => !beforeProjects.includes(project),
	);
	const removed = beforeProjects.filter(
		(project) => !afterProjects.includes(project),
	);
	for (const project of removed) {
		const member = records.find(
			(candidate) =>
				candidate.initiative === before.id &&
				recordProjects(candidate).includes(project),
		);
		if (member !== undefined) {
			issues.push({
				field: "scope",
				message: `cannot remove declared project '${project}' while member ${member.id} uses it`,
			});
		}
	}
	if (issues.length > 0) {
		throw new RecordValidationError(
			"error validating initiative declared project edit",
			issues,
		);
	}
	return {
		added: sortedUniqueProjectIds(added),
		removed: sortedUniqueProjectIds(removed),
	};
}

export function startRecordLifecycle(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
	now = new Date(),
): LifecycleTransitionResult {
	if (record.state === "done") {
		throw new RecordValidationError("record cannot be started", [
			{
				field: "state",
				message: `Done record ${record.id} cannot be started.`,
			},
		]);
	}
	if (record.state === "in-progress") {
		return { record, changed: false };
	}
	const readiness = diagnoseRecordReadiness(record, records);
	if (!readiness.ready) {
		throw new RecordValidationError("record cannot be started", [
			{
				field: "state",
				message: `Record ${record.id} is blocked and cannot be started: ${readiness.reasons.map((reason) => reason.message).join(" ")}`,
			},
		]);
	}
	return {
		record: { ...record, state: "in-progress", updatedAt: iso(now) },
		changed: true,
	};
}

export function completeRecordLifecycle(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
	resolutionInput: string,
	now = new Date(),
): LifecycleTransitionResult {
	const resolution = parseLifecycleResolution(resolutionInput);
	if (record.state === "done") {
		if (record.resolution === resolution) {
			return { record, changed: false };
		}
		throw new RecordValidationError("record resolution cannot be changed", [
			{
				field: "resolution",
				message: `Done record ${record.id} already has resolution '${record.resolution}'.`,
			},
		]);
	}
	validateCompletionGates(record, records);
	return {
		record: {
			...record,
			state: "done",
			resolution,
			updatedAt: iso(now),
		},
		changed: true,
	};
}

export function allocateNextCommentId(
	recordId: RecordId,
	comments: ReadonlyArray<RecordComment>,
): CommentId {
	return (maxSequence(
		comments
			.filter((comment) => comment.recordId === recordId)
			.map((comment) => comment.id),
	) + 1) as CommentId;
}

export function createRecordUpdate(options: {
	readonly recordId: RecordId;
	readonly updates: ReadonlyArray<RecordUpdate>;
	readonly type: string;
	readonly summary: string;
	readonly data?: Readonly<Record<string, unknown>> | null;
	readonly now?: Date;
}): RecordUpdate {
	return parseRecordUpdate({
		sequence:
			maxSequence(
				options.updates
					.filter((update) => update.recordId === options.recordId)
					.map((update) => update.sequence),
			) + 1,
		recordId: options.recordId,
		createdAt: iso(options.now ?? new Date()),
		type: options.type,
		summary: options.summary,
		data: options.data ?? null,
	});
}

export function validateCommentEdit(
	before: RecordComment,
	after: RecordComment,
): RecordComment {
	const changedFrontmatter = (
		["id", "recordId", "createdAt", "updatedAt"] as const
	).filter((key) => before[key] !== after[key]);
	if (changedFrontmatter.length > 0) {
		throw new RecordValidationError("comment edit is invalid", [
			...changedFrontmatter.map((field) => ({
				field,
				message: `comment frontmatter field '${field}' is not editable`,
			})),
		]);
	}
	return after;
}

export function buildCombinedRecordHistory(options: {
	readonly comments: ReadonlyArray<RecordComment>;
	readonly updates: ReadonlyArray<RecordUpdate>;
}): ReadonlyArray<RecordHistoryEntry> {
	return [
		...options.comments.map((comment) => ({
			kind: "comment" as const,
			createdAt: comment.createdAt,
			comment,
		})),
		...options.updates.map((update) => ({
			kind: "update" as const,
			createdAt: update.createdAt,
			update,
		})),
	].sort(compareHistoryEntries);
}

export function validateDependencyEdge(options: {
	readonly record: RecordFrontmatter;
	readonly dependsOn: RecordFrontmatter;
	readonly records: ReadonlyArray<RecordFrontmatter>;
}): void {
	const issues: Array<RecordValidationIssue> = [];
	const { record, dependsOn } = options;

	if (record.id === dependsOn.id) {
		issues.push({
			field: "dependsOn",
			message: "records cannot depend on themselves",
		});
	}
	if (isParentChildPair(record, dependsOn)) {
		issues.push({
			field: "dependsOn",
			message:
				"direct dependency edges between parents and children are disallowed",
		});
	}
	if (!dependencyScopesAreCompatible(record, dependsOn, options.records)) {
		issues.push({
			field: "dependsOn",
			message: "dependency scopes are not compatible",
		});
	} else if (!recordScopesOverlap(record.scope, dependsOn.scope)) {
		const initiativeId = effectiveInitiativeId(record, options.records);
		if (
			initiativeId !== null &&
			initiativeId === effectiveInitiativeId(dependsOn, options.records)
		) {
			const initiative = options.records.find(
				(candidate) => candidate.id === initiativeId,
			);
			const recordMember = initiativeMemberFor(
				record,
				initiativeId,
				options.records,
			);
			const dependsOnMember = initiativeMemberFor(
				dependsOn,
				initiativeId,
				options.records,
			);
			if (initiative === undefined) {
				issues.push({
					field: "initiative",
					message: `shared initiative ${initiativeId} was not found`,
				});
			} else if (recordMember === undefined || dependsOnMember === undefined) {
				issues.push({
					field: "initiative",
					message: `shared initiative ${initiativeId} member was not found`,
				});
			} else {
				issues.push(
					...collectInitiativeMembershipIssues(recordMember, initiative),
				);
				issues.push(
					...collectInitiativeMembershipIssues(dependsOnMember, initiative),
				);
			}
		}
	}
	if (dependencyWouldCreateCycle(record.id, dependsOn.id, options.records)) {
		issues.push({
			field: "dependsOn",
			message: "dependency would create a cycle",
		});
	}

	if (issues.length > 0) {
		throw new RecordValidationError("error validating dependency edge", issues);
	}
}

export function buildDependencyGraph(
	records: ReadonlyArray<RecordFrontmatter>,
): DependencyGraph {
	const graph: Record<
		string,
		{ dependsOn: Array<RecordId>; dependents: Array<RecordId> }
	> = {};
	for (const record of records) {
		graph[String(record.id)] = {
			dependsOn: [...record.dependsOn],
			dependents: [],
		};
	}
	for (const record of records) {
		for (const dependency of record.dependsOn) {
			graph[String(dependency)] ??= { dependsOn: [], dependents: [] };
			graph[String(dependency)].dependents.push(record.id);
		}
	}
	return Object.fromEntries(
		Object.entries(graph)
			.sort(compareRecordKeyEntries)
			.map(([id, entry]) => [
				id,
				{
					dependsOn: sortedUniqueRecordIds(entry.dependsOn),
					dependents: sortedUniqueRecordIds(entry.dependents),
				},
			]),
	);
}

export function buildRecordTree(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
): RecordTreeNode {
	const children = records
		.filter((candidate) => candidate.parent === record.id)
		.sort((left, right) => left.id - right.id)
		.map((child) => buildRecordTree(child, records));
	return { record, children };
}

export function buildRecordDependencyView(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
): RecordDependencyView {
	const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
	return {
		record,
		dependsOn: record.dependsOn
			.map((recordId) => byId.get(recordId))
			.filter((candidate) => candidate !== undefined),
		dependents: records
			.filter((candidate) => candidate.dependsOn.includes(record.id))
			.sort((left, right) => left.id - right.id),
		missingDependencies: record.dependsOn.filter(
			(recordId) => !byId.has(recordId),
		),
	};
}

export function diagnoseRecordReadiness(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
): ReadinessDiagnosis {
	const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
	const reasons: Array<ReadinessBlocker> = [];
	if (record.state === "done") {
		reasons.push({
			kind: "record-done",
			recordId: record.id,
			message: `Record ${record.id} is done.`,
		});
	}
	for (const dependencyId of record.dependsOn) {
		const dependency = byId.get(dependencyId);
		if (dependency === undefined) {
			reasons.push({
				kind: "dependency-missing",
				recordId: dependencyId,
				message: `Dependency ${dependencyId} was not found.`,
			});
			continue;
		}
		if (dependency.state !== "done") {
			reasons.push({
				kind: "dependency-open",
				recordId: dependencyId,
				message: `Dependency ${dependencyId} is ${dependency.state}, not done.`,
			});
		}
	}
	if (record.parent !== null) {
		const parent = byId.get(record.parent);
		if (parent === undefined) {
			reasons.push({
				kind: "parent-missing",
				recordId: record.parent,
				message: `Parent ${record.parent} was not found.`,
			});
		} else if (parent.state === "done") {
			reasons.push({
				kind: "parent-done",
				recordId: parent.id,
				message: `Parent ${parent.id} is done, so child ${record.id} is no longer executable.`,
			});
		}
	}
	if (record.kind === "initiative") {
		const members = records.filter(
			(candidate) => candidate.initiative === record.id,
		);
		if (members.length === 0) {
			reasons.push({
				kind: "initiative-empty",
				recordId: record.id,
				message: `Initiative ${record.id} must have at least one member spec or member wayfinder before it can start.`,
			});
		}
		for (const member of members) {
			for (const issue of collectInitiativeMembershipIssues(member, record)) {
				reasons.push({
					kind: "initiative-member-invalid",
					recordId: member.id,
					message: issue.message,
				});
			}
		}
	}
	return { recordId: record.id, ready: reasons.length === 0, reasons };
}

export function selectNextRecord(
	records: ReadonlyArray<RecordFrontmatter>,
	options: NextRecordOptions = {},
): RecordFrontmatter | undefined {
	return records
		.filter((record) => recordIsInScope(record, records, options))
		.filter((record) => recordKindMatchesNavigationMode(record, options))
		.filter((record) => diagnoseRecordReadiness(record, records).ready)
		.sort((left, right) => left.id - right.id)[0];
}

function recordKindMatchesNavigationMode(
	record: RecordFrontmatter,
	options: NextRecordOptions,
): boolean {
	if (record.kind === "grilling") {
		return options.includeHitl === true;
	}
	if (record.kind === "task") {
		return true;
	}
	return options.planning === true;
}

function validateCompletionGates(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
): void {
	const openChildren = records.filter(
		(candidate) => candidate.parent === record.id && candidate.state !== "done",
	);
	const openInitiativeMembers = records.filter(
		(candidate) =>
			candidate.initiative === record.id && candidate.state !== "done",
	);
	if (record.kind === "initiative" && openInitiativeMembers.length > 0) {
		throw new RecordValidationError("record cannot be done", [
			...openInitiativeMembers.map((member) => ({
				field: "state",
				message: `initiative records cannot be done while member ${member.id} is ${member.state}`,
			})),
		]);
	}
	if (
		(record.kind === "spec" || record.kind === "wayfinder") &&
		openChildren.length > 0
	) {
		throw new RecordValidationError("record cannot be done", [
			...openChildren.map((child) => ({
				field: "state",
				message: `${record.kind} records cannot be done while child ${child.id} is ${child.state}`,
			})),
		]);
	}
}

function maxSequence(values: ReadonlyArray<number>): number {
	return values.length === 0 ? 0 : Math.max(...values);
}

function compareHistoryEntries(
	left: RecordHistoryEntry,
	right: RecordHistoryEntry,
): number {
	const byDate = left.createdAt.localeCompare(right.createdAt);
	if (byDate !== 0) {
		return byDate;
	}
	if (left.kind !== right.kind) {
		return left.kind === "update" ? -1 : 1;
	}
	if (left.kind === "update" && right.kind === "update") {
		return left.update.sequence - right.update.sequence;
	}
	if (left.kind === "comment" && right.kind === "comment") {
		return left.comment.id - right.comment.id;
	}
	return 0;
}

function iso(date: Date): IsoDateTime {
	return date.toISOString() as IsoDateTime;
}

function isParentChildPair(
	left: RecordFrontmatter,
	right: RecordFrontmatter,
): boolean {
	return left.parent === right.id || right.parent === left.id;
}

function dependencyScopesAreCompatible(
	record: RecordFrontmatter,
	dependsOn: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
): boolean {
	const recordInitiative = effectiveInitiativeId(record, records);
	return (
		recordScopesOverlap(record.scope, dependsOn.scope) ||
		(recordInitiative !== null &&
			recordInitiative === effectiveInitiativeId(dependsOn, records))
	);
}

function effectiveInitiativeId(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
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

function initiativeMemberFor(
	record: RecordFrontmatter,
	initiativeId: RecordId,
	records: ReadonlyArray<RecordFrontmatter>,
): RecordFrontmatter | undefined {
	if (
		record.initiative === initiativeId ||
		record.scope.type === "initiative"
	) {
		return record;
	}
	if (record.parent === null) {
		return undefined;
	}
	const parent = records.find((candidate) => candidate.id === record.parent);
	return parent === undefined
		? undefined
		: initiativeMemberFor(parent, initiativeId, records);
}

function collectInitiativeMembershipIssues(
	member: RecordFrontmatter,
	initiative: RecordFrontmatter,
): ReadonlyArray<RecordValidationIssue> {
	const issues: Array<RecordValidationIssue> = [];
	if (initiative.kind !== "initiative") {
		issues.push({
			field: "initiative",
			message: `record ${initiative.id} is not an initiative`,
		});
	}
	if (initiative.scope.type !== "project-set") {
		issues.push({
			field: "scope",
			message: "initiative must use project-set scope",
		});
	}
	if (member.initiative !== initiative.id) {
		issues.push({
			field: "initiative",
			message: "member initiative id does not match supplied initiative record",
		});
	}
	if (
		member.scope.type === "initiative" &&
		member.scope.initiative !== initiative.id
	) {
		issues.push({
			field: "scope",
			message:
				"member initiative scope does not match supplied initiative record",
		});
	}
	if (member.kind !== "spec" && member.kind !== "wayfinder") {
		issues.push({
			field: "initiative",
			message: "only spec and wayfinder records may belong to an initiative",
		});
	}
	const declaredProjects =
		initiative.scope.type === "project-set" ? initiative.scope.projects : [];
	for (const project of recordProjects(member)) {
		if (!declaredProjects.includes(project)) {
			issues.push({
				field: "initiative",
				message: `initiative does not declare project '${project}' used by member ${member.id}`,
			});
		}
	}
	return issues;
}

function dependencyWouldCreateCycle(
	recordId: RecordId,
	dependsOnId: RecordId,
	records: ReadonlyArray<RecordFrontmatter>,
): boolean {
	const byId = new Map(records.map((record) => [record.id, record]));
	const pending = [dependsOnId];
	const seen = new Set<RecordId>();
	while (pending.length > 0) {
		const currentId = pending.pop();
		if (currentId === undefined || seen.has(currentId)) {
			continue;
		}
		if (currentId === recordId) {
			return true;
		}
		seen.add(currentId);
		pending.push(...(byId.get(currentId)?.dependsOn ?? []));
	}
	return false;
}

function recordScopesOverlap(left: RecordScope, right: RecordScope): boolean {
	return scopeProjects(left).some((project) =>
		scopeProjects(right).includes(project),
	);
}

function scopeProjects(scope: RecordScope): ReadonlyArray<ProjectId> {
	if (scope.type === "project") {
		return [scope.project];
	}
	if (scope.type === "project-set") {
		return scope.projects;
	}
	return [];
}

function recordProjects(record: RecordFrontmatter): ReadonlyArray<ProjectId> {
	return scopeProjects(record.scope);
}

function recordIsInScope(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
	options: NextRecordOptions,
): boolean {
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

function recordBelongsToInitiativeScope(
	record: RecordFrontmatter,
	initiativeId: RecordId,
	records: ReadonlyArray<RecordFrontmatter>,
): boolean {
	return effectiveInitiativeId(record, records) === initiativeId;
}

function recordHasProjectContext(
	record: RecordFrontmatter,
	records: ReadonlyArray<RecordFrontmatter>,
	project: ProjectId,
): boolean {
	if (scopeProjects(record.scope).includes(project)) {
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

function sortedUniqueRecordIds(
	values: ReadonlyArray<RecordId>,
): Array<RecordId> {
	return [...new Set(values)].sort((left, right) => left - right);
}

function sortedUniqueProjectIds(
	values: ReadonlyArray<ProjectId>,
): Array<ProjectId> {
	return [...new Set(values)].sort();
}

function compareRecordKeyEntries(
	[left]: readonly [string, unknown],
	[right]: readonly [string, unknown],
): number {
	return Number(left) - Number(right);
}

function validateParent(
	record: RecordFrontmatter,
	parent: RecordFrontmatter,
): ReadonlyArray<RecordValidationIssue> {
	const issues: Array<RecordValidationIssue> = [];
	if (record.parent !== parent.id) {
		issues.push({
			field: "parent",
			message: "parent id does not match supplied parent record",
		});
	}
	if (record.kind !== "task" && record.kind !== "grilling") {
		issues.push({
			field: "parent",
			message: "only task and grilling records may have a parent",
		});
	}
	if (parent.kind !== "spec" && parent.kind !== "wayfinder") {
		issues.push({
			field: "parent",
			message: "parent must be a spec or wayfinder",
		});
	}
	if (!scopeIsCompatibleWithParent(record.scope, parent.scope)) {
		issues.push({
			field: "scope",
			message: "child scope is not compatible with parent scope",
		});
	}
	return issues;
}

export function scopeIsCompatibleWithParent(
	child: RecordScope,
	parent: RecordScope,
): boolean {
	if (parent.type === "project") {
		return child.type === "project" && child.project === parent.project;
	}
	if (parent.type === "project-set") {
		if (child.type === "project-set") {
			return sameProjects(child.projects, parent.projects);
		}
		return child.type === "project" && parent.projects.includes(child.project);
	}
	if (parent.type === "initiative") {
		return (
			(child.type === "initiative" && child.initiative === parent.initiative) ||
			child.type === "project"
		);
	}
	return child.type === "global";
}

function collectObjectShapeIssues(
	value: unknown,
): Array<RecordValidationIssue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [{ field: "frontmatter", message: "frontmatter must be an object" }];
	}
	return Object.keys(value)
		.filter(
			(key) =>
				!frontmatterKeys.includes(key as (typeof frontmatterKeys)[number]),
		)
		.map((key) => ({
			field: key,
			message: `unknown frontmatter field '${key}'`,
		}));
}

function normalizeRecordFrontmatter(
	record: RecordFrontmatter,
): RecordFrontmatter {
	return {
		...record,
		scope:
			record.scope.type === "project-set"
				? { ...record.scope, projects: [...record.scope.projects].sort() }
				: record.scope,
		dependsOn: [...new Set(record.dependsOn)].sort(
			(left, right) => left - right,
		),
		tags: [...new Set(record.tags)].sort(),
	};
}

function sameProjects(
	left: ReadonlyArray<ProjectId>,
	right: ReadonlyArray<ProjectId>,
): boolean {
	return (
		left.length === right.length &&
		[...left]
			.sort()
			.every((project, index) => project === [...right].sort()[index])
	);
}

function deepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
