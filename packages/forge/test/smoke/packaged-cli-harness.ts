import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { parseDocument } from "yaml";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const packagedCli = path.join(packageRoot, "dist", "cli.js");

export type ForgeSmokeWorkspace = {
	readonly home: string;
	readonly store: string;
	readonly projectRoot: string;
	readonly nestedCwd: string;
};

export type PackagedCliResult = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
};

export type PersistedRecord = {
	readonly frontmatter: Record<string, unknown>;
	readonly body: string;
};

export async function createForgeSmokeWorkspace(): Promise<ForgeSmokeWorkspace> {
	const root = await mkdtemp(path.join(os.tmpdir(), "forge-packaged-cli-"));
	const home = path.join(root, "home");
	const store = path.join(root, "store");
	const projectRoot = path.join(root, "repo");
	const nestedCwd = path.join(projectRoot, "packages", "app");
	await mkdir(home, { recursive: true });
	await mkdir(nestedCwd, { recursive: true });
	return { home, store, projectRoot, nestedCwd };
}

export async function runPackagedForge(
	workspace: ForgeSmokeWorkspace,
	args: ReadonlyArray<string>,
	options: { readonly cwd?: string; readonly input?: string } = {},
): Promise<PackagedCliResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[packagedCli, "--store", workspace.store, ...args],
			{
				cwd: options.cwd ?? workspace.projectRoot,
				env: {
					...process.env,
					HOME: workspace.home,
					FORGE_HOME: workspace.home,
					XDG_CONFIG_HOME: path.join(workspace.home, ".config"),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({ code, signal, stdout, stderr });
		});
		child.stdin.end(options.input ?? "");
	});
}

export function expectPackagedForgeExit(
	result: PackagedCliResult,
	code: number,
): void {
	expect(result, result.stderr).toMatchObject({ code, signal: null });
}

export async function readStoreJson<T>(
	workspace: ForgeSmokeWorkspace,
	relativePath: string,
): Promise<T> {
	const text = await readFile(path.join(workspace.store, relativePath), "utf8");
	return JSON.parse(text) as T;
}

export async function readPersistedRecord(
	workspace: ForgeSmokeWorkspace,
	relativePath: string,
): Promise<PersistedRecord> {
	const text = await readFile(path.join(workspace.store, relativePath), "utf8");
	const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
	expect(match).not.toBeNull();
	const [, frontmatter = "", body = ""] = match ?? [];
	const document = parseDocument(frontmatter);
	return {
		frontmatter: document.toJSON() as Record<string, unknown>,
		body,
	};
}
