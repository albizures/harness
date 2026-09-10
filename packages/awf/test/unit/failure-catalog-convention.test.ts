import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const migratedFailureCatalogSourceAreas = [
	"src/runtime",
	"src/cli",
	"src/cli.ts",
];
const rawFailureStringLiteralPattern = /\bfailure\s*\(\s*(["'`])/g;

async function collectTypeScriptFiles(
	paths: Array<string>,
): Promise<Array<string>> {
	const files = await Promise.all(
		paths.map((path) => collectPath(join(packageRoot, path))),
	);
	return files.flat().sort();
}

async function collectPath(path: string): Promise<Array<string>> {
	const pathStat = await stat(path);

	if (pathStat.isFile()) {
		return path.endsWith(".ts") ? [path] : [];
	}

	const entries = await readdir(path, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => collectPath(join(path, entry.name))),
	);
	return files.flat();
}

type RawFailureCall = {
	location: string;
};

async function findRawFailureCalls(
	files: Array<string>,
): Promise<Array<RawFailureCall>> {
	const rawFailureCalls = await Promise.all(
		files.map(async (file) => {
			const sourceText = await readFile(file, "utf8");
			const calls: Array<RawFailureCall> = [];

			for (const match of sourceText.matchAll(rawFailureStringLiteralPattern)) {
				const position = lineAndColumn(sourceText, match.index);
				calls.push({
					location: `${relative(packageRoot, file)}:${position.line}:${position.column}`,
				});
			}

			return calls;
		}),
	);
	return rawFailureCalls.flat();
}

function lineAndColumn(
	sourceText: string,
	index: number,
): {
	line: number;
	column: number;
} {
	const previousSourceText = sourceText.slice(0, index);
	const lines = previousSourceText.split("\n");
	return {
		line: lines.length,
		column: lines.at(-1)?.length ?? 0,
	};
}

describe("when enforcing migrated Failure catalog conventions", () => {
	it("should not allow raw failure string literals in runtime or CLI source", async () => {
		const files = await collectTypeScriptFiles(
			migratedFailureCatalogSourceAreas,
		);

		expect(await findRawFailureCalls(files)).toEqual([]);
	});

	it("should keep bundled workflow source outside this implementation slice", async () => {
		const files = await collectTypeScriptFiles(
			migratedFailureCatalogSourceAreas,
		);

		expect(files.map((file) => relative(packageRoot, file))).not.toContain(
			expect.stringContaining("src/workflows/"),
		);
	});
});
