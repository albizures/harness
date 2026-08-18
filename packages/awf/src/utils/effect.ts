import { Result } from "./errors.ts"



type Unit<in TInput, out TOutput, out TError extends Error> = {
  handler: (input: TInput) => Result<TOutput, TError>
}

