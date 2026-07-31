import type { JsonValue } from "type-fest";

export type SuccessEnvelope<T extends JsonValue = JsonValue> = {
  ok: true;
  data: T;
};

export type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: { [key: string]: JsonValue };
  };
};

export type Envelope<T extends JsonValue = JsonValue> = SuccessEnvelope<T> | ErrorEnvelope;

export function success<T extends JsonValue>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

export function failure(
  code: string,
  message: string,
  details?: { [key: string]: JsonValue },
): ErrorEnvelope {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

export function serializeEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}
