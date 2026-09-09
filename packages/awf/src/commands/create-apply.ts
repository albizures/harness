import type { JsonValue } from "type-fest";
import type { CommandHandlers } from "../command-handlers.ts";
import { failure, success, type Envelope } from "../envelope.ts";
import type { LifecycleTransitionHandlers } from "../lifecycle-handlers.ts";
import type {
	ManifestCommand,
	WorkflowManifest,
} from "../manifest/manifest.ts";
import type { CreateIssueInput } from "../workflow/issue.ts";
import {
	NeedReconciliationError,
	type Tracker,
	type TrackerApplyWorkflowEffectsIntent,
	type TrackerIssueRef,
	type TrackerWorkflowEffect,
} from "../tracker.ts";
import {
	escalateCommand,
	pauseCommand,
	respondCommand,
	resumeCommand,
	startCommand,
	terminalCommand,
} from "./lifecycle.ts";
import {
	genericIssueBody,
	genericIssueTitle,
	initialWorkflowTarget,
	invalidTransition,
	isRecord,
	lifecycleError,
	parseJsonInput,
	parseWorkflowCommandInput,
	progressRelationshipsAfterLifecycleTransition,
	readInput,
	workflowCommand,
	workflowCommandByCli,
	readOption,
	stableStringify,
	workflowTarget,
} from "./shared.ts";

export async function manifestCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	commandHandlers: CommandHandlers = {},
	lifecycleHandlers?: LifecycleTransitionHandlers,
): Promise<Envelope> {
	const [verb, target] = args;
	const command =
		verb === "run-command"
			? workflowCommand(manifest, target ?? "")
			: workflowCommandByCli(manifest, verb ?? "", target);
	if (command === undefined) {
		return failure(
			verb === "run-command" ? "UNKNOWN_COMMAND" : "UNKNOWN_COMMAND_TARGET",
			verb === "run-command"
				? "Unknown command."
				: "Workflow command target is not declared by the manifest.",
			{
				command: verb === "run-command" ? args.join(" ") : `${verb} ${target}`,
			},
		);
	}
	const versionedTracker = workflowVersionTracker(tracker, manifest);
	const lifecycle = await manifestLifecycleCommand(
		args,
		versionedTracker,
		manifest,
		stdin,
		command,
		lifecycleHandlers,
	);
	if (lifecycle !== undefined) {
		return lifecycle;
	}
	const handler = commandHandlers[command.id];
	if (handler === undefined && command.transition !== undefined) {
		return transitionGenericWorkflowCommand(
			args[2],
			versionedTracker,
			manifest,
			command,
		);
	}
	if (handler !== undefined) {
		return handledManifestCommand(
			args,
			versionedTracker,
			manifest,
			stdin,
			command,
			handler,
		);
	}
	const effectiveVerb = verb === "run-command" ? command.cli?.verb : verb;
	if (effectiveVerb === "create") {
		return createGenericWorkflowIssueCommand(
			readOption(args, "--input"),
			versionedTracker,
			manifest,
			stdin,
			command,
		);
	}
	if (effectiveVerb === "apply") {
		return applyGenericWorkflowCommand(
			args[2],
			readOption(args, "--input"),
			versionedTracker,
			stdin,
			command,
		);
	}
	return failure(
		"COMMAND_HANDLER_REQUIRED",
		"Manifest command requires a command handler.",
		{
			command: command.id,
		},
	);
}

async function manifestLifecycleCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	command: ManifestCommand,
	lifecycleHandlers?: LifecycleTransitionHandlers,
): Promise<Envelope | undefined> {
	if (args[0] !== "run-command") {
		return undefined;
	}
	if (command.transition !== undefined) {
		return undefined;
	}
	const shifted = [command.id, ...args.slice(2)];
	if (command.id === "start") {
		return startCommand(shifted[1], tracker, manifest, lifecycleHandlers);
	}
	if (command.id === "succeed" || command.id === "fail") {
		return terminalCommand(
			command.id,
			shifted[1],
			readOption(shifted, "--input"),
			tracker,
			manifest,
			stdin,
			lifecycleHandlers,
		);
	}
	if (command.id === "pause") {
		return pauseCommand(
			shifted[1],
			readOption(shifted, "--input"),
			tracker,
			stdin,
		);
	}
	if (command.id === "respond") {
		return respondCommand(
			shifted[1],
			readOption(shifted, "--input"),
			tracker,
			manifest,
			stdin,
		);
	}
	if (command.id === "escalate") {
		return escalateCommand(
			shifted[1],
			readOption(shifted, "--input"),
			tracker,
			manifest,
			stdin,
		);
	}
	if (command.id === "resume") {
		return resumeCommand(
			shifted[1],
			readOption(shifted, "--action"),
			tracker,
			manifest,
		);
	}
	return undefined;
}

