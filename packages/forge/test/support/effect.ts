import * as NodeContext from "@effect/platform-node/NodeContext";
import { Cause, Exit, type Effect } from "effect";
import * as EffectRuntime from "effect/Effect";

export async function runTestEffect<A, E>(
	program: Effect.Effect<A, E, NodeContext.NodeContext>,
): Promise<A> {
	const exit = await EffectRuntime.runPromiseExit(
		EffectRuntime.provide(program, NodeContext.layer),
	);
	if (Exit.isSuccess(exit)) {
		return exit.value;
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag === "Some") {
		throw failure.value;
	}
	throw Cause.squash(exit.cause);
}
