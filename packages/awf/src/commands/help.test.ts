import { assert, test } from "vitest";
import { defaultManifest } from "../default-manifest.ts";
import { defineManifest } from "../manifest.ts";
import { execute } from "../commands.ts";
import { helpCommands, helpReadiness } from "./help.ts";

test("help returns a stable success envelope", async () => {
	const envelope = await execute(["--help"]);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		name: string;
		description: string;
		commands: Array<{ name: string; usage: string }>;
	};
	assert.equal(data.name, "awf");
	assert.equal(data.description, "Agent workflow CLI.");
	assert.ok(Array.isArray(data.commands));
	assert.ok(
		data.commands.some((command) => command.usage === "awf start <id>"),
	);
	assert.ok(
		data.commands.some(
			(command) =>
				command.usage ===
				"awf create handoff --source <issue> --input <file|->",
		),
	);
	assert.ok(data.commands.every((command) => command.name !== "handoff"));
	assert.ok(
		data.commands.every((command) => !command.usage.startsWith("awf handoff")),
	);
});

test("help combines runtime commands with manifest CLI targets and readiness filters", () => {
	const manifest = defineManifest({
		...defaultManifest,
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

	assert.ok(
		helpCommands(manifest).some((command) => command.usage === "awf get <id>"),
	);
	assert.ok(
		helpCommands(manifest).some(
			(command) => command.usage === "awf create ticket --input <file|->",
		),
	);
	assert.ok(
		helpCommands(manifest).some(
			(command) => command.usage === "awf apply brief <issue> --input <file|->",
		),
	);
	assert.deepEqual(helpReadiness(manifest).filters, [
		{ kind: "ticket", state: "ready", action: "implement" },
	]);
	assert.deepEqual(helpReadiness(manifest).namedFilters, [
		{
			name: "spec",
			kind: "spec",
			relationship: "parent",
			usage: "awf ready --filter spec=<spec>",
		},
	]);
});
