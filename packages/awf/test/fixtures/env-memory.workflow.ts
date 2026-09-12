import { createInMemoryTrackerFromEnvironment } from "../../src/adapters/trackers/memory.ts";
import { agentWorkflowManifest } from "../../src/workflows/agent-workflow/index.ts";

export const manifest = agentWorkflowManifest;
export const tracker = createInMemoryTrackerFromEnvironment(process.env);
