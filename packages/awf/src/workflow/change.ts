import type { ArtifactKind } from "./artifact.ts";

export type WorkflowChange = {
	id: string;
	kind: ArtifactKind;
	uri: string;
	summary?: string;
};
