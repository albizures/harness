import { defineConfig } from "vitest/config";

const legacyNodeRunnerSuites = [
	"src/bundled-lifecycle.test.ts",
	"src/cli-get.test.ts",
	"src/cli.test.ts",
	"src/filesystem-tracker.test.ts",
	"src/github-tracker.test.ts",
	"src/manifest.test.ts",
	"src/spec-plan.test.ts",
	"src/tracker-conformance.test.ts",
	"src/tracker.test.ts",
];

// biome-ignore lint/style/noDefaultExport: Vitest loads configuration from a default export.
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
		exclude: legacyNodeRunnerSuites,
		passWithNoTests: true,
	},
});
