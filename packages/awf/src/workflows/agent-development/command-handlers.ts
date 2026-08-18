import { isAbsolute, relative } from "node:path";
import {
	readInput,
	type CommandHandler,
	type CommandHandlerContext,
	type CommandHandlers,
} from "../../command-handlers.ts";
import { type Envelope, failure, success } from "../../envelope.ts";
import { getKind, type ManifestCommand, type ManifestTransition } from "../../manifest.ts";
import { NeedReconciliationError, type Tracker } from "../../tracker.ts";
import {
	IssueNotFoundError,
	type WorkflowIssue,
} from "../../workflow/issue.ts";
import {
	initialWorkflowTarget,
	invalidTransition,
	isRecord,
	lifecycleError,
	parseJsonInput,
	parseJsonObject,
	parseStructuredArtifactInput,
	readOption,
	validateWorkflowCommandInput,
	validateWorkflowCommandOutput,
	workflowTarget,
} from "../../commands/shared.ts";
import { agentDevelopmentManifest } from "./manifest.ts";

type SpecInput = { title: string; content: string };
type PlanBundle = { tickets: Array<PlanTicket> };
type PlanTicket = {
	key: string;
	title: string;
	content: string;
	dependsOn?: Array<string>;
};

type Metadata = { ticketCount: number };

type PlanBundleArtifactReference =
	| {
			type: "inline";
			ref: string;
			title: string;
			metadata: Metadata;
	  }
	| {
			type: "file";
			path: string;
			title: string;
			metadata: Metadata;
	  };

export const agentDevelopmentCommandHandlers: CommandHandlers = {
	"spec-create": rawCommandHandler(createSpecCommand),
	"handoff-create": rawCommandHandler(createHandoffCommand),
	"plan-apply": rawCommandHandler(applyPlanCommand),
};

function rawCommandHandler(handler: CommandHandler): CommandHandlers[string] {
	handler.rawInput = true;

	return handler;
}

async function createSpecCommand(
	context: CommandHandlerContext,
): Promise<Envelope> {
	const { tracker, manifest, command } = context;

	const kind = getKind(manifest, 'spec')
	if (kind === undefined) {
		return failure(
			"MANIFEST_UNSUPPORTED",
			"Manifest does not define spec kind.",
		);
	}
	const [inputPath, raw] = await readInput(context);
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

async function createHandoffCommand(
	context: CommandHandlerContext,
): Promise<Envelope> {
	const { args = [], tracker, stdin, command } = context;
	const sourceId = readOption(args, "--source");
	if (sourceId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf create handoff --source <issue> --input <handoff.json>",
		});
	}
	const [, raw] = await readInput(context);
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

async function applyPlanCommand(
	context: CommandHandlerContext,
): Promise<Envelope> {
	const { args = [], tracker, manifest, stdin, command } = context;
	const specId = args[2];

	if (specId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf apply plan <spec> --input <file|->",
		});
	}

	const [inputPath, raw] = await readInput(context);
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
	const target = planApplicationTarget(spec.workflow);
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


function parseSpecInput(raw: string): SpecInput {
	const parsed = parseJsonObject(raw);
	if (parsed !== undefined) {
		const contentValue = parsed.content ?? parsed.body ?? parsed.markdown;
		const content = typeof contentValue === "string" ? contentValue : raw;
		return {
			title:
				typeof parsed.title === "string" && parsed.title.trim() !== ""
					? parsed.title
					: titleFromMarkdown(content),
			content,
		};
	}
	return { title: titleFromMarkdown(raw), content: raw };
}

function parsePlanInput(raw: string): PlanBundle {
	return parsePlanPayload(parseJsonObject(raw) ?? {});
}

