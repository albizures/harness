import { expect, test } from "vitest";
import { serializeEnvelope } from "../../src/envelope.ts";

test("envelopes serialize as one JSON stdout line", () => {
	expect(serializeEnvelope({ ok: true, data: { smoke: true } })).toBe(
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});
