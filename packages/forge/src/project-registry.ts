import path from "node:path";

import { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";

import {
	decodeProjectRegistryEntry,
	parseProjectId,
	type AbsolutePath,
	type ProjectId,
	type ProjectRegistryEntry,
} from "./domain.ts";
import { ForgeError } from "./errors.ts";
import {
	readJsonEffect,
	removeFileIfExistsEffect,
	writeJsonFileEffect,
} from "./filesystem-store.ts";
import { runForgePromise } from "./runtime.ts";
import { projectFilePath, storeRootPaths } from "./store-paths.ts";

const jsonExtensionLength = ".json".length;

export type ProjectRegistry = {
	readonly projects: ReadonlyArray<ProjectRegistryEntry>;
};

export function listProjects(
	storePath: AbsolutePath,
): Promise<ReadonlyArray<ProjectRegistryEntry>> {
	return runForgePromise(listProjectsEffect(storePath));
}

export function listProjectsEffect(storePath: AbsolutePath) {
	return Effect.gen(function* () {
		const projectsDirectory = storeRootPaths(storePath).projects;
		const files = yield* readDirectoryEffect(projectsDirectory).pipe(
			Effect.mapError(
				(error) =>
					new ForgeError({
						kind: "store-invalid",
						message: "Forge store projects directory is missing or unreadable.",
						cause: error,
						details: { projectsDirectory },
					}),
			),
		);
		const entries = yield* Effect.all(
			files
				.filter((file) => file.endsWith(".json"))
				.sort()
				.map((file) =>
					readProjectFileEffect(
						storePath,
						parseProjectId(file.slice(0, -jsonExtensionLength)),
					),
				),
			{ concurrency: "unbounded" },
		);
		return entries.sort((left, right) => left.id.localeCompare(right.id));
	});
}

export function readProject(
	storePath: AbsolutePath,
	id: ProjectId,
): Promise<ProjectRegistryEntry> {
	return runForgePromise(readProjectEffect(storePath, id));
}

export function readProjectEffect(storePath: AbsolutePath, id: ProjectId) {
	return readProjectFileEffect(storePath, id).pipe(
		Effect.mapError((error) => {
			if (isMissingFile(error)) {
				return new ForgeError({
					kind: "project-not-found",
					message: `Project '${id}' is not registered.`,
					cause: error,
					details: { id },
				});
			}
			return error;
		}),
	);
}

export function addProject(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly name?: string;
	readonly remote?: string;
	readonly now?: Date;
}): Promise<ProjectRegistryEntry> {
	return runForgePromise(addProjectEffect(options));
}

export function addProjectEffect(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly name?: string;
	readonly remote?: string;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const filePath = projectFilePath(options.storePath, options.id);
		if (yield* fileExistsEffect(filePath)) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "project-exists",
					message: `Project '${options.id}' is already registered.`,
					details: { id: options.id },
				}),
			);
		}
		const now = iso(options.now ?? new Date());
		const project = yield* decodeProjectRegistryEntryEffect({
			id: options.id,
			name: options.name ?? titleizeProjectId(options.id),
			roots: [normalizeRoot(options.root)],
			remote: options.remote,
			createdAt: now,
			updatedAt: now,
		});
		yield* writeJsonFileEffect(filePath, project);
		return project;
	});
}

export function addProjectRoot(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly now?: Date;
}): Promise<ProjectRegistryEntry> {
	return runForgePromise(addProjectRootEffect(options));
}

export function addProjectRootEffect(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const project = yield* readProjectEffect(options.storePath, options.id);
		const root = normalizeRoot(options.root);
		if (project.roots.includes(root)) {
			return project;
		}
		return yield* writeProjectEffect(options.storePath, {
			...project,
			roots: [...project.roots, root].sort(),
			updatedAt: iso(options.now ?? new Date()),
		});
	});
}

export function removeProjectRoot(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly now?: Date;
}): Promise<ProjectRegistryEntry> {
	return runForgePromise(removeProjectRootEffect(options));
}

export function removeProjectRootEffect(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly now?: Date;
}) {
	return Effect.gen(function* () {
		const project = yield* readProjectEffect(options.storePath, options.id);
		const root = normalizeRoot(options.root);
		const roots = project.roots.filter((candidate) => candidate !== root);
		if (roots.length === project.roots.length) {
			return project;
		}
		if (roots.length === 0) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "project-invalid",
					message: "A project must keep at least one registered root.",
					details: { id: options.id, root },
				}),
			);
		}
		return yield* writeProjectEffect(options.storePath, {
			...project,
			roots,
			updatedAt: iso(options.now ?? new Date()),
		});
	});
}

