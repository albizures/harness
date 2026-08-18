import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: Vitest loads configuration from a default export.
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
		passWithNoTests: true,
	},
});
