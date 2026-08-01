import { failure, success, type Envelope } from "../envelope.ts";
import { IssueNotFoundError, type Tracker } from "../tracker.ts";
import { deriveRuns, isRecord, isTerminalLog } from "./shared.ts";

export type ReconciliationDiagnostic = {
	code: string;
	severity: "drift" | "corruption";
	message: string;
	repair: "safe" | "need-human" | "none";
	runId?: string;
	applied?: boolean;
};

export async function reconcileCommand(
	id: string | undefined,
	apply: boolean,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf reconcile <id> [--apply]",
		});
	}

	try {
		const inspection = await inspectWorkflowIssue(tracker, id);
		const diagnostics = diagnoseReconciliation(inspection);
		const hasCorruption = diagnostics.some(
			(diagnostic) => diagnostic.severity === "corruption",
		);
		const safeRepair = hasCorruption
			? undefined
			: diagnostics.find((diagnostic) => diagnostic.repair === "safe");
		let repairedIssue = inspection.issue;
		if (apply && safeRepair !== undefined && inspection.issue !== undefined) {
			const workflow = safeRepairWorkflow(safeRepair);
			if (workflow !== undefined) {
				repairedIssue = await tracker.updateIssue(id, {
					expect: {
						version: inspection.issue.workflow.version,
						hash: inspection.issue.workflow.hash,
					},
					workflow,
				});
				safeRepair.applied = true;
			}
		}
		return success({
			id,
			mode: apply ? "apply" : "check",
			status: diagnostics.length === 0 ? "clean" : "diagnosed",
			diagnostics,
			...(repairedIssue === undefined ? {} : { issue: repairedIssue }),
		});
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		throw error;
	}
}

async function inspectWorkflowIssue(
	tracker: Tracker,
	id: string,
): Promise<{
	issue?: Awaited<ReturnType<Tracker["getIssue"]>>;
	logs: Array<unknown>;
	labels?: Array<string>;
	projectionError?: string;
}> {
	if (tracker.inspectIssue !== undefined) {
		return tracker.inspectIssue(id);
	}
	return {
		issue: await tracker.getIssue(id),
		logs: await tracker.readLogs(id),
	};
}

function diagnoseReconciliation(inspection: {
	issue?: Awaited<ReturnType<Tracker["getIssue"]>>;
	logs: Array<unknown>;
	labels?: Array<string>;
	projectionError?: string;
}): Array<ReconciliationDiagnostic> {
	const diagnostics: Array<ReconciliationDiagnostic> = [];
	if (inspection.projectionError !== undefined) {
		diagnostics.push({
			code: projectionErrorCode(inspection.projectionError, inspection.labels),
			severity: "corruption",
			message: inspection.projectionError,
			repair: "none",
		});
	}
	for (const [index, log] of inspection.logs.entries()) {
		if (!isWorkflowLogShape(log, index + 1)) {
			diagnostics.push({
				code: "MALFORMED_WORKFLOW_LOG",
				severity: "corruption",
				message: `Workflow log at sequence ${index + 1} is malformed.`,
				repair: "none",
			});
		}
	}
	if (inspection.issue === undefined) {
		return diagnostics;
	}
	const validLogs = inspection.logs.filter(
		(
			log,
		): log is {
			sequence: number;
			issueId: string;
			type: string;
			runId?: string;
		} => isWorkflowLogShape(log),
	);
	const runStates = deriveRuns(
		inspection.issue.workflow.activeRunId,
		validLogs,
	);
	const openRuns = runStates.attempts.filter(
		(attempt) => attempt.status === "running",
	);
	if (
		inspection.issue.workflow.activeRunId === undefined &&
		openRuns.length === 1
	) {
		diagnostics.push({
			code: "MISSING_ACTIVE_RUN",
			severity: "drift",
			message: `Current fields are missing active run '${openRuns[0]?.runId}'.`,
			repair: "safe",
			runId: openRuns[0]?.runId,
		});
	}
	if (
		inspection.issue.workflow.activeRunId === undefined &&
		openRuns.length > 1
	) {
		diagnostics.push({
			code: "AMBIGUOUS_ACTIVE_RUN",
			severity: "drift",
			message: "Multiple log-derived runs could be active.",
			repair: "need-human",
		});
	}
	const active = inspection.issue.workflow.activeRunId;
	if (active !== undefined) {
		const terminal = validLogs.find(
			(log) => log.runId === active && isTerminalLog(log.type),
		);
		if (terminal !== undefined) {
			diagnostics.push({
				code: "TERMINAL_RUN_STILL_ACTIVE",
				severity: "drift",
				message: `Active run '${active}' already has a terminal log.`,
				repair:
					inspection.issue.workflow.state === "running" ? "need-human" : "safe",
			});
		}
	}
	return diagnostics;
}

function projectionErrorCode(
	_message: string,
	labels: Array<string> | undefined,
): string {
	if (labels !== undefined) {
		for (const prefix of ["type", "state", "action", "reason"]) {
			const count = labels.filter((label) =>
				label.startsWith(`${prefix}:`),
			).length;
			if (count > 1) {
				return "DUPLICATE_CURRENT_FIELDS";
			}
		}
	}
	return "MISSING_CURRENT_METADATA";
}

function isWorkflowLogShape(
	log: unknown,
	expectedSequence?: number,
): log is { sequence: number; issueId: string; type: string; runId?: string } {
	return (
		isRecord(log) &&
		typeof log.sequence === "number" &&
		Number.isInteger(log.sequence) &&
		(expectedSequence === undefined || log.sequence === expectedSequence) &&
		typeof log.issueId === "string" &&
		log.issueId !== "" &&
		typeof log.type === "string" &&
		log.type !== "" &&
		(log.runId === undefined ||
			(typeof log.runId === "string" && log.runId !== ""))
	);
}

function safeRepairWorkflow(
	diagnostic: ReconciliationDiagnostic,
): { activeRunId?: string } | undefined {
	if (diagnostic.code === "TERMINAL_RUN_STILL_ACTIVE") {
		return { activeRunId: undefined };
	}
	if (
		diagnostic.code === "MISSING_ACTIVE_RUN" &&
		diagnostic.runId !== undefined
	) {
		return { activeRunId: diagnostic.runId };
	}
	return undefined;
}
