import { createInMemoryTracker } from "../../src/adapters/trackers/memory.ts";
import { agentDevelopmentManifest } from "../../src/workflows/agent-development/index.ts";

export const manifest = agentDevelopmentManifest;
export const tracker = createInMemoryTracker();
export const lifecycleHandlers = {
	"ticket:running/implement:succeed": () => ({ log: { handled: true } }),
};
