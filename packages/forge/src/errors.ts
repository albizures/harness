export type ForgeErrorKind =
	| "config-missing"
	| "config-invalid"
	| "project-id-invalid"
	| "project-invalid"
	| "project-exists"
	| "project-not-found"
	| "record-invalid"
	| "record-not-found"
	| "store-invalid";

export type ForgeErrorOptions = {
	readonly kind: ForgeErrorKind;
	readonly message: string;
	readonly cause?: unknown;
	readonly details?: Readonly<Record<string, unknown>>;
};

export class ForgeError extends Error {
	readonly kind: ForgeErrorKind;
	readonly details?: Readonly<Record<string, unknown>>;
	override readonly cause?: unknown;

	constructor(options: ForgeErrorOptions) {
		super(options.message);
		this.name = "ForgeError";
		this.kind = options.kind;
		this.cause = options.cause;
		this.details = options.details;
	}
}

export function isForgeError(error: unknown): error is ForgeError {
	return error instanceof ForgeError;
}
