import type { JsonValue } from "type-fest";
import { z } from "zod";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.string(),
		z.number(),
		z.boolean(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

export const jsonRecordSchema: z.ZodType<Record<string, JsonValue>> = z.record(
	z.string(),
	jsonValueSchema,
);

export function parseJsonValue(value: unknown): JsonValue {
	return jsonValueSchema.parse(value);
}

export function parseJsonRecord(value: unknown): Record<string, JsonValue> {
	return jsonRecordSchema.parse(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
	return jsonValueSchema.safeParse(value).success;
}

export function isJsonRecord(
	value: unknown,
): value is Record<string, JsonValue> {
	return jsonRecordSchema.safeParse(value).success;
}
