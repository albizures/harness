import {
	agentWorkflowManifest,
	createGhCliGitHubTracker,
} from "./packages/awf/dist";

export const manifest = agentWorkflowManifest;
export const tracker = createGhCliGitHubTracker({
	owner: "albizures",
	repo: "harness",
	manifest: agentWorkflowManifest,
});
