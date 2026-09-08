export type WorkflowLog = {
	sequence: number;
	issueId: string;
	type: string;
	runId?: string;
	message?: string;
};
