import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bindCliExecution } from "../../src/cli-config.ts";

const agentDevelopmentWorkflowSourcePath = new URL(
	"../../src/workflows/agent-development/index.ts",
	import.meta.url,
).pathname;
const validManifestPath = new URL("../fixtures/valid.workflow.ts", import.meta.url)
	.pathname;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "awf-cli-config-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function manifestOnlyConfig(): string {
	return `import { agentDevelopmentManifest } from ${JSON.stringify(agentDevelopmentWorkflowSourcePath)};
export const manifest = agentDevelopmentManifest;
`;
}

it("should ensure that missing workflow config returns a stable failure envelope", async () => {
	await withTempDir(async (dir) => {
		const binding = await bindCliExecution(["ready"], dir);

		expect(binding).toEqual({
			ok: false,
			error: {
				code: "CONFIG_LOAD_FAILED",
				message:
					"AWF requires an explicit workflow config. Create ./awf.config.ts or pass --config <path>; to use the bundled agent-development workflow, explicitly export agentDevelopmentManifest from your config.",
				details: { expected: join(dir, "awf.config.ts") },
			},
		});
	});
});

it("should ensure that default config discovery is limited to the current working directory", async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, "awf.config.ts"), manifestOnlyConfig());
		const child = join(dir, "child");
		await mkdir(child);

		const fromCurrentDirectory = await bindCliExecution(["ready"], dir);
		expect("manifest" in fromCurrentDirectory).toBe(true);
		if (!("manifest" in fromCurrentDirectory)) {
			throw new Error("expected cli binding");
		}
		expect(fromCurrentDirectory.args).toEqual(["ready"]);
		expect(fromCurrentDirectory.manifest.workflow.id).toBe("agent-development");

		const fromChildDirectory = await bindCliExecution(["ready"], child);
		expect(fromChildDirectory).toMatchObject({
			ok: false,
			error: { code: "CONFIG_LOAD_FAILED" },
		});
	});
});

it("should ensure that explicit --config is stripped before command dispatch", async () => {
	await withTempDir(async (dir) => {
		const binding = await bindCliExecution(
			["--config", validManifestPath, "ready"],
			dir,
		);

		expect("manifest" in binding).toBe(true);
		if (!("manifest" in binding)) {
			throw new Error("expected cli binding");
		}
		expect(binding.args).toEqual(["ready"]);
		expect(binding.manifest.workflow.id).toBe("agent-development");
	});
});

it("should ensure that malformed --config arguments are rejected before loading modules", async () => {
	await withTempDir(async (dir) => {
		for (const args of [
			["--config"],
			["--config", "--json", "ready"],
			["--config", "one.ts", "--config", "two.ts", "ready"],
		]) {
			const binding = await bindCliExecution(args, dir);

			expect(binding).toEqual({
				ok: false,
				error: {
					code: "INVALID_ARGUMENTS",
					message: "Invalid command arguments.",
					details: { usage: "awf [--config <path>] <command> ..." },
				},
			});
		}
	});
});

it("should ensure that explicit missing config paths return config load failures", async () => {
	await withTempDir(async (dir) => {
		const binding = await bindCliExecution(
			["--config", "missing.workflow.ts", "ready"],
			dir,
		);

		expect(binding).toEqual({
			ok: false,
			error: {
				code: "CONFIG_LOAD_FAILED",
				message: "Config file does not exist.",
				details: { path: join(dir, "missing.workflow.ts") },
			},
		});
	});
});
