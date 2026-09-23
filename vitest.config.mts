import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: Vitest loads configuration from a default export.
export default defineConfig({
	test: {
		environment: "node",
		include: [
			"src/**/*.test.ts",
			"extensions/**/*.test.ts",
			"test/**/*.test.ts",
			"packages/*/src/**/*.test.ts",
			"packages/*/extensions/**/*.test.ts",
			"packages/*/test/**/*.test.ts",
		],
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json"],
			include: [
				"src/**/*.ts",
				"extensions/**/*.ts",
				"packages/*/src/**/*.ts",
				"packages/*/extensions/**/*.ts",
			],
			exclude: [
				"src/**/*.test.ts",
				"extensions/**/*.test.ts",
				"test/**",
				"dist/**",
				"src/**/*.d.ts",
				"extensions/**/*.d.ts",
				"packages/*/src/**/*.test.ts",
				"packages/*/extensions/**/*.test.ts",
				"packages/*/test/**",
				"packages/*/dist/**",
				"packages/*/src/**/*.d.ts",
				"packages/*/extensions/**/*.d.ts",
				"**/*.config.ts",
				"**/*.config.mts",
			],
		},
	},
});
