import { expect, it } from "vitest";
import { serializeEnvelope } from "../../../src/runtime/envelope.ts";

it("should ensure that envelopes serialize as one JSON stdout line", () => {
	expect(serializeEnvelope({ ok: true, data: { smoke: true } })).toBe(
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});
