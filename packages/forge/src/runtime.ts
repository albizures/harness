import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Cause, Exit, type Effect } from "effect";
import * as EffectRuntime from "effect/Effect";

export function runForgeMain<A, E>(
	program: Effect.Effect<A, E, NodeContext.NodeContext>,
): void {
	NodeRuntime.runMain(EffectRuntime.provide(program, NodeContext.layer), {
		disableErrorReporting: true,
		disablePrettyLogger: true,
	});
}

export async function runForgePromise<A, E>(
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
