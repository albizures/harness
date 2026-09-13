import {
	agentWorkflowManifest,
	createGhCliGitHubTracker,
} from "@albizures/awf";

export const manifest = agentWorkflowManifest;
export const tracker = createGhCliGitHubTracker({
	owner: "albizures",
	repo: "harness",
	manifest: agentWorkflowManifest,
});
