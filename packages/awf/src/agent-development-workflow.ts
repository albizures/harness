import { isAbsolute, relative } from "node:path";
import type {
	CommandHandlerContext,
	CommandHandlers,
} from "./command-handlers.ts";
import { failure, success, type Envelope } from "./envelope.ts";
import { defineManifest, type ManifestCommand } from "./manifest.ts";
import { NeedReconciliationError, type Tracker } from "./tracker.ts";
import { artifacts } from "./workflow/artifact.ts";
import { IssueNotFoundError } from "./workflow/issue.ts";
import { z } from "zod";
import {
	initialWorkflowTarget,
	invalidTransition,
	isRecord,
	lifecycleError,
	parseJsonInput,
	parsePlanInput,
	parseSpecInput,
	parseStructuredArtifactInput,
	planApplicationTarget,
	readInput,
	readOption,
	validatePlanPayload,
	validateWorkflowCommandInput,
	validateWorkflowCommandOutput,
	workflowTarget,
} from "./commands/shared.ts";

const states = ["ready", "running", "done", "need-human"] as const;
const actions = [
	"plan",
	"implement",
	"review",
	"fix",
	"merge",
	"integration-test",
	"none",
] as const;

const ticketImplementationInput = artifacts.object({
	implementationPr: artifacts.pullRequest(),
});

const reviewApprovedInput = artifacts.object({ verdict: z.string() });

const reviewChangesInput = artifacts.object({
	verdict: z.string(),
	findings: artifacts.array(artifacts.finding()),
});

const fixInput = artifacts.object({ summary: z.string() });

const integrationPassedInput = artifacts.object({
	verdict: z.string(),
	specPr: artifacts.pullRequest(),
});

const integrationChangesNeededInput = artifacts.object({
	verdict: z.string(),
	findings: artifacts.array(artifacts.finding()),
});

const mergeInput = artifacts.object({ merged: z.boolean() });
const specCreateInput = artifacts.object({ spec: artifacts.markdown() });
const specCreateOutput = z.looseObject({
	issue: z.looseObject({ id: z.string() }),
});

const planTicketInput = artifacts.object({
	key: z.string(),
	title: z.string(),
	content: z.string(),
	dependsOn: z.array(z.string()).optional(),
});

const planApplyInput = artifacts.object({
	tickets: artifacts.array(planTicketInput),
});
const planApplyOutput = z.looseObject({
	tickets: artifacts.array(
		artifacts.object({ key: z.string(), id: z.string() }),
	),
});

const handoffCreateInput = artifacts.object({ handoff: artifacts.handoff() });
const handoffCreateOutput = z.looseObject({
	artifact: z.looseObject({
		id: z.string(),
		kind: z.literal("handoff"),
		type: z.literal("handoff"),
		uri: z.string(),
		ref: z.string(),
	}),
});

