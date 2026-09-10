import type { WorkflowManifest } from "../../src/manifest/index.ts";
import { agentWorkflowManifest } from "../../src/workflows/agent-workflow/index.ts";

export const manifest = {
	...agentWorkflowManifest,
	relationships: [
		...(agentWorkflowManifest.relationships ?? []),
		{
			id: "generic-link",
			from: "spec",
			to: "task",
			projection: { type: "link", direction: "outbound" },
		},
	],
} as unknown as WorkflowManifest;
