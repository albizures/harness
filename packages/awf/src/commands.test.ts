import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./commands.ts";
import { serializeEnvelope } from "./envelope.ts";

test("help returns a stable success envelope", async () => {
	const envelope = await execute(["--help"]);

	assert.equal(envelope.ok, true);
	if (!envelope.ok) {
		throw new Error("expected success");
	}
	const data = envelope.data as {
		name: string;
		description: string;
		commands: Array<{ usage: string }>;
	};
	assert.equal(data.name, "awf");
	assert.equal(data.description, "Agent workflow CLI.");
	assert.ok(Array.isArray(data.commands));
	assert.ok(
		data.commands.some((command) => command.usage === "awf start <id>"),
	);
});

test("known but unimplemented v1 commands return a typed error envelope", async () => {
	const envelope = await execute(["start", "123"]);

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "NOT_IMPLEMENTED",
			message: "This workflow command is not implemented yet.",
			details: { command: "start 123" },
		},
	});
});

test("invalid arguments return a stable parse error envelope", async () => {
	const envelope = await execute(["succeed", "123"]);

	assert.deepEqual(envelope, {
		ok: false,
		error: {
			code: "INVALID_ARGUMENTS",
			message: "Invalid command arguments.",
			details: { usage: "awf succeed <id> --run <run>" },
		},
	});
});

test("envelopes serialize as one JSON stdout line", () => {
	assert.equal(
		serializeEnvelope({ ok: true, data: { smoke: true } }),
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});