export const agentDevelopmentManifest = defineManifest({
	version: "v1",
	workflow: { id: "agent-development" },
	vocabulary: {
		states: [...states],
		actions: [...actions],
		reasons: ["dependencies"],
		events: ["start", "succeed", "fail"],
	},
	github: { reservedPrefix: "awf" },
	concurrency: { perIssue: 1, perWorkflow: 4, perKind: { ticket: 3 } },
	readiness: {
		filters: [
			{ kind: "spec", state: "ready", action: "plan" },
			{ kind: "spec", state: "ready", action: "integration-test" },
			{ kind: "spec", state: "ready", action: "merge" },
			{ kind: "ticket", state: "ready", action: "implement" },
			{ kind: "ticket", state: "ready", action: "review" },
			{ kind: "ticket", state: "ready", action: "fix" },
			{ kind: "ticket", state: "ready", action: "merge" },
		],
		namedFilters: [{ name: "spec", kind: "spec", relationship: "parent" }],
	},
	kinds: [
		{
			id: "spec",
			label: "Spec",
			initial: { state: "ready", action: "plan" },
			transitions: [
				{
					from: { state: "ready", action: "plan" },
					event: "start",
					to: { state: "running", action: "plan" },
				},
				{
					from: { state: "ready", action: "plan" },
					event: "succeed",
					to: { state: "ready", action: "none" },
				},
				{
					from: { state: "running", action: "plan" },
					event: "succeed",
					to: { state: "ready", action: "none" },
				},
				{
					from: { state: "ready", action: "integration-test" },
					event: "start",
					to: { state: "running", action: "integration-test" },
				},
				{
					from: { state: "running", action: "integration-test" },
					event: "succeed",
					input: integrationPassedInput,
					to: { state: "ready", action: "merge" },
				},
				{
					from: { state: "running", action: "integration-test" },
					event: "fail",
					input: integrationChangesNeededInput,
					to: { state: "ready", action: "plan" },
				},
				{
					from: { state: "ready", action: "merge" },
					event: "start",
					to: { state: "running", action: "merge" },
				},
				{
					from: { state: "running", action: "merge" },
					event: "succeed",
					input: mergeInput,
					to: { state: "done", action: "none" },
				},
			],
		},
		{
			id: "ticket",
			label: "Ticket",
			initial: { state: "ready", action: "implement" },
			transitions: [
				{
					from: { state: "ready", action: "implement" },
					event: "start",
					to: { state: "running", action: "implement" },
				},
				{
					from: { state: "running", action: "implement" },
					event: "succeed",
					input: ticketImplementationInput,
					to: { state: "ready", action: "review" },
				},
				{
					from: { state: "ready", action: "review" },
					event: "start",
					to: { state: "running", action: "review" },
				},
				{
					from: { state: "running", action: "review" },
					event: "succeed",
					input: reviewApprovedInput,
					to: { state: "ready", action: "merge" },
				},
				{
					from: { state: "running", action: "review" },
					event: "fail",
					input: reviewChangesInput,
					to: { state: "ready", action: "fix" },
				},
				{
					from: { state: "ready", action: "fix" },
					event: "start",
					to: { state: "running", action: "fix" },
				},
				{
					from: { state: "running", action: "fix" },
					event: "succeed",
					input: fixInput,
					to: { state: "ready", action: "review" },
				},
				{
					from: { state: "ready", action: "merge" },
					event: "start",
					to: { state: "running", action: "merge" },
				},
				{
					from: { state: "running", action: "merge" },
					event: "succeed",
					input: mergeInput,
					to: { state: "done", action: "none" },
				},
				{
					from: { state: "running", action: "implement" },
					event: "fail",
					to: { state: "ready", action: "implement" },
				},
			],
		},
	],
	commands: [
		{
			id: "spec-create",
			cli: { verb: "create", target: "spec" },
			target: { kind: "spec", action: "plan" },
			input: specCreateInput,
			output: specCreateOutput,
		},
		{
			id: "plan-apply",
			cli: { verb: "apply", target: "plan" },
			target: { kind: "spec", action: "plan" },
			input: planApplyInput,
			output: planApplyOutput,
		},
		{
			id: "handoff-create",
			cli: { verb: "create", target: "handoff" },
			target: { kind: "ticket", action: "review" },
			input: handoffCreateInput,
			output: handoffCreateOutput,
		},
	],
	relationships: [
		{
			id: "spec-tickets",
			from: "spec",
			to: "ticket",
			projection: { type: "parent-child", direction: "outbound" },
		},
		{
			id: "ticket-dependencies",
			from: "ticket",
			to: "ticket",
			projection: { type: "dependency", direction: "outbound" },
		},
	],
});

export const agentDevelopmentCommandHandlers: CommandHandlers = {
	"spec-create": rawCommandHandler(createSpecCommand),
	"handoff-create": rawCommandHandler(createHandoffCommand),
	"plan-apply": rawCommandHandler(applyPlanCommand),
};

export const manifest = agentDevelopmentManifest;
export const commandHandlers = agentDevelopmentCommandHandlers;

function rawCommandHandler(
	handler: (context: RawContext) => Promise<Envelope>,
): CommandHandlers[string] {
	return Object.assign(
		(context: CommandHandlerContext) =>
			handler({
				...context,
				args: context.args ?? [],
				stdin: context.stdin,
			}),
		{ rawInput: true as const },
	);
}

