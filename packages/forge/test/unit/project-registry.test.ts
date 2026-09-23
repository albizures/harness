import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { parseAbsolutePath, parseProjectId } from "../../src/domain.ts";
import { ensureStoreRoot } from "../../src/filesystem-store.ts";
import {
	addProject,
	addProjectRoot,
	findProjectForPath,
	listProjects,
	removeProjectRoot,
} from "../../src/project-registry.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");

it("when adding projects and roots, it should persist registry entries", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-projects-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const harnessRoot = parseAbsolutePath("/home/a/projects/harness");
	const project = await addProject({
		storePath,
		id: parseProjectId("harness"),
		root: harnessRoot,
		remote: "git@github.com:albizures/harness.git",
		now: fixedDate,
	});
	expect(project.name).toBe("Harness");
	expect(project.roots).toEqual([harnessRoot]);

	await addProjectRoot({
		storePath,
		id: parseProjectId("harness"),
		root: parseAbsolutePath("/home/a/src/harness"),
		now: fixedDate,
	});
	expect((await listProjects(storePath))[0]?.roots.length).toBe(2);

	await removeProjectRoot({
		storePath,
		id: parseProjectId("harness"),
		root: parseAbsolutePath("/home/a/src/harness"),
		now: fixedDate,
	});
	expect((await listProjects(storePath))[0]?.roots).toEqual([harnessRoot]);
});

it("when inferring a project, it should use the longest matching root", () => {
	const cwd = parseAbsolutePath("/work/repo/packages/app/src");
	const project = findProjectForPath(
		[
			{
				id: parseProjectId("repo"),
				name: "Repo",
				roots: [parseAbsolutePath("/work/repo")],
				createdAt: fixedDate.toISOString() as never,
				updatedAt: fixedDate.toISOString() as never,
			},
			{
				id: parseProjectId("app"),
				name: "App",
				roots: [parseAbsolutePath("/work/repo/packages/app")],
				createdAt: fixedDate.toISOString() as never,
				updatedAt: fixedDate.toISOString() as never,
			},
		],
		cwd,
	);
	expect(project?.id).toBe("app");
});
