import { defaultManifest } from "../../src/default-manifest.ts";
import { createInMemoryTracker } from "../../src/trackers/memory.ts";

export const manifest = defaultManifest;
export const tracker = createInMemoryTracker();
export const lifecycleHandlers = {
	"ticket:running/implement:succeed": () => ({ log: { handled: true } }),
};