async function createSpecCommand({
	args,
	tracker,
	manifest,
	stdin,
	command,
}: RawContext): Promise<Envelope> {
	const inputPath = readOption(args, "--input");
	if (inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf create spec --input <file|->",
		});
	}
	const kind = manifest.kinds.find((candidate) => candidate.id === "spec");
	if (kind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define spec kind.",
		);
	}
	const raw = await readInput(inputPath, stdin);
	const inputValidation = validateWorkflowCommandInput(command, {
		spec: { type: "markdown", ref: raw },
	});
	if (inputValidation !== undefined) {
		return inputValidation;
	}
	const spec = parseSpecInput(raw);
	if (spec.content.trim() === "") {
		return failure("INVALID_SPEC", "Spec content must be non-empty.");
	}
	try {
		const applied = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "create-workflow-issue",
					input: {
						title: spec.title,
						body: spec.content,
						workflow: { kind: "spec", ...initialWorkflowTarget(kind.initial) },
					},
					initialLog: { type: "spec_created", payload: { input: inputPath } },
				},
			],
		});
		const created = applied.createdIssues[0];
		if (created === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow issue creation could not be verified.",
			);
		}
		const log = applied.logs[0];
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: creation log was not recorded.",
			);
		}
		return validateOrSucceed(command, { issue: created.issue, log });
	} catch (error) {
		return lifecycleError("new", error);
	}
}

async function createHandoffCommand({
	args,
	tracker,
	stdin,
	command,
}: RawContext): Promise<Envelope> {
	const sourceId = readOption(args, "--source");
	const inputPath = readOption(args, "--input");
	if (sourceId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf create handoff --source <issue> --input <handoff.json>",
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
	const inputValidation = validateWorkflowCommandInput(command, parsed.data);
	if (inputValidation !== undefined) {
		return inputValidation;
	}
	if (!isRecord(parsed.data)) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
			{ issues: [{ path: "$.handoff", message: "Value is required." }] },
		);
	}
	const artifactInput = parseStructuredArtifactInput(
		parsed.data.handoff,
		"handoff",
		"Handoff",
		"$.handoff",
	);
	if (artifactInput.issue !== undefined || artifactInput.value === undefined) {
		return failure(
			"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
			"Workflow command input is invalid.",
			{
				issues: [
					artifactInput.issue ?? {
						path: "$.handoff",
						message: "Value is required.",
					},
				],
			},
		);
	}
	try {
		await tracker.getIssue(sourceId);
		const applied = await tracker.applyWorkflowEffects({
			effects: [
				{
					type: "record-artifacts",
					issue: { id: sourceId },
					artifacts: [artifactInput.value],
					log: {
						type: "handoff_created",
						payload: {
							input: parsed.data as never,
							artifact: artifactInput.value,
						},
					},
				},
			],
		});
		const artifact = applied.artifacts[0]?.artifact;
		if (artifact === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: handoff artifact was not recorded.",
			);
		}
		const log = applied.logs[0];
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow log addition could not be verified.",
			);
		}
		return validateOrSucceed(command, { source: sourceId, artifact, log });
	} catch (error) {
		return lifecycleError(sourceId, error);
	}
}