export function removeProject(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
}): Promise<void> {
	return runForgePromise(removeProjectEffect(options));
}

export function removeProjectEffect(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
}) {
	return Effect.gen(function* () {
		yield* readProjectEffect(options.storePath, options.id);
		const records = yield* readProjectRecordReferencesEffect(
			options.storePath,
			options.id,
		);
		if (records.length > 0) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "project-invalid",
					message:
						"Project has indexed records and cannot be removed. Edit roots instead.",
					details: { id: options.id, records },
				}),
			);
		}
		yield* removeFileIfExistsEffect(
			projectFilePath(options.storePath, options.id),
		);
	});
}

export function inferProjectByPath(options: {
	readonly storePath: AbsolutePath;
	readonly cwd: AbsolutePath;
}): Promise<ProjectRegistryEntry | undefined> {
	return runForgePromise(inferProjectByPathEffect(options));
}

export function inferProjectByPathEffect(options: {
	readonly storePath: AbsolutePath;
	readonly cwd: AbsolutePath;
}) {
	return Effect.gen(function* () {
		return findProjectForPath(
			yield* listProjectsEffect(options.storePath),
			options.cwd,
		);
	});
}

export function findProjectForPath(
	projects: ReadonlyArray<ProjectRegistryEntry>,
	cwd: AbsolutePath,
): ProjectRegistryEntry | undefined {
	let match: { project: ProjectRegistryEntry; rootLength: number } | undefined;
	for (const project of projects) {
		for (const root of project.roots) {
			if (!pathIsInside(cwd, root)) {
				continue;
			}
			if (match === undefined || root.length > match.rootLength) {
				match = { project, rootLength: root.length };
			}
		}
	}
	return match?.project;
}

function readProjectFileEffect(storePath: AbsolutePath, id: ProjectId) {
	return Effect.gen(function* () {
		const value = yield* readJsonEffect(projectFilePath(storePath, id));
		return yield* decodeProjectRegistryEntryEffect(value);
	});
}

function readProjectRecordReferencesEffect(
	storePath: AbsolutePath,
	id: ProjectId,
) {
	return Effect.gen(function* () {
		const value = yield* readJsonEffect(
			storeRootPaths(storePath).byProjectIndex,
		);
		if (typeof value !== "object" || value === null || !(id in value)) {
			return [];
		}
		const records = (value as Record<string, unknown>)[id];
		return Array.isArray(records) ? records : [];
	});
}

function writeProjectEffect(
	storePath: AbsolutePath,
	project: ProjectRegistryEntry,
) {
	return Effect.gen(function* () {
		const decoded = yield* decodeProjectRegistryEntryEffect(project);
		yield* writeJsonFileEffect(projectFilePath(storePath, project.id), decoded);
		return decoded;
	});
}

function decodeProjectRegistryEntryEffect(value: unknown) {
	return Effect.try({
		try: () => decodeProjectRegistryEntry(value),
		catch: (error) => error,
	});
}

function readDirectoryEffect(directoryPath: AbsolutePath) {
	return Effect.gen(function* () {
		const fileSystem = yield* FileSystem;
		return yield* fileSystem.readDirectory(directoryPath);
	});
}

function normalizeRoot(root: AbsolutePath): AbsolutePath {
	const normalized = path.resolve(root);
	return (
		normalized === "/" ? normalized : normalized.replace(/\/$/, "")
	) as AbsolutePath;
}

function pathIsInside(candidate: AbsolutePath, root: AbsolutePath): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function titleizeProjectId(id: ProjectId): string {
	return id
		.split("-")
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function fileExistsEffect(filePath: AbsolutePath) {
	return readJsonEffect(filePath).pipe(
		Effect.as(true),
		Effect.catchAll((error) => {
			if (isMissingFile(error)) {
				return Effect.succeed(false);
			}
			return Effect.fail(error);
		}),
	);
}

function isMissingFile(error: unknown): boolean {
	return (
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT") ||
		(typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "SystemError" &&
			"reason" in error &&
			error.reason === "NotFound")
	);
}

function iso(date: Date): ProjectRegistryEntry["createdAt"] {
	return date.toISOString() as ProjectRegistryEntry["createdAt"];
}
