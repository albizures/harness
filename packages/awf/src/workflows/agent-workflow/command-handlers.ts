import type { JsonValue } from "type-fest";
import type {
	CommandHandler,
	CommandHandlerContext,
	CommandHandlers,
} from "../../runtime/command-handlers.ts";
import { type Envelope, failure, success } from "../../runtime/envelope.ts";
import { getKind, type ManifestCommand } from "../../domain/manifest/schema.ts";
import { NeedReconciliationError, type Tracker } from "../../ports/tracker.ts";
import type { WorkflowIssue } from "../../domain/workflow/issue.ts";
import {
	genericIssueTitle,
	initialWorkflowTarget,
	isRecord,
	lifecycleError,
	stableStringify,
	workflowTarget,
} from "../../runtime/commands/shared.ts";
import { humanInteractionCommandHandlers } from "../human-interaction-handlers.ts";

type CreateInput = {
	title: string;
	body?: string;
	content?: string;
	parent?: string;
};

type TaskCreateInput = {
	parent: string;
	spec?: string;
	title: string;
	description: string;
	profile: string;
	subkind: "work" | "research" | "prototype";
	dependsOn?: Array<string>;
	generatedBy?: string;
};

type GrillingCreateInput = {
	title: string;
	description: string;
	parent?: string;
};

const createSpecCommand: CommandHandler = specCreateCommand;
const completeSpecCommand: CommandHandler = specCompleteCommand;
completeSpecCommand.rawInput = true;
const createTaskCommand: CommandHandler = taskCreateCommand;
const createGrillingCommand: CommandHandler = grillingCreateCommand;

export const agentWorkflowCommandHandlers: CommandHandlers = {
	...humanInteractionCommandHandlers(),
	"spec-create": createSpecCommand,
	"spec-complete": completeSpecCommand,
	"task-create": createTaskCommand,
	"grilling-create": createGrillingCommand,
};

async function specCreateCommand(
	context: CommandHandlerContext,
): Promise<Envelope> {
	const { command, manifest, tracker, input } = context;

	const specKind = getKind(manifest, "spec");
	if (specKind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define spec kind.",
		);
	}

	const specInput = parseCreateInput(input);
	if (specInput === undefined) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
		);
	}

	try {
		const parent =
			specInput.parent === undefined
				? undefined
				: await tracker.getIssue(specInput.parent);
		if (parent !== undefined && parent.workflow.kind !== "wayfinder") {
			return failure(
				"INVALID_SPEC_PARENT",
				"Spec parent must be a Wayfinder issue.",
				{ parent: parent.id, actualKind: parent.workflow.kind },
			);
		}

		const applied = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "create-workflow-issue",
					key: "spec",
					input: {
						title: genericIssueTitle(specInput, "spec"),
						body: specInput.content ?? specInput.body,
						workflow: {
							kind: "spec",
							...initialWorkflowTarget(specKind.initial),
						},
					},
					initialLog: {
						type: `${command.id}_created`,
						message: stableStringify({ input: specInput }),
					},
				},
				...(parent === undefined
					? []
					: [
							{
								type: "add-child" as const,
								parent: { id: parent.id },
								child: { key: "spec" },
							},
						]),
			],
		});
		const created = applied.createdIssues[0];
		if (created === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow issue creation could not be verified.",
			);
		}
		const issue = await tracker.getIssue(created.id);
		const log = applied.logs[0];
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		return validateOrSucceed(command, { issue, log });
	} catch (error) {
		return lifecycleError("new", error);
	}
}

async function specCompleteCommand({
	args = [],
	tracker,
}: Parameters<CommandHandler>[0]): Promise<Envelope> {
	const issueId = args[2];
	if (issueId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid arguments.", {
			usage: "awf spec complete <issue>",
		});
	}
	try {
		const issue = await tracker.getIssue(issueId);
		if (
			issue.workflow.kind !== "spec" ||
			issue.workflow.state !== "ready" ||
			issue.workflow.action !== "none"
		) {
			return failure(
				"UNAVAILABLE_COMMAND",
				"Workflow command is not available for the issue's current workflow state.",
				{ id: issue.id, command: "spec-complete" },
			);
		}
		const blockers = await specCompletionBlockers(issue, tracker);
		if (blockers.length > 0) {
			return failure(
				"SPEC_COMPLETION_INVALID",
				"Spec completion requires all child Tasks terminal, at least one Merge Task done, and no open child Grilling issues.",
				{ id: issue.id, blockedBy: blockers },
			);
		}
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id: issue.id },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow: workflowTarget({ state: "done", action: "none" }),
				},
				{
					type: "record-command",
					issue: { id: issue.id },
					log: {
						type: "command",
						message: stableStringify({
							event: "complete",
							to: { state: "done", action: "none" },
						}),
					},
				},
			],
		});
		return success({
			issue: result.issues[issue.id] ?? (await tracker.getIssue(issue.id)),
			log: result.logs[0],
		});
	} catch (error) {
		return lifecycleError(issueId, error);
	}
}

