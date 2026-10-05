import { Schema as S } from "effect";

import { ForgeError } from "./errors.ts";

export const projectIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const resolutionSlugPattern = projectIdPattern;

export type Brand<K extends string> = string & { readonly __brand: K };
export type ProjectId = Brand<"ProjectId">;
export type AbsolutePath = Brand<"AbsolutePath">;
export type IsoDateTime = Brand<"IsoDateTime">;

export function isProjectId(value: string): value is ProjectId {
	return projectIdPattern.test(value);
}

export function parseProjectId(value: string): ProjectId {
	if (isProjectId(value)) {
		return value;
	}
	throw new ForgeError({
		kind: "project-id-invalid",
		message:
			"Project id must be lowercase kebab-case and match [a-z0-9][a-z0-9-]*[a-z0-9].",
		details: { value },
	});
}

export function isAbsolutePath(value: string): value is AbsolutePath {
	return value.startsWith("/");
}

export function parseAbsolutePath(value: string, field = "path"): AbsolutePath {
	if (isAbsolutePath(value)) {
		return value;
	}
	throw new ForgeError({
		kind: "config-invalid",
		message: `${field} must be an absolute path.`,
		details: { field, value },
	});
}

export function isIsoDateTime(value: string): value is IsoDateTime {
	return !Number.isNaN(Date.parse(value));
}

export function isWorktreeId(value: string): value is WorktreeId {
	return /^wt_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
}

export function parseWorktreeId(value: string): WorktreeId {
	if (isWorktreeId(value)) {
		return value;
	}
	throw new ForgeError({
		kind: "record-invalid",
		message: "Worktree id must be opaque and match wt_[a-z0-9_]+.",
		details: { value },
	});
}

export type ForgeConfig = {
	readonly storePath: AbsolutePath;
};

export type StoreManifest = {
	readonly schemaVersion: 1;
	readonly nextRecordId: number;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
};

export type WorktreeId = Brand<"WorktreeId">;
export type WorktreeStatus = "active" | "removed" | "missing" | "invalid";

export type WorktreeCopyManifestEntry = {
	readonly path: string;
	readonly optional: boolean;
};

export type WorktreeCopyManifestSnapshot = {
	readonly manifestPath: AbsolutePath;
	readonly entries: ReadonlyArray<WorktreeCopyManifestEntry>;
};

export type WorktreeDiagnostic = {
	readonly code: string;
	readonly message: string;
	readonly details?: Readonly<Record<string, unknown>>;
};

export type WorktreeRecord = {
	readonly id: WorktreeId;
	readonly taskId: number;
	readonly projectId: ProjectId;
	readonly repositoryRoot: AbsolutePath;
	readonly worktreePath: AbsolutePath;
	readonly branch: string;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly status: WorktreeStatus;
	readonly copyManifests: ReadonlyArray<WorktreeCopyManifestSnapshot>;
	readonly copiedPaths: ReadonlyArray<string>;
	readonly diagnostics: ReadonlyArray<WorktreeDiagnostic>;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
};

export type ProjectRegistryEntry = {
	readonly id: ProjectId;
	readonly name: string;
	readonly roots: ReadonlyArray<AbsolutePath>;
	readonly remote?: string;
	readonly aliases?: ReadonlyArray<string>;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
};

const projectIdSchema = S.String.pipe(
	S.filter((value) => projectIdPattern.test(value), {
		message: () =>
			"must be lowercase kebab-case matching [a-z0-9][a-z0-9-]*[a-z0-9]",
	}),
);

const absolutePathSchema = S.String.pipe(
	S.filter((value) => value.startsWith("/"), {
		message: () => "must be an absolute path",
	}),
);

const isoDateTimeSchema = S.String.pipe(
	S.filter((value) => !Number.isNaN(Date.parse(value)), {
		message: () => "must be an ISO-compatible date-time string",
	}),
);

const worktreeIdSchema = S.String.pipe(
	S.filter((value) => isWorktreeId(value), {
		message: () => "must match wt_[a-z0-9_]+",
	}),
);

export const forgeConfigSchema: S.Schema<ForgeConfig> = S.Struct({
	storePath: absolutePathSchema,
}) as unknown as S.Schema<ForgeConfig>;

export const storeManifestSchema: S.Schema<StoreManifest> = S.Struct({
	schemaVersion: S.Literal(1),
	nextRecordId: S.Number.pipe(S.int(), S.greaterThan(0)),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
}) as unknown as S.Schema<StoreManifest>;

export const projectRegistryEntrySchema: S.Schema<ProjectRegistryEntry> =
	S.Struct({
		id: projectIdSchema,
		name: S.NonEmptyString,
		roots: S.Array(absolutePathSchema).pipe(S.minItems(1)),
		remote: S.optional(S.NonEmptyString),
		aliases: S.optional(S.Array(S.NonEmptyString)),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
	}) as unknown as S.Schema<ProjectRegistryEntry>;

export const worktreeRecordSchema: S.Schema<WorktreeRecord> = S.Struct({
	id: worktreeIdSchema,
	taskId: S.Number.pipe(S.int(), S.greaterThan(0)),
	projectId: projectIdSchema,
	repositoryRoot: absolutePathSchema,
	worktreePath: absolutePathSchema,
	branch: S.NonEmptyString,
	baseRef: S.NonEmptyString,
	baseSha: S.NonEmptyString,
	status: S.Literal("active", "removed", "missing", "invalid"),
	copyManifests: S.Array(
		S.Struct({
			manifestPath: absolutePathSchema,
			entries: S.Array(
				S.Struct({ path: S.NonEmptyString, optional: S.Boolean }),
			),
		}),
	),
	copiedPaths: S.Array(S.NonEmptyString),
	diagnostics: S.Array(
		S.Struct({
			code: S.NonEmptyString,
			message: S.NonEmptyString,
			details: S.optional(S.Record({ key: S.String, value: S.Unknown })),
		}),
	),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
}) as unknown as S.Schema<WorktreeRecord>;

export function decodeWithSchema<A>(
	schema: S.Schema<A>,
	value: unknown,
	errorKind: ForgeError["kind"],
	message: string,
): A {
	const result = S.decodeUnknownEither(schema)(value);
	if (result._tag === "Right") {
		return result.right;
	}
	throw new ForgeError({
		kind: errorKind,
		message,
		cause: result.left,
	});
}

export function decodeForgeConfig(value: unknown): ForgeConfig {
	return decodeWithSchema(
		forgeConfigSchema,
		value,
		"config-invalid",
		"Forge config is invalid. Set an absolute storePath.",
	);
}

export function decodeStoreManifest(value: unknown): StoreManifest {
	return decodeWithSchema(
		storeManifestSchema,
		value,
		"store-invalid",
		"Forge store manifest is invalid.",
	);
}

export function decodeProjectRegistryEntry(
	value: unknown,
): ProjectRegistryEntry {
	return decodeWithSchema(
		projectRegistryEntrySchema,
		value,
		"project-invalid",
		"Forge project registry entry is invalid.",
	);
}

export function decodeWorktreeRecord(value: unknown): WorktreeRecord {
	return decodeWithSchema(
		worktreeRecordSchema,
		value,
		"store-invalid",
		"Forge worktree record is invalid.",
	);
}
