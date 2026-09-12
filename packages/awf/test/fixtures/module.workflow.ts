import { createInMemoryTracker } from "../../src/adapters/trackers/memory.ts";
import { agentWorkflowManifest } from "../../src/workflows/agent-workflow/index.ts";

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTracker();
export const lifecycleHandlers = {
	"task:running/work:succeed": () => ({ log: { handled: true } }),
};
