import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { expect, it } from "vitest";

import { parseAbsolutePath, parseProjectId } from "../../src/domain.ts";
import { isForgeError } from "../../src/errors.ts";
import { ensureStoreRoot } from "../../src/filesystem-store.ts";
import {
	addProject,
	addProjectEffect,
	addProjectRoot,
	findProjectForPath,
	listProjects,
	listProjectsEffect,
	readProjectEffect,
	removeProject,
	removeProjectRoot,
} from "../../src/project-registry.ts";
import { runForgePromise } from "../../src/runtime.ts";
import { storeRootPaths } from "../../src/store-paths.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");

function failureFromExit(exit: Exit.Exit<unknown, unknown>) {
	if (!Exit.isFailure(exit)) {
		throw new Error("Expected Effect to fail.");
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag !== "Some") {
		throw new Error("Expected typed Effect failure.");
	}
	return failure.value;
}

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

it("when removing a project, it should reject invalid by-project index shapes", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-projects-invalid-index-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	await addProject({
		storePath,
		id: parseProjectId("harness"),
		root: parseAbsolutePath("/home/a/projects/harness"),
		now: fixedDate,
	});
	await writeFile(
		storeRootPaths(storePath).byProjectIndex,
		'{"harness":["1"]}\n',
	);

	await expect(
		removeProject({ storePath, id: parseProjectId("harness") }),
	).rejects.toMatchObject({
		kind: "store-invalid",
		message:
			"Forge by-project index is invalid. Entry 'harness' must be an array of record ids.",
	});
});

it("when using the Effect API for projects, it should persist and list registry entries", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-projects-effect-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	const root = parseAbsolutePath("/home/a/projects/harness");

	await runForgePromise(
		addProjectEffect({
			storePath,
			id: parseProjectId("harness"),
			root,
			now: fixedDate,
		}),
	);

	const projects = await runForgePromise(listProjectsEffect(storePath));
	expect(projects).toMatchObject([{ id: "harness", roots: [root] }]);
});

it("when the Effect API reads a missing project, it should fail with a project-not-found ForgeError", async () => {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-projects-missing-effect-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });

	const exit = await runForgePromise(
		Effect.exit(readProjectEffect(storePath, parseProjectId("missing"))),
	);
	const error = failureFromExit(exit);

	expect(isForgeError(error)).toBe(true);
	if (isForgeError(error)) {
		expect(error.kind).toBe("project-not-found");
		expect(error.details).toEqual({ id: "missing" });
	}
});

it("when the Effect API lists projects from a missing store, it should fail with a store-invalid ForgeError", async () => {
	const storePath = parseAbsolutePath(
		path.join(
			await mkdtemp(path.join(os.tmpdir(), "forge-projects-invalid-effect-")),
			"missing-store",
		),
	);

	const exit = await runForgePromise(
		Effect.exit(listProjectsEffect(storePath)),
	);
	const error = failureFromExit(exit);

	expect(isForgeError(error)).toBe(true);
	if (isForgeError(error)) {
		expect(error.kind).toBe("store-invalid");
	}
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
