import { failure, success, type Envelope } from "../envelope.ts";
import { parseJsonValue } from "../../shared/json.ts";
import type { LifecycleTransitionHandlers } from "../lifecycle-handlers.ts";
import type { TrackerAdapterPrimitiveReads } from "../../ports/tracker.ts";
import { runLifecycleTransitionHandler } from "../lifecycle-handlers.ts";
import type { WorkflowManifest } from "../../domain/manifest/schema.ts";
import type { Tracker, TrackerLog } from "../../ports/tracker.ts";
import { runtimeFailures } from "../failures.ts";
import {
	cleanTransitionTarget,
	defaultRetryTarget,
	findTransition,
	invalidTransition,
	isWorkflowActive,
	lifecycleError,
	parseJsonInput,
	parsePayloadValue,
	progressRelationshipsAfterLifecycleTransition,
	readInput,
	terminalLogType,
	workflowTarget,
	stableStringify,
} from "./shared.ts";

export async function startCommand(
	id: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	lifecycleHandlers?: LifecycleTransitionHandlers,
): Promise<Envelope> {
	if (id === undefined) {
		return failure(
			runtimeFailures.invalidArguments({ usage: "awf start <id>" }),
		);
	}

	try {
		const issue = await tracker.getIssue(id);
		const transition = findTransition(manifest, issue.workflow, "start");
		if (transition === undefined) {
			return invalidTransition(id, "start");
		}
		if (
			manifest.lifecycle?.activeStates !== undefined &&
			!manifest.lifecycle.activeStates.includes(transition.to.state)
		) {
			return failure(
				runtimeFailures.invalidTransition({
					message: "Start transition must land in a manifest active state.",
					id,
					event: "start",
				}),
			);
		}
		if (lifecycleHandlers === undefined) {
			const log: TrackerLog = {
				type: "action_started",
				message: stableStringify({
					event: "start",
					to: cleanTransitionTarget(transition.to),
				}),
			};
			const result = await tracker.applyWorkflowEffects({
				effects: [
					{
						type: "update-workflow",
						issue: { id },
						expect: {
							version: issue.workflow.version,
							hash: issue.workflow.hash,
						},
						workflow: workflowTarget(transition.to),
					},
					{ type: "record-command", issue: { id }, log },
				],
			});
			return success({
				issue: result.issues[id] ?? (await tracker.getIssue(id)),
				log: result.logs[0],
			});
		}
		const handler = await runLifecycleTransitionHandler(lifecycleHandlers, {
			manifest,
			transition,
			issue,
			tracker: lifecycleHandlerTracker(tracker),
			event: "start",
			input: {},
		});
		if (handler.ok !== true) {
			return handler;
		}
		const target = workflowTarget(transition.to);
		const log: TrackerLog = {
			type: "action_started",
			message: stableStringify({
				event: "start",
				to: cleanTransitionTarget(transition.to),
			}),
		};
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: target,
				},
				{ type: "record-command", issue: { id }, log },
				...handler.contribution.effects,
			],
		});
		return success({
			issue: result.issues[id] ?? (await tracker.getIssue(id)),
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}

export async function terminalCommand(
	event: "succeed" | "fail",
	id: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	lifecycleHandlers?: LifecycleTransitionHandlers,
): Promise<Envelope> {
	if (id === undefined) {
		return failure(
			runtimeFailures.invalidArguments({
				usage: `awf ${event} <id> [--input <file|->]`,
			}),
		);
	}

	try {
		const parsedInput =
			inputPath === undefined
				? undefined
				: parseJsonInput(
						await readInput(inputPath, stdin),
						runtimeFailures.INVALID_ACTION_INPUT,
					);
		if (parsedInput?.ok === false) {
			return parsedInput;
		}
		const parsedInputJson =
			parsedInput === undefined
				? undefined
				: parsePayloadValue(parsedInput.data, undefined, "$");
		if (parsedInputJson?.issues.length) {
			return failure(
				runtimeFailures.invalidActionInput({ issues: parsedInputJson.issues }),
			);
		}
		const logType = terminalLogType(event);
		const issue = await tracker.getIssue(id);
		if (!isWorkflowActive(issue.workflow, manifest)) {
			return failure(
				runtimeFailures.invalidTransition({
					message: "Terminal transition must leave a manifest active state.",
					id,
					event,
				}),
			);
		}
		const transition = findTransition(manifest, issue.workflow, event);
		const retryTarget =
			event === "fail" && transition === undefined
				? defaultRetryTarget(issue.workflow)
				: undefined;
		if (transition === undefined && retryTarget === undefined) {
			return invalidTransition(id, event);
		}
		const terminalInput = parseJsonValue(parsedInputJson?.value ?? {});
		const target =
			retryTarget ??
			(transition === undefined ? undefined : workflowTarget(transition.to));
		if (target === undefined) {
			return invalidTransition(id, event);
		}
		if (lifecycleHandlers === undefined) {
			const log: TrackerLog = {
				type: logType,
				message: stableStringify({
					event,
					...(parsedInput === undefined ? {} : { input: terminalInput }),
					to: target,
				}),
			};
			const result = await tracker.applyWorkflowEffects({
				effects: [
					{
						type: "update-workflow",
						issue: { id },
						expect: {
							version: issue.workflow.version,
							hash: issue.workflow.hash,
						},
						workflow: target,
					},
					{ type: "record-command", issue: { id }, log },
				],
			});
			const updated = result.issues[id] ?? (await tracker.getIssue(id));
			await progressRelationshipsAfterLifecycleTransition(
				tracker,
				manifest,
				issue,
				updated,
			);
			return success({
				issue: updated,
				log: result.logs[0],
			});
		}
		const handler =
			transition === undefined
				? { ok: true as const, contribution: emptyLifecycleContribution() }
				: await runLifecycleTransitionHandler(lifecycleHandlers, {
						manifest,
						transition,
						issue,
						tracker: lifecycleHandlerTracker(tracker),
						event,
						input: terminalInput,
					});
		if (handler.ok !== true) {
			return handler;
		}
		const log: TrackerLog = {
			type: logType,
			message: stableStringify({
				event,
				...(parsedInput === undefined ? {} : { input: terminalInput }),
				to: target,
			}),
		};
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: target,
				},
				{ type: "record-command", issue: { id }, log },
				...handler.contribution.effects,
			],
		});
		const updated = result.issues[id] ?? (await tracker.getIssue(id));
		await progressRelationshipsAfterLifecycleTransition(
			tracker,
			manifest,
			issue,
			updated,
		);
		return success({
			issue: updated,
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(id, error);
	}
}

function lifecycleHandlerTracker(
	tracker: Tracker,
): TrackerAdapterPrimitiveReads {
	const reads: TrackerAdapterPrimitiveReads = {
		getIssue: (id) => tracker.getIssue(id),
		listIssues: () => tracker.listIssues(),
		readLogs: (id) => tracker.readLogs(id),
	};
	const inspectIssue = tracker.inspectIssue;
	if (inspectIssue !== undefined) {
		reads.inspectIssue = (id) => inspectIssue(id);
	}
	return reads;
}

function emptyLifecycleContribution(): { effects: [] } {
	return { effects: [] };
}
