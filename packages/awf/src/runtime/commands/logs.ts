import { failure, success, type Envelope } from "../envelope.ts";
import type { Tracker } from "../../ports/tracker.ts";
import { IssueNotFoundError } from "../../domain/workflow/issue.ts";
import { runtimeFailures } from "../failures.ts";

export async function logsCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure(
			runtimeFailures.invalidArguments({ usage: "awf logs <id>" }),
		);
	}

	try {
		return success({ logs: await tracker.readLogs(id) });
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure(runtimeFailures.notFound({ message: error.message, id }));
		}
		throw error;
	}
}
