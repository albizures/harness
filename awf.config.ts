import { agentWorkflowManifest } from "./packages/awf/dist";
import { createFileSystemTracker } from "./packages/awf/dist/trackers/filesystem";

export const manifest = agentWorkflowManifest;
export const tracker = createFileSystemTracker({ path: "./.awf/tracker" });