async function handledManifestCommand(
	args: Array<string>,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	command: ManifestCommand,
	handler: NonNullable<CommandHandlers[string]>,
): Promise<Envelope> {
	if (handler.rawInput === true) {
		try {
			const result = await handler({
				command,
				manifest,
				tracker,
				input: null,
				args,
				...(stdin === undefined ? {} : { stdin }),
			});
			if (isEnvelope(result)) {
				return result.ok
					? validateHandlerSuccess(command, result.data)
					: result;
			}
			return validateHandlerSuccess(command, result);
		} catch (error) {
			return lifecycleError("new", error);
		}
	}
	const routeVerb = args[0] ?? command.cli?.verb ?? "run-command";
	const commandVerb =
		routeVerb === "run-command" ? (command.cli?.verb ?? routeVerb) : routeVerb;
	const issueId = commandVerb === "create" ? undefined : args[2];
	const inputPath = readOption(args, "--input");
	if (
		inputPath === undefined ||
		(commandVerb !== "create" && issueId === undefined)
	) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage:
				commandVerb === "create"
					? `awf ${routeVerb} ${command.cli?.target ?? command.id} --input <file|->`
					: `awf ${routeVerb} ${command.cli?.target ?? command.id} <issue> --input <file|->`,
		});
	}
	const raw = await readInput(inputPath, stdin);
	const parsed = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsed.ok) {
		return parsed;
	}
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	try {
		const result = await handler({
			command,
			manifest,
			tracker,
			input: payload.data,
			...(issueId === undefined ? {} : { issueId }),
		});
		if (isEnvelope(result)) {
			if (!result.ok) {
				return result;
			}
			return validateHandlerSuccess(command, result.data);
		}
		return validateHandlerSuccess(command, result);
	} catch (error) {
		return lifecycleError(issueId ?? "new", error);
	}
}

function validateHandlerSuccess(
	_command: ManifestCommand,
	data: JsonValue,
): Envelope {
	return success(data);
}

function isEnvelope(value: unknown): value is Envelope {
	return isRecord(value) && typeof value.ok === "boolean";
}

