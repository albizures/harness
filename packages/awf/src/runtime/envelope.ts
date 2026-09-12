import type { JsonValue } from "type-fest";

export type SuccessEnvelope<T extends JsonValue = JsonValue> = {
	ok: true;
	data: T;
};

export type FailureDetails = { [key: string]: JsonValue };

export type FailureDefinition<TCode extends string = string> = {
	code: TCode;
	message: string;
	details?: FailureDetails;
};

export type ErrorEnvelope = {
	ok: false;
	error: {
		code: string;
		message: string;
		details?: FailureDetails;
	};
};

export type Envelope<T extends JsonValue = JsonValue> =
	| SuccessEnvelope<T>
	| ErrorEnvelope;

export function success<T extends JsonValue>(data: T): SuccessEnvelope<T> {
	return { ok: true, data };
}

export function failure<TCode extends string>(
	definition: FailureDefinition<TCode>,
): ErrorEnvelope;
export function failure(
	code: string,
	message: string,
	details?: FailureDetails,
): ErrorEnvelope;
export function failure<TCode extends string>(
	definitionOrCode: FailureDefinition<TCode> | string,
	message?: string,
	details?: FailureDetails,
): ErrorEnvelope {
	if (typeof definitionOrCode !== "string") {
		const definition = definitionOrCode;
		return definition.details === undefined
			? {
					ok: false,
					error: { code: definition.code, message: definition.message },
				}
			: {
					ok: false,
					error: {
						code: definition.code,
						message: definition.message,
						details: { ...definition.details },
					},
				};
	}

	return details === undefined
		? { ok: false, error: { code: definitionOrCode, message: message ?? "" } }
		: {
				ok: false,
				error: { code: definitionOrCode, message: message ?? "", details },
			};
}

export function serializeEnvelope(envelope: Envelope): string {
	return `${JSON.stringify(envelope)}\n`;
}
