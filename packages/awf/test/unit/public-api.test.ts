import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as awf from "../../src/index.ts";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const rootExports = awf as Record<string, unknown>;

describe("when publishing the AWF public API", () => {
	it("should not expose removed workflow subpaths", async () => {
		const packageJson = JSON.parse(
			await readFile(join(packageRoot, "package.json"), "utf8"),
		) as { exports: Record<string, string> };

		expect(packageJson.exports).not.toHaveProperty("./workflows/generic-task");
		expect(packageJson.exports).not.toHaveProperty(
			"./workflows/agent-development",
		);
		expect(packageJson.exports).not.toHaveProperty("./manifest");
		expect(packageJson.exports).not.toHaveProperty("./manifest/definition");
		expect(packageJson.exports).not.toHaveProperty("./workflow-module");
	});

	it("should not export stale bundled workflow root aliases", () => {
		expect(rootExports).not.toHaveProperty("genericTaskManifest");
		expect(rootExports).not.toHaveProperty("genericTaskCommandHandlers");
		expect(rootExports).not.toHaveProperty("genericTaskLifecycleHandlers");
		expect(rootExports).not.toHaveProperty("agentDevelopmentManifest");
		expect(rootExports).not.toHaveProperty("agentDevelopmentCommandHandlers");
		expect(rootExports).not.toHaveProperty("agentDevelopmentLifecycleHandlers");
	});

	it("should not export generic authoring APIs", () => {
		expect(rootExports).not.toHaveProperty("defineManifest");
		expect(rootExports).not.toHaveProperty("validateManifest");
		expect(rootExports).not.toHaveProperty("workflowManifestStructuralSchema");
		expect(rootExports).not.toHaveProperty("getKind");
		expect(rootExports).not.toHaveProperty("describeWorkflow");
		expect(rootExports).not.toHaveProperty("manifestCommandUsage");
	});

	it("should not export workflow module or tracker intent authoring APIs", () => {
		expect(rootExports).not.toHaveProperty("WorkflowModuleLoadError");
		expect(rootExports).not.toHaveProperty("loadManifest");
		expect(rootExports).not.toHaveProperty("loadWorkflowModule");
		expect(rootExports).not.toHaveProperty("createTrackerAdapter");
		expect(rootExports).not.toHaveProperty("createTrackerIntentModule");
	});

	it("should not export Failure catalog internals", () => {
		expect(rootExports).not.toHaveProperty("cliFailures");
		expect(rootExports).not.toHaveProperty("runtimeFailures");
	});
});
