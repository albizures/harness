import { WorkflowArtifact } from "./artifact.ts";
import { WorkflowChange } from "./change.ts";
import { WorkflowLog } from "./log.ts";
import { WorkflowProjection } from "./projection.ts";

export type WorkflowIssue = {
  id: string;
  title: string;
  body?: string;
  workflow: WorkflowProjection;
  relationships: IssueRelationships;
  artifacts: Array<WorkflowArtifact>;
  changes: Array<WorkflowChange>;
};

export type CreateIssueInput = {
	id?: string;
	title: string;
	body?: string;
	workflow: Omit<WorkflowProjection, "version" | "hash"> & { version?: number };
	relationships?: Partial<IssueRelationships>;
	logs?: Array<Omit<WorkflowLog, "issueId">>;
};


export type SeedIssueInput =
	| CreateIssueInput
	| {
			id: string;
			title: string;
			body?: string;
			labels: Array<string>;
			relationships?: Partial<IssueRelationships>;
			version?: number;
	  };

export type UpdateIssueInput = {
	expect?: { version?: number; hash?: string };
	title?: string;
	body?: string;
	workflow?: Partial<Omit<WorkflowProjection, "version" | "hash">>;
};

export type IssueRelationships = {
	parent?: string;
	children: Array<string>;
	dependencies: Array<string>;
	dependents: Array<string>;
};


export class IssueNotFoundError extends Error {
	constructor(id: string) {
		super(`Workflow issue '${id}' was not found.`);
		this.name = "IssueNotFoundError";
	}
}
