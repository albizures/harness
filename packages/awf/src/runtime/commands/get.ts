import { failure, success, type Envelope } from "../envelope.ts";
import type { Tracker } from "../../ports/tracker.ts";
import { CorruptWorkflowProjectionError } from "../../domain/workflow/projection.ts";
import { IssueNotFoundError } from "../../domain/workflow/issue.ts";
import { runtimeFailures } from "../failures.ts";

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
