import { defaultManifest } from "../../src/default-manifest.ts";
import { createInMemoryTrackerFromEnvironment } from "../../src/trackers/memory.ts";

export const manifest = defaultManifest;
export const tracker = createInMemoryTrackerFromEnvironment(process.env);
