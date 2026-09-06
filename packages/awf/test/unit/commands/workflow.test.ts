import { describe, expect, it } from "vitest";

import { execute as rawExecute } from "../../../src/commands.ts";
import type { WorkflowDescriptionV1 } from "../../../src/manifest/index.ts";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}

describe("when describing a workflow through command execution", () => {
	it("should return the loaded workflow description", async () => {
		const envelope = await execute(["workflow", "describe"]);

		expect(envelope.ok).toBe(true);
		if (!envelope.ok) {
			throw new Error("expected success");
		}
		const data = envelope.data as WorkflowDescriptionV1;
		expect(data.version).toBe("v1");
		expect(data.workflow.id).toBe(agentDevelopmentManifest.workflow.id);
	});

	it("should require a manifest at the command layer", async () => {
		const envelope = await rawExecute(["workflow", "describe"]);

		expect(envelope).toEqual({
			ok: false,
			error: {
				code: "MANIFEST_REQUIRED",
				message: "AWF requires an explicit workflow manifest for this command.",
			},
		});
	});

	it("should reject extra describe arguments and options", async () => {
		for (const args of [
			["workflow", "describe", "extra"],
			["workflow", "describe", "--json"],
		]) {
			const envelope = await execute(args);

			expect(envelope).toEqual({
				ok: false,
				error: {
					code: "INVALID_ARGUMENTS",
					message: "Invalid command arguments.",
					details: { usage: "awf workflow describe" },
				},
			});
		}
	});

	it("should reject unknown workflow subcommands as invalid arguments", async () => {
		const envelope = await execute(["workflow", "inspect"]);

		expect(envelope).toEqual({
			ok: false,
			error: {
				code: "INVALID_ARGUMENTS",
				message: "Invalid command arguments.",
				details: { usage: "awf workflow describe" },
			},
		});
	});
});
