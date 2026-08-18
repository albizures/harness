import { describe, expect, test } from "vitest";
import {
	isJsonRecord,
	isJsonValue,
	jsonRecordSchema,
	jsonValueSchema,
	parseJsonRecord,
	parseJsonValue,
} from "../../src/json.ts";

const jsonCompatibleValues = [
	null,
	true,
	false,
	"text",
	0,
	Number.MAX_SAFE_INTEGER,
	["nested", Number.MAX_SAFE_INTEGER, null, { ok: true }],
	{ empty: {}, list: [1, "two"], value: null },
] as const;

const nonJsonCompatibleValues = [
	undefined,
	new Date("2024-01-01T00:00:00.000Z"),
	1n,
	Symbol("not-json"),
	() => undefined,
	{ value: undefined },
	[undefined],
] as const;

describe("AWF JSON boundary primitives", () => {
	test.each(jsonCompatibleValues)(
		"accepts JSON-compatible value %#",
		(value) => {
			expect(jsonValueSchema.safeParse(value).success).toBe(true);
			expect(isJsonValue(value)).toBe(true);
			expect(parseJsonValue(value)).toEqual(value);
		},
	);

	test.each(nonJsonCompatibleValues)(
		"rejects non-JSON-compatible value %#",
		(value) => {
			expect(jsonValueSchema.safeParse(value).success).toBe(false);
			expect(isJsonValue(value)).toBe(false);
			expect(() => parseJsonValue(value)).toThrow();
		},
	);

	test("validates JSON-compatible records separately from scalar values", () => {
		const record = { title: "Plan", metadata: { count: 1 } };

		expect(jsonRecordSchema.parse(record)).toEqual(record);
		expect(isJsonRecord(record)).toBe(true);
		expect(parseJsonRecord(record)).toEqual(record);
		expect(jsonRecordSchema.safeParse(["not", "record"]).success).toBe(false);
		expect(jsonRecordSchema.safeParse({ createdAt: new Date() }).success).toBe(
			false,
		);
	});
});
