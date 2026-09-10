import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as awf from "../../src/index.ts";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const rootExports = awf as Record<string, unknown>;

describe("when publishing the AWF public API", () => {
	it("should not expose the removed generic-task workflow subpath", async () => {
		const packageJson = JSON.parse(
			await readFile(join(packageRoot, "package.json"), "utf8"),
		) as { exports: Record<string, string> };

		expect(packageJson.exports).not.toHaveProperty("./workflows/generic-task");
	});

	it("should not export stale generic-task root aliases", () => {
		expect(rootExports).not.toHaveProperty("genericTaskManifest");
		expect(rootExports).not.toHaveProperty("genericTaskCommandHandlers");
		expect(rootExports).not.toHaveProperty("genericTaskLifecycleHandlers");
	});

	it("should not export Failure catalog internals", () => {
		expect(rootExports).not.toHaveProperty("cliFailures");
		expect(rootExports).not.toHaveProperty("runtimeFailures");
	});
});
