import { success, type Envelope } from "../envelope.ts";
import type { WorkflowManifest } from "../manifest.ts";
import type { Tracker } from "../tracker.ts";
import type { ReadyOptions } from "./args.ts";
import { cleanWorkflowFields, compareReadyIssues, matchesNamedReadinessFilters, matchesReadinessFilters, readinessBlocking, readinessFilters, readyItem, specPostTicketGateIsOpen, validateNamedReadinessFilterDeclarations, validateNamedReadinessFilterValues } from "./shared.ts";

export async function readyCommand(
	options: ReadyOptions,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	const namedFilterDeclarationValidation =
		validateNamedReadinessFilterDeclarations(options.filters, manifest);
	if (namedFilterDeclarationValidation !== undefined) {
		return namedFilterDeclarationValidation;
	}
	const issues = await tracker.listIssues();
	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	const activeIssues = issues.filter(
		(issue) => issue.workflow.activeRunId !== undefined,
	);
	const filters = readinessFilters(manifest);
	const namedFilterValidation = validateNamedReadinessFilterValues(
		options.filters,
		manifest,
		byId,
	);
	if (namedFilterValidation !== undefined) {
		return namedFilterValidation;
	}
	const readyLike = issues
		.filter((issue) => matchesReadinessFilters(issue.workflow, filters))
		.filter((issue) => issue.workflow.activeRunId === undefined)
		.filter((issue) => specPostTicketGateIsOpen(issue, byId))
		.filter((issue) =>
			matchesNamedReadinessFilters(issue, options.filters, manifest),
		);
	const readiness = readyLike.map((issue) => ({
		issue,
		blocking: readinessBlocking(issue, byId, manifest, activeIssues),
	}));
	const candidates = readiness
		.filter((item) => item.blocking.length === 0)
		.map((item) => item.issue)
		.sort(compareReadyIssues)
		.slice(0, options.limit);
	const blocked = readiness
		.filter((item) => item.blocking.length > 0)
		.sort((left, right) => compareReadyIssues(left.issue, right.issue));

	return success({
		items: candidates.map(readyItem),
		...(blocked.length === 0
			? {}
			: {
					blocked: blocked.map(({ issue, blocking }) => ({
						id: issue.id,
						title: issue.title,
						workflow: cleanWorkflowFields(issue.workflow),
						blocking,
					})),
				}),
	});
}
