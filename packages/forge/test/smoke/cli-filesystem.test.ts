import { readdir } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

import {
	createForgeSmokeWorkspace,
	expectPackagedForgeExit,
	readPersistedRecord,
	readStoreJson,
	runPackagedForge,
} from "./packaged-cli-harness.ts";

const SLOW_PACKAGED_CLI_TEST_TIMEOUT_MS = 15_000;

it("when the packaged CLI registers a project and creates a spec, it should persist the expected filesystem artifacts", async () => {
	const workspace = await createForgeSmokeWorkspace();

	let result = await runPackagedForge(workspace, [
		"project",
		"add",
		"harness",
		"--root",
		workspace.projectRoot,
		"--name",
		"Harness",
	]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("harness");

	const initialManifest = await readStoreJson<{
		schemaVersion: number;
		nextRecordId: number;
	}>(workspace, "manifest.json");
	expect(initialManifest).toMatchObject({ schemaVersion: 1, nextRecordId: 1 });

	const project = await readStoreJson<{ name: string; roots: Array<string> }>(
		workspace,
		"projects/harness.json",
	);
	expect(project).toMatchObject({
		name: "Harness",
		roots: [workspace.projectRoot],
	});

	result = await runPackagedForge(
		workspace,
		["new", "spec", "--title", "Smoke spec", "--body", "-", "--json"],
		{ cwd: workspace.nestedCwd, input: "Spec body\n" },
	);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	const created = JSON.parse(result.stdout) as { id: number; title: string };
	expect(created).toMatchObject({ id: 1, title: "Smoke spec" });

	const record = await readPersistedRecord(
		workspace,
		"records/spec/000/000001.md",
	);
	expect(record.frontmatter).toMatchObject({
		id: 1,
		title: "Smoke spec",
		kind: "spec",
		state: "ready",
		resolution: null,
		scope: { type: "project", project: "harness" },
		parent: null,
		initiative: null,
		dependsOn: [],
		generatedBy: null,
		tags: [],
		profile: null,
	});
	expect(record.body).toBe("Spec body\n");

	const byId = await readStoreJson<
		Record<string, { kind: string; path: string }>
	>(workspace, "indexes/by-id.json");
	expect(byId).toEqual({
		"1": { kind: "spec", path: "records/spec/000/000001.md" },
	});

	const byProject = await readStoreJson<Record<string, Array<number>>>(
		workspace,
		"indexes/by-project.json",
	);
	expect(byProject).toEqual({ harness: [1] });

	const manifest = await readStoreJson<{ nextRecordId: number }>(
		workspace,
		"manifest.json",
	);
	expect(manifest.nextRecordId).toBe(2);
});

it("when the packaged CLI creates a review task, it should persist task and relationship filesystem artifacts", async () => {
	const workspace = await createForgeSmokeWorkspace();

	let result = await runPackagedForge(workspace, [
		"project",
		"add",
		"harness",
		"--root",
		workspace.projectRoot,
		"--name",
		"Harness",
	]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");

	result = await runPackagedForge(
		workspace,
		["new", "spec", "--title", "Smoke spec", "--body", "-", "--json"],
		{ cwd: workspace.nestedCwd, input: "Spec body\n" },
	);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toMatchObject({ id: 1 });

	result = await runPackagedForge(
		workspace,
		[
			"new",
			"task",
			"--title",
			"Smoke task",
			"--description",
			"-",
			"--parent",
			"1",
			"--kind",
			"review",
			"--json",
		],
		{ input: "Task description\n" },
	);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toMatchObject({
		id: 2,
		title: "Smoke task",
	});

	const record = await readPersistedRecord(
		workspace,
		"records/task/000/000002.md",
	);
	expect(record.frontmatter).toMatchObject({
		id: 2,
		title: "Smoke task",
		kind: "task",
		subkind: "review",
		state: "ready",
		parent: 1,
	});
	expect(record.body).toBe("Task description\n");

	const relationships = await readStoreJson<
		Record<string, { children: Array<number>; parent: number | null }>
	>(workspace, "indexes/relationships.json");
	expect(relationships["1"]?.children).toEqual([2]);
	expect(relationships["2"]?.parent).toBe(1);
});

it("when the packaged CLI exposes summary help and output, it should summarize record facts", async () => {
	const workspace = await createForgeSmokeWorkspace();

	let result = await runPackagedForge(workspace, ["--help"]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("summary [--json] <record>");
	expect(result.stdout).toMatch(
		/Summarize a Forge record and its\s+direct children\./,
	);

	result = await runPackagedForge(workspace, [
		"project",
		"add",
		"harness",
		"--root",
		workspace.projectRoot,
		"--name",
		"Harness",
	]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");

	result = await runPackagedForge(
		workspace,
		["new", "spec", "--title", "Summary spec", "--body", "-", "--json"],
		{ cwd: workspace.nestedCwd, input: "Spec body\n" },
	);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toMatchObject({ id: 1 });

	result = await runPackagedForge(
		workspace,
		[
			"new",
			"task",
			"--title",
			"Summary task",
			"--description",
			"-",
			"--parent",
			"1",
			"--json",
		],
		{ input: "Task description\n" },
	);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toMatchObject({ id: 2 });

	result = await runPackagedForge(workspace, [
		"comment",
		"2",
		"--message",
		"Summary smoke comment",
	]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");

	result = await runPackagedForge(workspace, ["summary", "1"]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	expect(result.stdout).toContain("1\tspec\tready\tSummary spec");
	expect(result.stdout).toContain("children\n2\ttask\tready\tSummary task");
	expect(result.stdout).toContain("  latestComment\t1\tSummary smoke comment");

	result = await runPackagedForge(workspace, ["summary", "1", "--json"]);
	expectPackagedForgeExit(result, 0);
	expect(result.stderr).toBe("");
	const summary = JSON.parse(result.stdout) as {
		record: { readonly id: number; readonly title: string };
		children: Array<{
			readonly record: { readonly id: number; readonly title: string };
			readonly latestComment: { readonly body: string } | null;
		}>;
	};
	expect(summary.record).toMatchObject({ id: 1, title: "Summary spec" });
	expect(summary.children).toEqual([
		expect.objectContaining({
			record: expect.objectContaining({ id: 2, title: "Summary task" }),
			latestComment: expect.objectContaining({
				body: "Summary smoke comment\n",
			}),
		}),
	]);
});

it(
	"when the packaged CLI mutates lifecycle and comments, it should persist filesystem history artifacts",
	async () => {
		const workspace = await createForgeSmokeWorkspace();

		let result = await runPackagedForge(workspace, [
			"project",
			"add",
			"harness",
			"--root",
			workspace.projectRoot,
			"--name",
			"Harness",
		]);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");

		result = await runPackagedForge(
			workspace,
			["new", "spec", "--title", "Lifecycle spec", "--body", "-", "--json"],
			{ cwd: workspace.nestedCwd, input: "Spec body\n" },
		);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({ id: 1 });

		result = await runPackagedForge(
			workspace,
			[
				"new",
				"task",
				"--title",
				"Lifecycle task",
				"--description",
				"-",
				"--parent",
				"1",
				"--json",
			],
			{ input: "Task description\n" },
		);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({ id: 2 });

		result = await runPackagedForge(workspace, ["start", "2"]);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");

		result = await runPackagedForge(workspace, [
			"done",
			"2",
			"--resolution",
			"completed",
		]);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");

		const taskRecord = await readPersistedRecord(
			workspace,
			"records/task/000/000002.md",
		);
		expect(taskRecord.frontmatter).toMatchObject({
			id: 2,
			state: "done",
			resolution: "completed",
		});

		expect(
			(await readdir(path.join(workspace.store, "updates/000/000002"))).sort(),
		).toEqual(["0001-create.json", "0002-start.json", "0003-done.json"]);

		result = await runPackagedForge(workspace, [
			"comment",
			"1",
			"--message",
			"Manual smoke comment",
		]);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");

		await expect(
			readdir(path.join(workspace.store, "comments/000/000001")),
		).resolves.toEqual(["0001.md"]);

		result = await runPackagedForge(workspace, ["comments", "1", "--json"]);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");
		const comments = JSON.parse(result.stdout) as Array<{ body: string }>;
		expect(comments).toMatchObject([{ body: "Manual smoke comment\n" }]);

		result = await runPackagedForge(workspace, ["history", "1", "--json"]);
		expectPackagedForgeExit(result, 0);
		expect(result.stderr).toBe("");
		const history = JSON.parse(result.stdout) as Array<{
			kind: string;
			comment?: { body: string };
			update?: { type: string };
		}>;
		expect(history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "update",
					update: expect.objectContaining({ type: "create" }),
				}),
				expect.objectContaining({
					kind: "comment",
					comment: expect.objectContaining({ body: "Manual smoke comment\n" }),
				}),
			]),
		);
	},
	SLOW_PACKAGED_CLI_TEST_TIMEOUT_MS,
);
