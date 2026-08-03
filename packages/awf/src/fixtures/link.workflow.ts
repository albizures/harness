import { defaultManifest } from "../default-manifest.ts";
import type { WorkflowManifest } from "../manifest.ts";

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
