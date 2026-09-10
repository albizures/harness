import { createInMemoryTrackerFromEnvironment } from "../../src/adapters/trackers/memory.ts";
import { agentDevelopmentManifest } from "../../src/workflows/agent-development/index.ts";

export const manifest = agentDevelopmentManifest;
export const tracker = createInMemoryTrackerFromEnvironment(process.env);
