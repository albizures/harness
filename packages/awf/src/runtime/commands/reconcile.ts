import { failure, success, type Envelope } from "../envelope.ts";
import type { WorkflowManifest } from "../../domain/manifest/schema.ts";
import type { Tracker } from "../../ports/tracker.ts";
import { isRecord } from "./shared.ts";
import { IssueNotFoundError } from "../../domain/workflow/issue.ts";

export type ReconciliationDiagnostic = {
	code: string;
	severity: "drift" | "corruption";
	message: string;
	repair: "safe" | "manual" | "none";
	applied?: boolean;
};

export async function reconcileCommand(
	id: string | undefined,
	apply: boolean,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf reconcile <id> [--apply]",
		});
	}

	try {
		const inspection = await inspectWorkflowIssue(tracker, id);
		const diagnostics = diagnoseReconciliation(inspection, manifest);
		const hasCorruption = diagnostics.some(
			(diagnostic) => diagnostic.severity === "corruption",
		);
		const safeRepair = hasCorruption
			? undefined
			: diagnostics.find((diagnostic) => diagnostic.repair === "safe");
		const manualRepair = diagnostics.find(
			(diagnostic) => diagnostic.repair === "manual",
		);
		let repairedIssue = inspection.issue;
		if (apply && inspection.issue !== undefined) {
			const repair = safeRepair ?? manualRepair;
			let workflow:
				| Parameters<Tracker["repairIssue"]>[1]["workflow"]
				| undefined;
			if (repair?.repair === "safe") {
				workflow = safeRepairWorkflow(repair);
			}
			if (repair !== undefined && workflow !== undefined) {
				repairedIssue = await tracker.repairIssue(id, {
					expect: {
						version: inspection.issue.workflow.version,
						hash: inspection.issue.workflow.hash,
					},
					workflow,
				});
				repair.applied = true;
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

function diagnoseReconciliation(
	inspection: {
		issue?: Awaited<ReturnType<Tracker["getIssue"]>>;
		logs: Array<unknown>;
		labels?: Array<string>;
		projectionError?: string;
	},
	manifest: WorkflowManifest,
): Array<ReconciliationDiagnostic> {
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
				repair: "manual",
			});
		}
	}
	if (inspection.issue === undefined) {
		return diagnostics;
	}
	void manifest;
	return diagnostics;
}

function projectionErrorCode(
	_message: string,
	labels: Array<string> | undefined,
): string {
	if (labels !== undefined) {
		for (const field of ["kind", "state", "action", "reason"]) {
			const currentField = new RegExp(`^awf:[^:]+:${field}:`, "u");
			const count = labels.filter((label) => currentField.test(label)).length;
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
): log is { sequence: number; issueId: string; type: string } {
	return (
		isRecord(log) &&
		typeof log.sequence === "number" &&
		Number.isInteger(log.sequence) &&
		(expectedSequence === undefined || log.sequence === expectedSequence) &&
		typeof log.issueId === "string" &&
		log.issueId !== "" &&
		typeof log.type === "string" &&
		log.type !== ""
	);
}

function safeRepairWorkflow(
	_diagnostic: ReconciliationDiagnostic,
): Parameters<Tracker["repairIssue"]>[1]["workflow"] | undefined {
	return undefined;
}
