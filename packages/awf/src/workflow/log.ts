import type { JsonValue } from "type-fest";

export type WorkflowLog = {
	sequence: number;
	issueId: string;
	type: string;
	runId?: string;
	payload?: JsonValue;
};