async function specCompletionBlockers(
	issue: WorkflowIssue,
	tracker: Tracker,
): Promise<Array<Record<string, JsonValue>>> {
	if (issue.workflow.kind !== "spec") {
		return [{ id: issue.id, reason: "not-spec", workflow: issue.workflow }];
	}
	const blockers: Array<Record<string, JsonValue>> = [];
	let doneMergeTasks = 0;
	for (const childId of issue.relationships.children) {
		const child = await tracker.getIssue(childId);
		if (child.workflow.kind === "task") {
			if (
				child.workflow.data?.profile === "merge" &&
				child.workflow.state === "done"
			) {
				doneMergeTasks += 1;
			}
			if (child.workflow.state !== "done") {
				blockers.push({
					id: child.id,
					title: child.title,
					workflow: child.workflow,
				});
			}
		}
		if (child.workflow.kind === "grilling" && child.workflow.state !== "done") {
			blockers.push({
				id: child.id,
				title: child.title,
				workflow: child.workflow,
			});
		}
	}
	if (doneMergeTasks === 0) {
		blockers.push({ gate: "merge-done", minimum: 1 });
	}
	return blockers;
}

async function taskCreateCommand({
	command,
	manifest,
	tracker,
	input,
}: Parameters<CommandHandler>[0]): Promise<Envelope> {
	const taskKind = getKind(manifest, "task");
	if (taskKind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define task kind.",
		);
	}
	const taskInput = parseTaskCreateInput(input);
	if (taskInput === undefined) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
		);
	}

	try {
		const parent = await tracker.getIssue(taskInput.parent);
		if (
			parent.workflow.kind !== "spec" &&
			parent.workflow.kind !== "wayfinder"
		) {
			return failure(
				"INVALID_TASK_PARENT",
				"Task parent must be a Spec or Wayfinder issue.",
				{
					parent: taskInput.parent,
					actualKind: parent.workflow.kind,
				},
			);
		}

		const blockers = await resolveTaskBlockers(
			tracker,
			taskInput.dependsOn ?? [],
		);
		const nonTaskBlocker = blockers.find(
			(blocker) => blocker.workflow.kind !== "task",
		);
		if (nonTaskBlocker !== undefined) {
			return failure(
				"INVALID_TASK_DEPENDENCY",
				"Task dependencies must be Task issues.",
				{
					dependency: nonTaskBlocker.id,
					actualKind: nonTaskBlocker.workflow.kind,
				},
			);
		}
		const generatedBy = await resolveGeneratedBy(
			tracker,
			taskInput.generatedBy,
			parent.id,
		);
		if (generatedBy.ok === false) {
			return generatedBy.envelope;
		}

		const applied = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "create-workflow-issue",
					key: "task",
					input: {
						title: genericIssueTitle(taskInput, "task"),
						body: taskBody(taskInput),
						workflow: {
							kind: "task",
							...initialWorkflowTarget(taskKind.initial),
							data: { subkind: taskInput.subkind, profile: taskInput.profile },
						},
						relationships:
							taskInput.generatedBy === undefined
								? undefined
								: { generatedBy: taskInput.generatedBy },
					},
					initialLog: {
						type: `${command.id}_created`,
						message: stableStringify({ input: taskInput }),
					},
				},
				{
					type: "add-child",
					parent: { id: parent.id },
					child: { key: "task" },
				},
				...blockers.map((blocker) => ({
					type: "add-dependency" as const,
					issue: { key: "task" },
					blockedBy: { id: blocker.id },
				})),
			],
		});
		const created = applied.createdIssues[0];
		if (created === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow issue creation could not be verified.",
			);
		}
		const issue = await tracker.getIssue(created.id);
		const log = applied.logs[0];
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		return validateOrSucceed(command, { issue, log });
	} catch (error) {
		return lifecycleError("new", error);
	}
}

