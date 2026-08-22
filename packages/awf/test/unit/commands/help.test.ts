import { expect, it } from "vitest";
import { agentDevelopmentManifest } from "../../../src/workflows/agent-development/index.ts";

import { defineManifest } from "../../../src/manifest.ts";
import { execute as rawExecute } from "../../../src/commands.ts";
import { helpCommands, helpReadiness } from "../../../src/commands/help.ts";


function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentDevelopmentManifest, ...options });
}
it("should ensure that help returns a stable success envelope", async () => {
	const envelope = await execute(["--help"]);

	expect(envelope.ok).toBe(true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		name: string;
		description: string;
		commands: Array<{ name: string; usage: string }>;
	};
	expect(data.name).toBe("awf");
	expect(data.description).toBe("Agent workflow CLI.");
	expect(Array.isArray(data.commands)).toBeTruthy();
	expect(
		data.commands.some((command) => command.usage === "awf start <id>"),
	).toBeTruthy();
	expect(
		data.commands.some(
			(command) =>
				command.usage ===
				"awf create handoff --source <issue> --input <file|->",
		),
	).toBeTruthy();
	expect(
		data.commands.every((command) => command.name !== "handoff"),
	).toBeTruthy();
	expect(
		data.commands.every((command) => !command.usage.startsWith("awf handoff")),
	).toBeTruthy();
});

it("should ensure that help combines runtime commands with manifest CLI targets and readiness filters", () => {
	const manifest = defineManifest({
		...agentDevelopmentManifest,
		readiness: {
			filters: [{ kind: "ticket", state: "ready", action: "implement" }],
			namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
		},
		commands: [
			{
				id: "ticket-create",
				cli: { verb: "create", target: "ticket" },
				target: { kind: "ticket", action: "implement" },
			},
			{
				id: "plan-apply",
				cli: { verb: "apply", target: "brief" },
				target: { kind: "ticket", action: "implement" },
			},
		],
	});

	expect(
		helpCommands(manifest).some((command) => command.usage === "awf get <id>"),
	).toBeTruthy();
	expect(
		helpCommands(manifest).some(
			(command) => command.usage === "awf create ticket --input <file|->",
		),
	).toBeTruthy();
	expect(
		helpCommands(manifest).some(
			(command) => command.usage === "awf apply brief <issue> --input <file|->",
		),
	).toBeTruthy();
	expect(helpReadiness(manifest).filters).toEqual([
		{ kind: "ticket", state: "ready", action: "implement" },
	]);
	expect(helpReadiness(manifest).namedFilters).toEqual([
		{
			name: "spec",
			kind: "spec",
			relationship: "parent",
			usage: "awf ready --filter spec=<spec>",
		},
	]);
});
