import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { type Effect } from "effect";
import * as EffectRuntime from "effect/Effect";

export function runForgeMain<A, E>(
	program: Effect.Effect<A, E, NodeContext.NodeContext>,
): void {
	NodeRuntime.runMain(EffectRuntime.provide(program, NodeContext.layer), {
		disableErrorReporting: true,
		disablePrettyLogger: true,
	});
}
