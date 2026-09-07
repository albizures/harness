import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bindCliExecution } from "../../src/cli-config.ts";

const agentDevelopmentWorkflowSourcePath = new URL(
	"../../src/workflows/agent-development/index.ts",
	import.meta.url,
).pathname;
const validManifestPath = new URL(
	"../fixtures/valid.workflow.ts",
	import.meta.url,
).pathname;

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

it("should bind the bundled agent-workflow manifest when config is missing", async () => {
	await withTempDir(async (dir) => {
		const binding = await bindCliExecution(["ready"], dir);

		expect("manifest" in binding).toBe(true);
		if (!("manifest" in binding)) {
			throw new Error("expected cli binding");
		}
		expect(binding.args).toEqual(["ready"]);
		expect(binding.manifest.workflow.id).toBe("agent-workflow");
		expect(binding.manifest.kinds.map((kind) => kind.id)).toEqual([
			"spec",
			"task",
		]);
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
		expect("manifest" in fromChildDirectory).toBe(true);
		if (!("manifest" in fromChildDirectory)) {
			throw new Error("expected cli binding");
		}
		expect(fromChildDirectory.manifest.workflow.id).toBe("agent-workflow");
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
