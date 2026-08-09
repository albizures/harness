import { assert, test } from "vitest";
import { serializeEnvelope } from "./envelope.ts";

test("envelopes serialize as one JSON stdout line", () => {
	assert.equal(
		serializeEnvelope({ ok: true, data: { smoke: true } }),
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});
