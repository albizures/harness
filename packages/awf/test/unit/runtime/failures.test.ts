import { describe, expect, it } from "vitest";
import { failure } from "../../../src/runtime/envelope.ts";
import { runtimeFailures } from "../../../src/runtime/failures.ts";

describe("when using the runtime Failure catalog", () => {
	it("should expose uppercase static definitions consumed by failure envelopes", () => {
		expect(failure(runtimeFailures.MANIFEST_REQUIRED)).toEqual({
			ok: false,
			error: {
				code: "MANIFEST_REQUIRED",
				message: "AWF requires an explicit workflow manifest for this command.",
			},
		});
	});

	it("should expose lower camelCase factories for contextual definitions", () => {
		expect(
			failure(runtimeFailures.invalidArguments({ usage: "awf get <id>" })),
		).toEqual({
			ok: false,
			error: {
				code: "INVALID_ARGUMENTS",
				message: "Invalid command arguments.",
				details: { usage: "awf get <id>" },
			},
		});
	});
});
