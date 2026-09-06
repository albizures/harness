import type { WorkflowManifest } from "../../src/manifest/index.ts";
import { agentDevelopmentManifest } from "../../src/workflows/agent-development/index.ts";

export const manifest = {
	...agentDevelopmentManifest,
	relationships: [
		...(agentDevelopmentManifest.relationships ?? []),
		{
			id: "generic-link",
			from: "spec",
			to: "ticket",
			projection: { type: "link", direction: "outbound" },
		},
	],
} as unknown as WorkflowManifest;
