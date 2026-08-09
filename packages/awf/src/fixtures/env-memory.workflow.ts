import { defaultManifest } from "../default-manifest.ts";
import { createInMemoryTrackerFromEnvironment } from "../trackers/memory.ts";

export const manifest = defaultManifest;
export const tracker = createInMemoryTrackerFromEnvironment(process.env);
