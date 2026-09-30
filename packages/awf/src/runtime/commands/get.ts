import { failure, success, type Envelope } from "../envelope.ts";
import type { Tracker } from "../../ports/tracker.ts";
import { CorruptWorkflowProjectionError } from "../../domain/workflow/projection.ts";
import {
	IssueNotFoundError,
	type WorkflowIssue,
} from "../../domain/workflow/issue.ts";
import { runtimeFailures } from "../failures.ts";

const RECENT_LOG_LIMIT = 5;

export async function getIssueCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure(runtimeFailures.invalidArguments({ usage: "awf get <id>" }));
	}

	try {
		const issue = await tracker.getIssue(id);
		const logs = await tracker.readLogs(id);
		return success({
			issue,
			logs,
			recentLogs: logs.slice(-RECENT_LOG_LIMIT),
			relationships: await summarizeRelationships(issue, tracker),
		});
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure(runtimeFailures.notFound({ message: error.message, id }));
		}
		if (error instanceof CorruptWorkflowProjectionError) {
			return failure(
				runtimeFailures.corruptWorkflowProjection({
					message: error.message,
					details: { id },
				}),
			);
		}
		throw error;
	}
}

type RelatedIssueSummary =
	| Pick<WorkflowIssue, "id" | "title" | "workflow">
	| { id: string; missing: true };

type RelationshipSummaries = {
	parent?: RelatedIssueSummary;
	children: Array<RelatedIssueSummary>;
	dependencies: Array<RelatedIssueSummary>;
	dependents: Array<RelatedIssueSummary>;
	generatedBy?: RelatedIssueSummary;
};

async function summarizeRelationships(
	issue: WorkflowIssue,
	tracker: Tracker,
): Promise<RelationshipSummaries> {
	return {
		...(issue.relationships.parent === undefined
			? {}
			: {
					parent: await summarizeRelatedIssue(
						issue.relationships.parent,
						tracker,
					),
				}),
		children: await summarizeRelatedIssues(
			issue.relationships.children,
			tracker,
		),
		dependencies: await summarizeRelatedIssues(
			issue.relationships.dependencies,
			tracker,
		),
		dependents: await summarizeRelatedIssues(
			issue.relationships.dependents,
			tracker,
		),
		...(issue.relationships.generatedBy === undefined
			? {}
			: {
					generatedBy: await summarizeRelatedIssue(
						issue.relationships.generatedBy,
						tracker,
					),
				}),
	};
}

async function summarizeRelatedIssues(
	ids: Array<string>,
	tracker: Tracker,
): Promise<Array<RelatedIssueSummary>> {
	return Promise.all(ids.map((id) => summarizeRelatedIssue(id, tracker)));
}

async function summarizeRelatedIssue(
	id: string,
	tracker: Tracker,
): Promise<RelatedIssueSummary> {
	try {
		const issue = await tracker.getIssue(id);
		return {
			id: issue.id,
			title: issue.title,
			workflow: issue.workflow,
		};
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return { id, missing: true };
		}
		throw error;
	}
}