async function applyPlanCommand({
	args,
	tracker,
	manifest,
	stdin,
	command,
}: RawContext): Promise<Envelope> {
	const specId = args[2];
	const inputPath = readOption(args, "--input");
	if (specId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf apply plan <spec> --input <file|->",
		});
	}
	const raw = await readInput(inputPath, stdin);
	const parsedInput = parseJsonInput(
		raw,
		"WORKFLOW_COMMAND_INPUT_VALIDATION_FAILED",
	);
	if (!parsedInput.ok) {
		return parsedInput;
	}
	const inputValidation = validateWorkflowCommandInput(
		command,
		parsedInput.data,
	);
	if (inputValidation !== undefined) {
		return inputValidation;
	}
	let spec: Awaited<ReturnType<Tracker["getIssue"]>>;
	try {
		spec = await tracker.getIssue(specId);
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id: specId });
		}
		throw error;
	}
	if (spec.workflow.kind !== "spec" || spec.workflow.action !== "plan") {
		return invalidTransition(specId, "apply-plan");
	}
	const validationIssues = validatePlanPayload(parsedInput.data);
	if (validationIssues.length > 0) {
		return failure("INVALID_PLAN", "Plan bundle is invalid.", {
			issues: validationIssues,
		});
	}
	const plan = parsePlanInput(raw);
	const ticketKind = manifest.kinds.find((kind) => kind.id === "ticket");
	if (ticketKind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define ticket kind.",
		);
	}
	const target = planApplicationTarget(manifest, spec.workflow);
	if (target === undefined) {
		return invalidTransition(specId, "apply-plan");
	}
	try {
		const effects = [
			...plan.tickets.flatMap((ticket) => [
				{
					type: "create-workflow-issue" as const,
					key: ticket.key,
					input: {
						title: ticket.title,
						body: ticket.content,
						workflow: {
							kind: "ticket",
							...initialWorkflowTarget(ticketKind.initial),
						},
					},
				},
				{
					type: "add-child" as const,
					parent: { id: specId },
					child: { key: ticket.key },
				},
			]),
			...plan.tickets.flatMap((ticket) =>
				(ticket.dependsOn ?? []).map((dependencyKey) => ({
					type: "add-dependency" as const,
					issue: { key: ticket.key },
					blockedBy: { key: dependencyKey },
				})),
			),
			{
				type: "update-workflow" as const,
				issue: { id: specId },
				expect: { version: spec.workflow.version, hash: spec.workflow.hash },
				workflow: { ...workflowTarget(target), activeRunId: undefined },
			},
			{
				type: "record-artifacts" as const,
				issue: { id: specId },
				artifacts: [planBundleArtifactInput(inputPath, plan.tickets.length)],
				log: {
					type: "plan_applied",
					payload: {
						input: planBundleArtifactReference(inputPath, plan.tickets.length),
					},
				},
			},
		];
		const applied = await tracker.applyWorkflowEffects({ effects });
		const tickets = plan.tickets.map((ticket) => {
			const created = applied.createdIssues.find(
				(issue) => issue.key === ticket.key,
			);
			if (created === undefined) {
				throw new NeedReconciliationError(
					"NEED_RECONCILIATION: workflow issue creation could not be verified.",
				);
			}
			return { key: ticket.key, id: created.id };
		});
		const artifact = applied.artifacts[0]?.artifact;
		if (artifact === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: plan bundle artifact was not recorded.",
			);
		}
		const log = applied.logs.at(-1);
		if (log === undefined) {
			throw new NeedReconciliationError(
				"NEED_RECONCILIATION: workflow log addition could not be verified.",
			);
		}
		return validateOrSucceed(command, {
			outcome: "SUCCESS",
			spec: applied.issues[specId] ?? (await tracker.getIssue(specId)),
			tickets,
			artifact,
			log,
		});
	} catch (error) {
		return lifecycleError(specId, error);
	}
}

type RawContext = CommandHandlerContext & {
	args: Array<string>;
	stdin: string | undefined;
};

function validateOrSucceed(
	command: ManifestCommand,
	data: Parameters<typeof success>[0],
): Envelope {
	const outputValidation = validateWorkflowCommandOutput(command, data);
	return outputValidation ?? success(data);
}

type PlanBundleArtifactReference =
	| {
			type: "inline";
			ref: string;
			title: string;
			metadata: { ticketCount: number };
	  }
	| {
			type: "file";
			path: string;
			title: string;
			metadata: { ticketCount: number };
	  };

function planBundleArtifactInput(inputPath: string, ticketCount: number) {
	const reference = planBundleArtifactReference(inputPath, ticketCount);
	return {
		...reference,
		kind: reference.type,
		uri: reference.type === "file" ? reference.path : reference.ref,
		name: "Plan bundle",
	};
}

function planBundleArtifactReference(
	inputPath: string,
	ticketCount: number,
): PlanBundleArtifactReference {
	if (inputPath === "-") {
		return {
			type: "inline",
			ref: "submitted-plan-bundle",
			title: "Submitted plan bundle",
			metadata: { ticketCount },
		};
	}
	return {
		type: "file",
		path: workflowArtifactFilePath(inputPath),
		title: "Submitted plan bundle",
		metadata: { ticketCount },
	};
}

function workflowArtifactFilePath(path: string): string {
	return isAbsolute(path) ? relative(process.cwd(), path) : path;
}
