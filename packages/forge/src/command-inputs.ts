import { Schema as S } from "effect";

import type { AbsolutePath, ProjectId } from "./domain.ts";
import { decodeWithSchema } from "./domain.ts";

export type ConfigKey = "storePath";

export type ConfigSetInput = {
	readonly key: ConfigKey;
	readonly value: AbsolutePath;
};

export type ProjectAddInput = {
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly name?: string;
	readonly remote?: string;
	readonly worktreeCopyManifest?: AbsolutePath;
};

export type ProjectRootInput = {
	readonly id: ProjectId;
	readonly root: AbsolutePath;
};

const projectIdSchema = S.String.pipe(
	S.filter((value) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value), {
		message: () => "must be a valid project id",
	}),
);

const absolutePathSchema = S.String.pipe(
	S.filter((value) => value.startsWith("/"), {
		message: () => "must be an absolute path",
	}),
);

export const configKeySchema: S.Schema<ConfigKey> = S.Literal("storePath");

export const configSetInputSchema: S.Schema<ConfigSetInput> = S.Struct({
	key: configKeySchema,
	value: absolutePathSchema,
}) as unknown as S.Schema<ConfigSetInput>;

export const projectAddInputSchema: S.Schema<ProjectAddInput> = S.Struct({
	id: projectIdSchema,
	root: absolutePathSchema,
	name: S.optional(S.NonEmptyString),
	remote: S.optional(S.NonEmptyString),
	worktreeCopyManifest: S.optional(absolutePathSchema),
}) as unknown as S.Schema<ProjectAddInput>;

export const projectRootInputSchema: S.Schema<ProjectRootInput> = S.Struct({
	id: projectIdSchema,
	root: absolutePathSchema,
}) as unknown as S.Schema<ProjectRootInput>;

export function decodeConfigSetInput(value: unknown): ConfigSetInput {
	return decodeWithSchema(
		configSetInputSchema,
		value,
		"config-invalid",
		"Forge config set input is invalid.",
	);
}

export function decodeProjectAddInput(value: unknown): ProjectAddInput {
	return decodeWithSchema(
		projectAddInputSchema,
		value,
		"project-invalid",
		"Forge project add input is invalid.",
	);
}

export function decodeProjectRootInput(value: unknown): ProjectRootInput {
	return decodeWithSchema(
		projectRootInputSchema,
		value,
		"project-invalid",
		"Forge project root input is invalid.",
	);
}