async function grillingCreateCommand({
	command,
	manifest,
	tracker,
	input,
}: Parameters<CommandHandler>[0]): Promise<Envelope> {
	const grillingKind = getKind(manifest, "grilling");
	if (grillingKind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define grilling kind.",
		);
	}
	const grillingInput = parseGrillingCreateInput(input);
	if (grillingInput === undefined) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
		);
	}

	try {
		const parent =
			grillingInput.parent === undefined
				? undefined
				: await tracker.getIssue(grillingInput.parent);
		if (
			parent !== undefined &&
			parent.workflow.kind !== "spec" &&
			parent.workflow.kind !== "wayfinder"
		) {
			return failure(
				"INVALID_GRILLING_PARENT",
				"Grilling parent must be a Spec or Wayfinder issue.",
				{ parent: parent.id, actualKind: parent.workflow.kind },
			);
		}

		const createEffect = {
			type: "create-workflow-issue" as const,
			key: "grilling",
			input: {
				title: genericIssueTitle(grillingInput, "grilling"),
				body: grillingInput.description,
				workflow: {
					kind: "grilling",
					...initialWorkflowTarget(grillingKind.initial),
				},
			},
			initialLog: {
				type: `${command.id}_created`,
				message: stableStringify({ input: grillingInput }),
			},
		};
		const applied = await tracker.applyWorkflowEffects({
			effects: [
				createEffect,
				...(parent === undefined
					? []
					: [
							{
								type: "add-child" as const,
								parent: { id: parent.id },
								child: { key: "grilling" },
							},
						]),
			],
		});
		const created = applied.createdIssues[0];
		if (created === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow issue creation could not be verified.",
			);
		}
		const issue = await tracker.getIssue(created.id);
		const log = applied.logs[0];
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		return validateOrSucceed(command, { issue, log });
	} catch (error) {
		return lifecycleError("new", error);
	}
}

function parseCreateInput(input: JsonValue): CreateInput | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	return {
		title: String(input.title),
		...(typeof input.body === "string" ? { body: input.body } : {}),
		...(typeof input.content === "string" ? { content: input.content } : {}),
		...(typeof input.parent === "string" ? { parent: input.parent } : {}),
	};
}

function parseTaskCreateInput(input: JsonValue): TaskCreateInput | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	const parent =
		typeof input.parent === "string" ? input.parent : String(input.spec);
	return {
		parent,
		...(typeof input.spec === "string" ? { spec: input.spec } : {}),
		title: String(input.title),
		description: String(input.description),
		profile: String(input.profile),
		subkind: isTaskSubkind(input.subkind) ? input.subkind : "work",
		...(Array.isArray(input.dependsOn) &&
		input.dependsOn.every((dependency) => typeof dependency === "string")
			? { dependsOn: input.dependsOn }
			: {}),
		...(typeof input.generatedBy === "string"
			? { generatedBy: input.generatedBy }
			: {}),
	};
}

async function resolveTaskBlockers(
	tracker: Tracker,
	dependsOn: Array<string>,
): Promise<Array<WorkflowIssue>> {
	const blockers: Array<WorkflowIssue> = [];
	for (const dependency of dependsOn) {
		blockers.push(await tracker.getIssue(dependency));
	}
	return blockers;
}

async function resolveGeneratedBy(
	tracker: Tracker,
	generatedBy: string | undefined,
	specId: string,
): Promise<{ ok: true } | { ok: false; envelope: Envelope }> {
	if (generatedBy === undefined) {
		return { ok: true };
	}
	const source = await tracker.getIssue(generatedBy);
	if (source.workflow.kind !== "task") {
		return {
			ok: false,
			envelope: failure(
				"INVALID_TASK_GENERATED_BY",
				"Generated-by sources must be Task issues.",
				{ generatedBy: source.id, actualKind: source.workflow.kind },
			),
		};
	}
	if (source.relationships.parent !== specId) {
		return {
			ok: false,
			envelope: failure(
				"INVALID_TASK_GENERATED_BY",
				"Generated-by sources must belong to the same parent as the generated Task.",
				{
					generatedBy: source.id,
					parent: specId,
					...(source.relationships.parent === undefined
						? {}
						: { actualSpec: source.relationships.parent }),
				},
			),
		};
	}
	return { ok: true };
}

function isTaskSubkind(value: unknown): value is TaskCreateInput["subkind"] {
	return value === "work" || value === "research" || value === "prototype";
}

function parseGrillingCreateInput(
	input: JsonValue,
): GrillingCreateInput | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	return {
		title: String(input.title),
		description: String(input.description),
		...(typeof input.parent === "string" ? { parent: input.parent } : {}),
	};
}

function taskBody(input: TaskCreateInput): string {
	return `${input.description}\n\nProfile: ${input.profile}`;
}

function validateOrSucceed(
	_command: ManifestCommand,
	data: JsonValue,
): Envelope {
	return success(data);
}
