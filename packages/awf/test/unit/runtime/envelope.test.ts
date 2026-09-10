import { describe, expect, expectTypeOf, it } from "vitest";
import {
	failure,
	serializeEnvelope,
	type FailureDefinition,
} from "../../../src/runtime/envelope.ts";
import type {
	FailureDefinition as PublicFailureDefinition,
	FailureDetails as PublicFailureDetails,
} from "../../../src/index.ts";

it("should ensure that envelopes serialize as one JSON stdout line", () => {
	expect(serializeEnvelope({ ok: true, data: { smoke: true } })).toBe(
		'{"ok":true,"data":{"smoke":true}}\n',
	);
});

describe("when constructing failure envelopes", () => {
	it("should produce the same envelope from a failure definition as positional arguments", () => {
		const definition = {
			code: "INVALID_WIDGET",
			message: "Widget is invalid.",
			details: { id: "widget-1", retriable: false },
		} satisfies FailureDefinition<"INVALID_WIDGET">;

		expect(failure(definition)).toEqual(
			failure("INVALID_WIDGET", "Widget is invalid.", {
				id: "widget-1",
				retriable: false,
			}),
		);
	});

	it("should shallow-copy failure definition details", () => {
		const details = { id: "widget-1" };
		const envelope = failure({
			code: "INVALID_WIDGET",
			message: "Widget is invalid.",
			details,
		});

		expect(envelope.error.details).toEqual(details);
		expect(envelope.error.details).not.toBe(details);
	});

	it("should keep supporting positional failure arguments", () => {
		const details = { id: "widget-1" };
		const envelope = failure("INVALID_WIDGET", "Widget is invalid.", details);

		expect(envelope).toEqual({
			ok: false,
			error: {
				code: "INVALID_WIDGET",
				message: "Widget is invalid.",
				details,
			},
		});
		expect(envelope.error.details).toBe(details);
	});

	it("should preserve literal failure codes in failure definitions", () => {
		const definition = {
			code: "INVALID_WIDGET",
			message: "Widget is invalid.",
		} satisfies FailureDefinition<"INVALID_WIDGET">;
		const publicDetails: PublicFailureDetails = { id: "widget-1" };

		expectTypeOf(definition.code).toEqualTypeOf<"INVALID_WIDGET">();
		expectTypeOf<
			PublicFailureDefinition<"INVALID_WIDGET">["code"]
		>().toEqualTypeOf<"INVALID_WIDGET">();
		expect(definition.code).toBe("INVALID_WIDGET");
		expect(publicDetails.id).toBe("widget-1");
	});
});