function workflowVersionTracker(
	tracker: Tracker,
	manifest: WorkflowManifest,
): Tracker {
	const semanticVersion = manifest.workflow.version;
	const overrides: Partial<Tracker> = {
		createWorkflowIssue: (input) =>
			tracker.createWorkflowIssue({
				...input,
				workflow: withWorkflowSemanticVersion(input.workflow, semanticVersion),
			}),
		applyWorkflowEffects: async (input) => {
			await validateWorkflowEffectVersions(tracker, input, semanticVersion);
			return tracker.applyWorkflowEffects({
				effects: input.effects.map((effect) =>
					withWorkflowEffectSemanticVersion(effect, semanticVersion),
				),
			});
		},
		recordCommand: async (id, input) => {
			await validateIssueWorkflowSemanticVersion(tracker, id, semanticVersion);
			return tracker.recordCommand(id, input);
		},
		changeRelationship: async (input) => {
			if (input.type === "add-child" || input.type === "remove-child") {
				await validateIssueWorkflowSemanticVersion(
					tracker,
					input.parentId,
					semanticVersion,
				);
				await validateIssueWorkflowSemanticVersion(
					tracker,
					input.childId,
					semanticVersion,
				);
			} else {
				await validateIssueWorkflowSemanticVersion(
					tracker,
					input.issueId,
					semanticVersion,
				);
				await validateIssueWorkflowSemanticVersion(
					tracker,
					input.blockedById,
					semanticVersion,
				);
			}
			return tracker.changeRelationship(input);
		},
	};
	return new Proxy(tracker, {
		get(target, property, receiver) {
			const override = Reflect.get(overrides, property, overrides);
			if (override !== undefined) {
				return typeof override === "function"
					? override.bind(overrides)
					: override;
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Tracker;
}

function withWorkflowSemanticVersion<T extends CreateIssueInput["workflow"]>(
	workflow: T,
	semanticVersion: string,
): T {
	return { ...workflow, semanticVersion };
}

function withWorkflowEffectSemanticVersion(
	effect: TrackerWorkflowEffect,
	semanticVersion: string,
): TrackerWorkflowEffect {
	if (effect.type !== "create-workflow-issue") {
		return effect;
	}
	return {
		...effect,
		input: {
			...effect.input,
			workflow: withWorkflowSemanticVersion(
				effect.input.workflow,
				semanticVersion,
			),
		},
	};
}

async function validateWorkflowEffectVersions(
	tracker: Tracker,
	input: TrackerApplyWorkflowEffectsIntent,
	semanticVersion: string,
): Promise<void> {
	const createdIds = new Set<string>();
	const createdKeys = new Set<string>();
	for (const effect of input.effects) {
		if (effect.type === "create-workflow-issue") {
			if (effect.input.id !== undefined) {
				createdIds.add(effect.input.id);
			}
			if (effect.key !== undefined) {
				createdKeys.add(effect.key);
			}
			continue;
		}
		for (const ref of existingIssueRefs(effect)) {
			if ("id" in ref && !createdIds.has(ref.id)) {
				await validateIssueWorkflowSemanticVersion(
					tracker,
					ref.id,
					semanticVersion,
				);
			} else if ("key" in ref && !createdKeys.has(ref.key)) {
				throw new NeedReconciliationError(
					`NEED_RECONCILIATION: workflow issue key '${ref.key}' could not be resolved before version validation.`,
				);
			}
		}
	}
}

function existingIssueRefs(
	effect: Exclude<TrackerWorkflowEffect, { type: "create-workflow-issue" }>,
): Array<TrackerIssueRef> {
	if (effect.type === "update-workflow" || effect.type === "update-issue") {
		return [effect.issue];
	}
	if (effect.type === "record-command") {
		return [effect.issue];
	}
	if (effect.type === "add-child" || effect.type === "remove-child") {
		return [effect.parent, effect.child];
	}
	return [effect.issue, effect.blockedBy];
}

async function validateIssueWorkflowSemanticVersion(
	tracker: Tracker,
	id: string,
	loadedVersion: string,
): Promise<void> {
	const issue = await tracker.getIssue(id);
	const recordedVersion = issue.workflow.semanticVersion;
	if (recordedVersion !== undefined && recordedVersion !== loadedVersion) {
		throw new NeedReconciliationError(
			`NEED_RECONCILIATION: Issue '${id}' records workflow version '${recordedVersion}', but loaded workflow version is '${loadedVersion}'. Migrate or reconcile the workflow issue before proceeding.`,
		);
	}
}

export async function createGenericWorkflowIssueCommand(
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
	command: ManifestCommand,
): Promise<Envelope> {
	if (inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf create ${command.cli?.target ?? command.target.kind} --input <file|->`,
		});
	}
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === command.target.kind,
	);
	if (kind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest command kind is unknown.",
			{
				command: command.id,
				kind: command.target.kind,
			},
		);
	}
	const raw = await readInput(inputPath, stdin);
	const parsed = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsed.ok) {
		return parsed;
	}
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	try {
		const { issue, log } = await tracker.createWorkflowIssue({
			title: genericIssueTitle(payload.data, command.cli?.target ?? kind.id),
			body: genericIssueBody(payload.data, raw),
			workflow: { kind: kind.id, ...initialWorkflowTarget(kind.initial) },
			initialLog: {
				type: `${command.id}_created`,
				message: stableStringify({ input: payload.data }),
			},
		});
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		const data = { issue, log };
		return success(data);
	} catch (error) {
		return lifecycleError("new", error);
	}
}

async function transitionGenericWorkflowCommand(
	issueId: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	command: ManifestCommand,
): Promise<Envelope> {
	if (issueId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf ${command.cli?.verb ?? "run-command"} ${command.cli?.target ?? command.id} <issue>`,
		});
	}
	const transitionCommand = command.transition;
	if (transitionCommand === undefined) {
		return failure(
			"COMMAND_HANDLER_REQUIRED",
			"Manifest command requires a command handler.",
			{
				command: command.id,
			},
		);
	}
	try {
		const issue = await tracker.getIssue(issueId);
		if (!commandTargetMatches(command.target, issue.workflow)) {
			return failure(
				"UNAVAILABLE_COMMAND",
				"Workflow command target does not match the issue's current workflow fields.",
				{ id: issueId, command: command.id },
			);
		}
		const kind = manifest.kinds.find(
			(candidate) => candidate.id === issue.workflow.kind,
		);
		const transition = kind?.transitions.find(
			(candidate) =>
				candidate.event === transitionCommand.event &&
				candidate.from.state === issue.workflow.state &&
				candidate.from.action === issue.workflow.action &&
				candidate.from.reason === issue.workflow.reason,
		);
		if (transition === undefined) {
			return invalidTransition(issueId, transitionCommand.event);
		}
		const runEffect = transitionCommand.attempt ?? "none";
		const workflow = workflowTarget(transition.to);
		if (
			runEffect === "start" &&
			!manifest.lifecycle?.activeStates?.includes(transition.to.state)
		) {
			return failure(
				"INVALID_TRANSITION",
				"Transition start attempt must land in a manifest active state.",
				{ id: issueId, event: transitionCommand.event },
			);
		}
		if (
			runEffect === "complete" &&
			(!manifest.lifecycle?.activeStates?.includes(transition.from.state) ||
				manifest.lifecycle?.activeStates?.includes(transition.to.state))
		) {
			return failure(
				"INVALID_TRANSITION",
				"Transition complete attempt must leave a manifest active state.",
				{ id: issueId, event: transitionCommand.event },
			);
		}
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "update-workflow",
					issue: { id: issueId },
					expect: {
						version: issue.workflow.version,
						hash: issue.workflow.hash,
					},
					workflow,
				},
				{
					type: "record-command",
					issue: { id: issueId },
					log: {
						type: "command",
						message: transitionRunLogMessage(
							transitionCommand.event,
							runEffect,
						),
					},
				},
			],
		});
		const updated = result.issues[issueId] ?? (await tracker.getIssue(issueId));
		if (runEffect === "complete") {
			await progressRelationshipsAfterLifecycleTransition(
				tracker,
				manifest,
				issue,
				updated,
			);
		}
		return success({
			issue: updated,
			log: result.logs[0],
			outcome: "APPLIED",
		});
	} catch (error) {
		return lifecycleError(issueId, error);
	}
}

