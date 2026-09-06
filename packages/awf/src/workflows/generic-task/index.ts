import type { LifecycleTransitionHandlers } from "../../lifecycle-handlers.ts";

export { genericTaskCommandHandlers } from "./command-handlers.ts";
export { genericTaskManifest } from "./manifest.ts";
export { genericTaskManifest as manifest } from "./manifest.ts";
export const genericTaskLifecycleHandlers: LifecycleTransitionHandlers = {};
export { genericTaskCommandHandlers as commandHandlers } from "./command-handlers.ts";
export { genericTaskLifecycleHandlers as lifecycleHandlers };
