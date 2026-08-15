import { defaultManifest } from "../default-manifest.ts";
import { createInMemoryTracker } from "../trackers/memory.ts";

export const manifest = defaultManifest;
export const tracker = createInMemoryTracker();