function transitionRunLogMessage(
	event: string,
	_runEffect: "none" | "start" | "complete",
): string {
	return `Applied ${event}.`;
}

function commandTargetMatches(
	target: ManifestCommand["target"],
	workflow: {
		kind: string;
		state: string;
		action?: string;
		reason?: string | null;
	},
): boolean {
	return (
		target.kind === workflow.kind &&
		(target.state === undefined || target.state === workflow.state) &&
		(target.action === undefined || target.action === workflow.action) &&
		(target.reason === undefined || target.reason === workflow.reason)
	);
}

export async function applyGenericWorkflowCommand(
	issueId: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	stdin: string | undefined,
	command: ManifestCommand,
): Promise<Envelope> {
	if (issueId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf apply ${command.cli?.target ?? command.target.action} <issue> --input <file|->`,
		});
	}
	const raw = await readInput(inputPath, stdin);
	const parsed = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsed.ok) {
		return parsed;
	}
	const payload = parseWorkflowCommandInput(command, parsed.data);
	if (!payload.ok) {
		return payload;
	}
	try {
		const issue = await tracker.getIssue(issueId);
		if (
			issue.workflow.kind !== command.target.kind ||
			issue.workflow.action !== command.target.action
		) {
			return invalidTransition(issueId, command.id);
		}
		const result = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "record-command",
					issue: { id: issueId },
					log: {
						type: `${command.id}_applied`,
						message: stableStringify({ input: payload.data }),
					},
				},
			],
		});
		const data = {
			issue: result.issues[issueId] ?? (await tracker.getIssue(issueId)),
			log: result.logs[0],
			outcome: "APPLIED",
		};
		return success(data);
	} catch (error) {
		return lifecycleError(issueId, error);
	}
}
