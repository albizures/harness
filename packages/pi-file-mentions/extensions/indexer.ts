import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FileMentionIndex, FileMentionIndexEntry } from "./matcher.ts";

const DEFAULT_MAX_ENTRIES = 10_000;
const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 10_485_760;
const COMMAND_TIMEOUT_MS = 2_000;
const SKIPPED_NODE_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
]);

export type CommandRunner = (
	command: string,
	args: Array<string>,
	options: { cwd: string },
) => Promise<{ stdout: string }>;

export type BuildFileMentionIndexOptions = {
	cwd?: string;
	run?: CommandRunner;
	maxEntries?: number;
};

export type FileMentionIndexProvider = {
	getIndex: () => Promise<FileMentionIndex | null>;
	getCachedIndex: () => FileMentionIndex | null;
	refresh: () => Promise<FileMentionIndex | null>;
	clear: () => void;
};

export type FileMentionIndexProviderOptions = {
	cwd?: string;
	build?: (cwd: string) => Promise<FileMentionIndex | null>;
};

const execFileAsync = promisify(execFile);

export async function buildFileMentionIndex(
	options: BuildFileMentionIndexOptions = {},
): Promise<FileMentionIndex | null> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const run = options.run ?? runCommand;

	try {
		return normalizeIndex(
			cwd,
			await collectWithFd(cwd, run, maxEntries),
			maxEntries,
		);
	} catch {
		// Fall through to the next backend so autocomplete can stay quiet.
	}

	try {
		return normalizeIndex(cwd, await collectWithGit(cwd, run), maxEntries);
	} catch {
		// Fall through to the bounded Node walk so autocomplete can stay quiet.
	}

	try {
		return normalizeIndex(
			cwd,
			await collectWithNode(cwd, maxEntries),
			maxEntries,
		);
	} catch {
		return null;
	}
}

export function createFileMentionIndexProvider(
	options: FileMentionIndexProviderOptions = {},
): FileMentionIndexProvider {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const build =
		options.build ?? ((root) => buildFileMentionIndex({ cwd: root }));
	let cached: Promise<FileMentionIndex | null> | null = null;
	let readyIndex: FileMentionIndex | null = null;

	async function load(): Promise<FileMentionIndex | null> {
		try {
			readyIndex = await build(cwd);
			return readyIndex;
		} catch {
			readyIndex = null;
			return null;
		}
	}

	return {
		getIndex: () => {
			cached ??= load();
			return cached;
		},
		getCachedIndex: () => readyIndex,
		refresh: () => {
			cached = load();
			return cached;
		},
		clear: () => {
			cached = null;
			readyIndex = null;
		},
	};
}

async function runCommand(
	command: string,
	args: Array<string>,
	options: { cwd: string },
): Promise<{ stdout: string }> {
	const { stdout } = await execFileAsync(command, args, {
		cwd: options.cwd,
		killSignal: "SIGKILL",
		maxBuffer: COMMAND_OUTPUT_MAX_BUFFER_BYTES,
		timeout: COMMAND_TIMEOUT_MS,
	});
	return { stdout: stdout.toString() };
}

async function collectWithFd(
	cwd: string,
	run: CommandRunner,
	maxEntries: number,
): Promise<Array<Pick<FileMentionIndexEntry, "kind" | "path">>> {
	const maxResults = String(maxEntries);
	const directoryOutput = await run(
		"fd",
		[
			"--type",
			"directory",
			"--strip-cwd-prefix",
			"--max-results",
			maxResults,
			".",
		],
		{ cwd },
	);
	const fileOutput = await run(
		"fd",
		["--type", "file", "--strip-cwd-prefix", "--max-results", maxResults, "."],
		{
			cwd,
		},
	);
	return [
		...parseLines(directoryOutput.stdout).map((entryPath) => ({
			kind: "directory" as const,
			path: entryPath,
		})),
		...parseLines(fileOutput.stdout).map((entryPath) => ({
			kind: "file" as const,
			path: entryPath,
		})),
	];
}

async function collectWithGit(
	cwd: string,
	run: CommandRunner,
): Promise<Array<Pick<FileMentionIndexEntry, "kind" | "path">>> {
	const output = await run("git", ["ls-files", "-co", "--exclude-standard"], {
		cwd,
	});
	const entries = new Map<
		string,
		Pick<FileMentionIndexEntry, "kind" | "path">
	>();
	for (const filePath of parseLines(output.stdout)) {
		entries.set(filePath, { kind: "file", path: filePath });
		for (const directoryPath of ancestorDirectories(filePath)) {
			entries.set(directoryPath, { kind: "directory", path: directoryPath });
		}
	}
	return Array.from(entries.values());
}

async function collectWithNode(
	cwd: string,
	maxEntries: number,
): Promise<Array<Pick<FileMentionIndexEntry, "kind" | "path">>> {
	const entries: Array<Pick<FileMentionIndexEntry, "kind" | "path">> = [];

	async function walk(relativeDirectory: string): Promise<void> {
		if (entries.length >= maxEntries) {
			return;
		}

		const absoluteDirectory = path.join(cwd, relativeDirectory);
		const children = await readdir(absoluteDirectory, { withFileTypes: true });
		children.sort((a, b) => a.name.localeCompare(b.name));

		for (const child of children) {
			if (entries.length >= maxEntries) {
				return;
			}
			const relativePath = normalizeRelativePath(
				path.join(relativeDirectory, child.name),
			);
			if (child.isDirectory()) {
				if (SKIPPED_NODE_DIRECTORIES.has(child.name)) {
					continue;
				}
				entries.push({ kind: "directory", path: relativePath });
				await walk(relativePath);
				continue;
			}
			if (child.isFile()) {
				entries.push({ kind: "file", path: relativePath });
			}
		}
	}

	await walk("");
	return entries;
}

function normalizeIndex(
	cwd: string,
	collectedEntries: Array<Pick<FileMentionIndexEntry, "kind" | "path">>,
	maxEntries: number,
): FileMentionIndex {
	const entries = new Map<string, FileMentionIndexEntry>();
	for (const entry of collectedEntries) {
		if (entries.size >= maxEntries) {
			break;
		}
		const normalizedPath = normalizeRelativePath(entry.path);
		if (!normalizedPath) {
			continue;
		}
		entries.set(`${entry.kind}:${normalizedPath}`, {
			kind: entry.kind,
			path: normalizedPath,
			depth: pathDepth(normalizedPath),
			basename: path.posix.basename(normalizedPath),
		});
	}

	return {
		projectRoot: normalizeAbsolutePath(cwd),
		entries: Array.from(entries.values()).sort(compareIndexEntries),
	};
}

function parseLines(output: string): Array<string> {
	return output.split(/\r?\n/).map(normalizeRelativePath).filter(Boolean);
}

function ancestorDirectories(filePath: string): Array<string> {
	const segments = normalizeRelativePath(filePath).split("/");
	segments.pop();
	return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function normalizeRelativePath(rawPath: string): string {
	return rawPath
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\/+/g, "/")
		.replace(/\/$/, "");
}

function normalizeAbsolutePath(rawPath: string): string {
	const normalizedPath = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
	return normalizedPath === "/"
		? normalizedPath
		: normalizedPath.replace(/\/$/, "");
}

function pathDepth(entryPath: string): number {
	return entryPath.split("/").length;
}

function compareIndexEntries(
	a: FileMentionIndexEntry,
	b: FileMentionIndexEntry,
): number {
	return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind);
}
