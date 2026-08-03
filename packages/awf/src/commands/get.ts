import { failure, success, type Envelope } from "../envelope.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	type Tracker,
} from "../tracker.ts";
import { deriveRuns } from "./shared.ts";

export async function getIssueCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf get <id>",
		});
	}

	try {
		const issue = await tracker.getIssue(id);
		const logs = await tracker.readLogs(id);
		return success({
			issue,
			runs: deriveRuns(issue.workflow.activeRunId, logs),
		});
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		if (error instanceof CorruptWorkflowProjectionError) {
			return failure("CORRUPT_WORKFLOW_PROJECTION", error.message, { id });
		}
		throw error;
	}
}
