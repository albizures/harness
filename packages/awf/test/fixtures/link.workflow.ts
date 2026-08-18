import { defaultManifest } from "../../src/default-manifest.ts";
import type { WorkflowManifest } from "../../src/manifest.ts";

export const manifest = {
	...defaultManifest,
	relationships: [
		...(defaultManifest.relationships ?? []),
		{
			id: "generic-link",
			from: "spec",
			to: "ticket",
			projection: { type: "link", direction: "outbound" },
		},
	],
} as unknown as WorkflowManifest;
