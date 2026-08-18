export type WorkflowProjection = {
	kind: string;
	state: string;
	action: string;
	reason?: string;
	activeRunId?: string;
	version: number;
	hash: string;
};

export class CorruptWorkflowProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorruptWorkflowProjectionError";
	}
}

export class ProjectionConflictError extends Error {
	constructor(
		message = "Workflow projection expectation does not match current projection.",
	) {
		super(message);
		this.name = "ProjectionConflictError";
	}
}
