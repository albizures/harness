import type { CommandHandlers } from "../../command-handlers.ts";
import type { LifecycleTransitionHandlers } from "../../lifecycle-handlers.ts";

export { genericTaskManifest } from "./manifest.ts";
export { genericTaskManifest as manifest } from "./manifest.ts";
export const genericTaskCommandHandlers: CommandHandlers = {};
export const genericTaskLifecycleHandlers: LifecycleTransitionHandlers = {};
export { genericTaskCommandHandlers as commandHandlers };
export { genericTaskLifecycleHandlers as lifecycleHandlers };
