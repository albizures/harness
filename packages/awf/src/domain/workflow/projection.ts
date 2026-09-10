import type { JsonValue } from "type-fest";

export type WorkflowProjection = {
	kind: string;
	state: string;
	action: string;
	reason?: string;
	data?: Record<string, JsonValue>;
	semanticVersion?: string;
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
