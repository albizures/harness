export function assert(cond: unknown, message: string): asserts cond {
	if (!cond) {
		throw new Error(message);
	}
}

export type Result<TData, TError extends Error = Error> =
	| { ok: true; data: TData }
	| { ok: false; error: TError };

export function to<TData>(
	promise: Promise<TData>,
): Promise<Result<TData>> {
  // using then/catch instead of try/catch to avoid its overhead
	return promise
		.then((data) => {
			return {
				ok: true as const,
				data,
			};
		})
		.catch((error) => {
			assert(error instanceof Error, "Only errors are expect to be throwned");
			return {
				ok: false as const,
				error,
			};
		});
}