function titleFromMarkdown(markdown: string): string {
	const heading = markdown
		.split(/\r?\n/u)
		.map((line) => line.match(/^#\s+(.+)$/u)?.[1]?.trim())
		.find((title) => title !== undefined && title !== "");
	return heading ?? "Spec";
}

function validatePlanPayload(
	payload: unknown,
): Array<{ path: string; message: string }> {
	const shapeIssues: Array<{ path: string; message: string }> = [];
	if (!isRecord(payload)) {
		return [{ path: "$", message: "Plan input must be an object." }];
	}
	if (!Array.isArray(payload.tickets)) {
		return [{ path: "$.tickets", message: "Plan tickets must be an array." }];
	}
	if (payload.tickets.length === 0) {
		shapeIssues.push({
			path: "$.tickets",
			message: "Plan must include at least one ticket.",
		});
	}
	for (const [index, ticket] of payload.tickets.entries()) {
		const path = `$.tickets[${index}]`;
		if (!isRecord(ticket)) {
			shapeIssues.push({ path, message: "Ticket must be an object." });
			continue;
		}
		if (typeof ticket.key !== "string") {
			shapeIssues.push({
				path: `${path}.key`,
				message: "Ticket key must be a string.",
			});
		}
		if (typeof ticket.title !== "string") {
			shapeIssues.push({
				path: `${path}.title`,
				message: "Ticket title must be a string.",
			});
		}
		if (ticket.content !== undefined && typeof ticket.content !== "string") {
			shapeIssues.push({
				path: `${path}.content`,
				message: "Ticket content must be a string.",
			});
		}
		if (ticket.body !== undefined && typeof ticket.body !== "string") {
			shapeIssues.push({
				path: `${path}.body`,
				message: "Ticket body must be a string.",
			});
		}
		if (ticket.dependsOn !== undefined) {
			if (!Array.isArray(ticket.dependsOn)) {
				shapeIssues.push({
					path: `${path}.dependsOn`,
					message: "Ticket dependsOn must be an array of ticket keys.",
				});
			} else {
				for (const [
					dependencyIndex,
					dependency,
				] of ticket.dependsOn.entries()) {
					if (typeof dependency !== "string") {
						shapeIssues.push({
							path: `${path}.dependsOn[${dependencyIndex}]`,
							message: "Dependency reference must be a string.",
						});
					}
				}
			}
		}
	}
	if (shapeIssues.length > 0) {
		return shapeIssues;
	}
	return validatePlan(parsePlanPayload(payload));
}

function validatePlan(
	plan: PlanBundle,
): Array<{ path: string; message: string }> {
	const issues: Array<{ path: string; message: string }> = [];
	if (plan.tickets.length === 0) {
		issues.push({
			path: "$.tickets",
			message: "Plan must include at least one ticket.",
		});
	}
	const keys = new Set<string>();
	for (const [index, ticket] of plan.tickets.entries()) {
		const path = `$.tickets[${index}]`;
		if (ticket.key.trim() === "") {
			issues.push({
				path: `${path}.key`,
				message: "Ticket key must be non-empty.",
			});
		} else if (keys.has(ticket.key)) {
			issues.push({
				path: `${path}.key`,
				message: "Ticket key must be unique.",
			});
		} else {
			keys.add(ticket.key);
		}
		if (ticket.title.trim() === "") {
			issues.push({
				path: `${path}.title`,
				message: "Ticket title must be non-empty.",
			});
		}
		if (ticket.content.trim() === "") {
			issues.push({
				path: `${path}.content`,
				message: "Ticket content must be non-empty.",
			});
		}
	}
	for (const [index, ticket] of plan.tickets.entries()) {
		for (const [dependencyIndex, dependency] of (
			ticket.dependsOn ?? []
		).entries()) {
			const path = `$.tickets[${index}].dependsOn[${dependencyIndex}]`;
			if (typeof dependency !== "string") {
				issues.push({
					path,
					message: "Dependency reference must be a string.",
				});
			} else if (dependency.trim() === "") {
				issues.push({
					path,
					message: "Dependency reference must be non-empty.",
				});
			} else if (!keys.has(dependency)) {
				issues.push({
					path,
					message: `Unknown dependency '${dependency}'.`,
				});
			}
		}
	}
	const cycle = findDependencyCycle(plan);
	if (cycle !== undefined) {
		issues.push({
			path: "$.tickets",
			message: `Dependency graph must be acyclic (${cycle.join(" -> ")}).`,
		});
	}
	return issues;
}

function parsePlanPayload(payload: Record<string, unknown>): PlanBundle {
	const tickets = Array.isArray(payload.tickets) ? payload.tickets : [];
	return {
		tickets: tickets.map((ticket): PlanTicket => {
			const record = isRecord(ticket) ? ticket : {};
			return {
				key: typeof record.key === "string" ? record.key : "",
				title: typeof record.title === "string" ? record.title : "",
				content: readTicketContent(record),
				...(isStringArray(record.dependsOn)
					? { dependsOn: record.dependsOn }
					: {}),
			};
		}),
	};
}

function readTicketContent(record: Record<string, unknown>): string {
	if (typeof record.content === "string") {
		return record.content;
	}
	if (typeof record.body === "string") {
		return record.body;
	}
	return "";
}

function isStringArray(value: unknown): value is Array<string> {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function findDependencyCycle(plan: PlanBundle): Array<string> | undefined {
	const byKey = new Map(plan.tickets.map((ticket) => [ticket.key, ticket]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: Array<string> = [];
	function visit(key: string): Array<string> | undefined {
		if (visiting.has(key)) {
			return [...stack.slice(stack.indexOf(key)), key];
		}
		if (visited.has(key)) {
			return undefined;
		}
		visiting.add(key);
		stack.push(key);
		for (const dependency of byKey.get(key)?.dependsOn ?? []) {
			if (typeof dependency !== "string" || !byKey.has(dependency)) {
				continue;
			}
			const cycle = visit(dependency);
			if (cycle !== undefined) {
				return cycle;
			}
		}
		stack.pop();
		visiting.delete(key);
		visited.add(key);
		return undefined;
	}
	for (const key of byKey.keys()) {
		const cycle = visit(key);
		if (cycle !== undefined) {
			return cycle;
		}
	}
	return undefined;
}

function planApplicationTarget(
	workflow: WorkflowIssue["workflow"],
): ManifestTransition["to"] | undefined {
	const direct = findWorkflowTransition(workflow, "succeed");
	if (direct !== undefined) {
		return direct.to;
	}
	const started = findWorkflowTransition(workflow, "start");
	if (started === undefined) {
		return undefined;
	}
	return findWorkflowTransition(
		{ ...workflow, ...workflowTarget(started.to) },
		"succeed",
	)?.to;
}

function findWorkflowTransition(
	workflow: WorkflowIssue["workflow"],
	event: string,
): ManifestTransition | undefined {
	const kind = agentDevelopmentManifest.kinds.find(
		(candidate) => candidate.id === workflow.kind,
	);
	return kind?.transitions.find(
		(transition) =>
			transition.event === event &&
			transition.from.state === workflow.state &&
			transition.from.action === workflow.action &&
			transition.from.reason === workflow.reason,
	);
}

function validateOrSucceed(
	command: ManifestCommand,
	data: Parameters<typeof success>[0],
): Envelope {
	const outputValidation = validateWorkflowCommandOutput(command, data);
	return outputValidation ?? success(data);
}

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
