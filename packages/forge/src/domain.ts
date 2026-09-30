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

export type ForgeConfig = {
	readonly storePath: AbsolutePath;
};

export type StoreManifest = {
	readonly schemaVersion: 1;
	readonly nextRecordId: number;
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
