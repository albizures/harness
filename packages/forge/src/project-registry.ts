import { readdir } from "node:fs/promises";
import path from "node:path";

import {
	decodeProjectRegistryEntry,
	parseProjectId,
	type AbsolutePath,
	type ProjectId,
	type ProjectRegistryEntry,
} from "./domain.ts";
import { ForgeError } from "./errors.ts";
import {
	readJson,
	removeFileIfExists,
	writeJsonFile,
} from "./filesystem-store.ts";
import { projectFilePath, storeRootPaths } from "./store-paths.ts";

const jsonExtensionLength = ".json".length;

export type ProjectRegistry = {
	readonly projects: ReadonlyArray<ProjectRegistryEntry>;
};

export async function listProjects(
	storePath: AbsolutePath,
): Promise<ReadonlyArray<ProjectRegistryEntry>> {
	const projectsDirectory = storeRootPaths(storePath).projects;
	let files: Array<string>;
	try {
		files = await readdir(projectsDirectory);
	} catch (error) {
		throw new ForgeError({
			kind: "store-invalid",
			message: "Forge store projects directory is missing or unreadable.",
			cause: error,
			details: { projectsDirectory },
		});
	}
	const entries = await Promise.all(
		files
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) =>
				readProjectFile(
					storePath,
					parseProjectId(file.slice(0, -jsonExtensionLength)),
				),
			),
	);
	return entries.sort((left, right) => left.id.localeCompare(right.id));
}

export async function readProject(
	storePath: AbsolutePath,
	id: ProjectId,
): Promise<ProjectRegistryEntry> {
	try {
		return await readProjectFile(storePath, id);
	} catch (error) {
		if (isMissingFile(error)) {
			throw new ForgeError({
				kind: "project-not-found",
				message: `Project '${id}' is not registered.`,
				cause: error,
				details: { id },
			});
		}
		throw error;
	}
}

export async function addProject(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly name?: string;
	readonly remote?: string;
	readonly now?: Date;
}): Promise<ProjectRegistryEntry> {
	const filePath = projectFilePath(options.storePath, options.id);
	if (await fileExists(filePath)) {
		throw new ForgeError({
			kind: "project-exists",
			message: `Project '${options.id}' is already registered.`,
			details: { id: options.id },
		});
	}
	const now = iso(options.now ?? new Date());
	const project = decodeProjectRegistryEntry({
		id: options.id,
		name: options.name ?? titleizeProjectId(options.id),
		roots: [normalizeRoot(options.root)],
		remote: options.remote,
		createdAt: now,
		updatedAt: now,
	});
	await writeJsonFile(filePath, project);
	return project;
}

export async function addProjectRoot(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly now?: Date;
}): Promise<ProjectRegistryEntry> {
	const project = await readProject(options.storePath, options.id);
	const root = normalizeRoot(options.root);
	if (project.roots.includes(root)) {
		return project;
	}
	return writeProject(options.storePath, {
		...project,
		roots: [...project.roots, root].sort(),
		updatedAt: iso(options.now ?? new Date()),
	});
}

export async function removeProjectRoot(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
	readonly root: AbsolutePath;
	readonly now?: Date;
}): Promise<ProjectRegistryEntry> {
	const project = await readProject(options.storePath, options.id);
	const root = normalizeRoot(options.root);
	const roots = project.roots.filter((candidate) => candidate !== root);
	if (roots.length === project.roots.length) {
		return project;
	}
	if (roots.length === 0) {
		throw new ForgeError({
			kind: "project-invalid",
			message: "A project must keep at least one registered root.",
			details: { id: options.id, root },
		});
	}
	return writeProject(options.storePath, {
		...project,
		roots,
		updatedAt: iso(options.now ?? new Date()),
	});
}

export async function removeProject(options: {
	readonly storePath: AbsolutePath;
	readonly id: ProjectId;
}): Promise<void> {
	await readProject(options.storePath, options.id);
	const records = await readProjectRecordReferences(
		options.storePath,
		options.id,
	);
	if (records.length > 0) {
		throw new ForgeError({
			kind: "project-invalid",
			message:
				"Project has indexed records and cannot be removed. Edit roots instead.",
			details: { id: options.id, records },
		});
	}
	await removeFileIfExists(projectFilePath(options.storePath, options.id));
}

export async function inferProjectByPath(options: {
	readonly storePath: AbsolutePath;
	readonly cwd: AbsolutePath;
}): Promise<ProjectRegistryEntry | undefined> {
	return findProjectForPath(await listProjects(options.storePath), options.cwd);
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

async function readProjectFile(
	storePath: AbsolutePath,
	id: ProjectId,
): Promise<ProjectRegistryEntry> {
	return decodeProjectRegistryEntry(
		await readJson(projectFilePath(storePath, id)),
	);
}

async function readProjectRecordReferences(
	storePath: AbsolutePath,
	id: ProjectId,
): Promise<ReadonlyArray<unknown>> {
	const value = await readJson(storeRootPaths(storePath).byProjectIndex);
	if (typeof value !== "object" || value === null || !(id in value)) {
		return [];
	}
	const records = (value as Record<string, unknown>)[id];
	return Array.isArray(records) ? records : [];
}

async function writeProject(
	storePath: AbsolutePath,
	project: ProjectRegistryEntry,
): Promise<ProjectRegistryEntry> {
	const decoded = decodeProjectRegistryEntry(project);
	await writeJsonFile(projectFilePath(storePath, project.id), decoded);
	return decoded;
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

async function fileExists(filePath: AbsolutePath): Promise<boolean> {
	try {
		await readJson(filePath);
		return true;
	} catch (error) {
		if (isMissingFile(error)) {
			return false;
		}
		throw error;
	}
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function iso(date: Date): ProjectRegistryEntry["createdAt"] {
	return date.toISOString() as ProjectRegistryEntry["createdAt"];
}
