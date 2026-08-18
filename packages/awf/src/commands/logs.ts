import { failure, success, type Envelope } from "../envelope.ts";
import type { Tracker } from "../tracker.ts";
import { IssueNotFoundError } from "../workflow/issue.ts";

export async function logsCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf logs <id>",
		});
	}

	try {
		return success({ logs: await tracker.readLogs(id) });
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		throw error;
	}
}
