// biome-ignore-all lint/style/noMagicNumbers: Test literals define indexing caps and fixture shape.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
	buildFileMentionIndex,
	createFileMentionIndexProvider,
	type CommandRunner,
} from "../../../extensions/indexer.ts";

test("when fd is available, the File Mention Index uses fd output and stores normalized metadata", async () => {
	const calls: Array<{ command: string; args: Array<string> }> = [];
	const run: CommandRunner = async (command, args) => {
		calls.push({ command, args });
		if (args.includes("directory")) {
			return { stdout: "src\\components\ndocs/guide/\n" };
		}
		return { stdout: "src\\components\\Button.tsx\ndocs/guide/intro.md\n" };
	};

	const index = await buildFileMentionIndex({ cwd: "/repo", run });

	expect(calls.map((call) => call.command)).toEqual(["fd", "fd"]);
	expect(calls[0]?.args).toContain("--max-results");
	expect(calls[1]?.args).toContain("--max-results");
	expect(index?.entries).toEqual([
		{ kind: "directory", path: "docs/guide", depth: 2, basename: "guide" },
		{
			kind: "file",
			path: "docs/guide/intro.md",
			depth: 3,
			basename: "intro.md",
		},
		{
			kind: "directory",
			path: "src/components",
			depth: 2,
			basename: "components",
		},
		{
			kind: "file",
			path: "src/components/Button.tsx",
			depth: 3,
			basename: "Button.tsx",
		},
	]);
});

test("when fd fails, the File Mention Index falls back to git ls-files and infers directories", async () => {
	const calls: Array<string> = [];
	const run: CommandRunner = async (command) => {
		calls.push(command);
		if (command === "fd") {
			throw new Error("fd missing");
		}
		return { stdout: "src/app.ts\nsrc/lib/index.ts\nREADME.md\n" };
	};

	const index = await buildFileMentionIndex({ cwd: "/repo", run });

	expect(calls).toEqual(["fd", "git"]);
	expect(index?.entries.map((entry) => [entry.kind, entry.path])).toEqual([
		["file", "README.md"],
		["directory", "src"],
		["file", "src/app.ts"],
		["directory", "src/lib"],
		["file", "src/lib/index.ts"],
	]);
});

test("when command backends fail, the Node fallback skips heavy directories and caps entries", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "file-mentions-"));
	await mkdir(path.join(root, "src", "lib"), { recursive: true });
	await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
	await mkdir(path.join(root, "coverage"), { recursive: true });
	await writeFile(path.join(root, "src", "lib", "a.ts"), "");
	await writeFile(path.join(root, "src", "b.ts"), "");
	await writeFile(path.join(root, "node_modules", "pkg", "ignored.ts"), "");
	await writeFile(path.join(root, "coverage", "ignored.txt"), "");

	const run: CommandRunner = async () => {
		throw new Error("no command backend");
	};

	const index = await buildFileMentionIndex({ cwd: root, run, maxEntries: 3 });

	expect(index?.entries.map((entry) => [entry.kind, entry.path])).toEqual([
		["directory", "src"],
		["file", "src/b.ts"],
		["directory", "src/lib"],
	]);
});

test("when a session asks repeatedly, the lazy provider builds once and reuses the File Mention Index", async () => {
	let buildCount = 0;
	const provider = createFileMentionIndexProvider({
		cwd: "/repo",
		build: async (cwd) => {
			buildCount += 1;
			return { projectRoot: cwd, entries: [] };
		},
	});

	expect(provider.getCachedIndex()).toBe(null);
	const first = await provider.getIndex();
	const second = await provider.getIndex();

	expect(provider.getCachedIndex()).toBe(first);
	expect(first).toBe(second);
	expect(buildCount).toBe(1);
});

test("when indexing fails unexpectedly, the lazy provider returns null without throwing", async () => {
	const provider = createFileMentionIndexProvider({
		cwd: "/repo",
		build: async () => {
			throw new Error("boom");
		},
	});

	expect(await provider.getIndex()).toBe(null);
});
