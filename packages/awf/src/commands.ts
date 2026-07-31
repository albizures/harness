import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defaultManifest } from "./default-manifest.ts";
import { type Envelope, failure, success } from "./envelope.ts";
import type { JsonValue } from "type-fest";
import {
	loadManifest,
	ManifestValidationError,
	type ManifestTransition,
	type WorkflowManifest,
} from "./manifest.ts";
import {
	CorruptWorkflowProjectionError,
	IssueNotFoundError,
	createInMemoryTracker,
	type Tracker,
} from "./tracker.ts";

type CommandSpec = {
	name: string;
	usage: string;
	description: string;
};

const commands: Array<CommandSpec> = [
	{
		name: "get",
		usage: "awf get <id>",
		description: "Return a workflow entity.",
	},
	{
		name: "ready",
		usage: "awf ready [--spec <id>] [--limit <n>]",
		description: "Return legally executable work.",
	},
	{
		name: "logs",
		usage: "awf logs <id>",
		description: "Return immutable workflow logs.",
	},
	{
		name: "create spec",
		usage: "awf create spec --input <file|->",
		description: "Create a Spec.",
	},
	{
		name: "apply plan",
		usage: "awf apply plan <spec> --input <file|->",
		description: "Apply a plan to a Spec.",
	},
	{
		name: "handoff",
		usage: "awf handoff <source> --input <handoff.json>",
		description: "Create a Handoff.",
	},
	{
		name: "manifest validate",
		usage: "awf manifest validate <file>",
		description: "Load and validate a workflow manifest.",
	},
	{
		name: "start",
		usage: "awf start <id>",
		description: "Start the current action.",
	},
	{
		name: "succeed",
		usage: "awf succeed <id> --run <run>",
		description: "Mark a run as succeeded.",
	},
	{
		name: "fail",
		usage: "awf fail <id> --run <run>",
		description: "Mark a run as failed.",
	},
];

export type ExecuteOptions = {
	tracker?: Tracker;
	manifest?: WorkflowManifest;
	stdin?: string;
};

export async function execute(
	args: Array<string>,
	options: ExecuteOptions = {},
): Promise<Envelope> {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return success({
			name: "awf",
			description: "Agent workflow CLI.",
			commands,
		});
	}

	if (args[0] === "--version" || args[0] === "-v") {
		return success({ name: "@albizures/awf", version: "0.0.0" });
	}

	const parseError = validateKnownCommand(args);
	if (parseError !== undefined) {
		return parseError;
	}

	if (args[0] === "manifest" && args[1] === "validate") {
		return validateManifestCommand(args[2]);
	}

	const tracker = options.tracker ?? createInMemoryTracker();
	const manifest = options.manifest ?? defaultManifest;

	if (args[0] === "get") {
		return getIssueCommand(args[1], tracker);
	}
	if (args[0] === "logs") {
		return logsCommand(args[1], tracker);
	}
	if (args[0] === "ready") {
		return readyCommand(parseReadyOptions(args), tracker, manifest);
	}
	if (args[0] === "create" && args[1] === "spec") {
		return createSpecCommand(
			readOption(args, "--input"),
			tracker,
			manifest,
			options.stdin,
		);
	}
	if (args[0] === "apply" && args[1] === "plan") {
		return applyPlanCommand(
			args[2],
			readOption(args, "--input"),
			tracker,
			manifest,
			options.stdin,
		);
	}
	if (args[0] === "start") {
		return startCommand(args[1], tracker, manifest);
	}
	if (args[0] === "succeed" || args[0] === "fail") {
		return terminalCommand(
			args[0],
			args[1],
			readOption(args, "--run"),
			tracker,
			manifest,
		);
	}

	return failure(
		"NOT_IMPLEMENTED",
		"This workflow command is not implemented yet.",
		{
			command: args.join(" "),
		},
	);
}

function validateKnownCommand(args: Array<string>): Envelope | undefined {
	const [command, subcommand] = args;

	switch (command) {
		case "get":
		case "logs":
		case "start":
			return requirePositionalCount(args, 1, `awf ${command} <id>`);
		case "ready":
			return validateReady(args);
		case "handoff":
			return requirePositionalAndOption(
				args,
				"awf handoff <source> --input <handoff.json>",
				"--input",
			);
		case "succeed":
		case "fail":
			return requirePositionalAndOption(
				args,
				`awf ${command} <id> --run <run>`,
				"--run",
			);
		case "create":
			if (subcommand !== "spec") {
				return unknownCommand(args);
			}
			return requirePositionalAndOption(
				args,
				"awf create spec --input <file|->",
				"--input",
				1,
			);
		case "apply":
			if (subcommand !== "plan") {
				return unknownCommand(args);
			}
			return requirePositionalAndOption(
				args,
				"awf apply plan <spec> --input <file|->",
				"--input",
				2,
			);
		case "manifest":
			if (subcommand !== "validate") {
				return unknownCommand(args);
			}
			return requirePositionalCount(args, 1, "awf manifest validate <file>", 2);
		default:
			return unknownCommand(args);
	}
}

function validateReady(args: Array<string>): Envelope | undefined {
	const options = parseReadyOptions(args);
	if (
		options.error === undefined &&
		options.limit !== undefined &&
		(!Number.isInteger(options.limit) || options.limit < 1)
	) {
		return invalidReadyArguments();
	}
	return options.error === undefined ? undefined : invalidReadyArguments();
}

function invalidReadyArguments(): Envelope {
	return failure("INVALID_ARGUMENTS", "Invalid arguments for ready.", {
		usage: "awf ready [--spec <id>] [--limit <n>]",
	});
}

type ReadyOptions = { specId?: string; limit?: number; error?: true };

function parseReadyOptions(args: Array<string>): ReadyOptions {
	const options: ReadyOptions = {};
	for (let index = 1; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (value === undefined || value === "") {
			return { error: true };
		}
		if (option === "--spec" && options.specId === undefined) {
			options.specId = value;
		} else if (option === "--limit" && options.limit === undefined) {
			options.limit = Number(value);
		} else {
			return { error: true };
		}
	}
	return options;
}

function requirePositionalCount(
	args: Array<string>,
	count: number,
	usage: string,
	offset = 1,
): Envelope | undefined {
	const positionals = args.slice(offset).filter((arg) => !arg.startsWith("-"));
	if (positionals.length === count && args.length === offset + count) {
		return undefined;
	}

	return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}

function requirePositionalAndOption(
	args: Array<string>,
	usage: string,
	optionName: string,
	prefixPositionals = 1,
): Envelope | undefined {
	const prefix = args.slice(1, 1 + prefixPositionals);
	const optionIndex = args.indexOf(optionName);
	if (
		prefix.every(
			(arg) => arg !== undefined && arg !== "" && !arg.startsWith("-"),
		) &&
		optionIndex === 1 + prefixPositionals &&
		args[optionIndex + 1] !== undefined &&
		args[optionIndex + 1] !== "" &&
		args.length === optionIndex + 2
	) {
		return undefined;
	}

	return failure("INVALID_ARGUMENTS", "Invalid command arguments.", { usage });
}

async function createSpecCommand(
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
): Promise<Envelope> {
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
	const spec = parseSpecInput(raw);
	if (spec.content.trim() === "") {
		return failure("INVALID_SPEC", "Spec content must be non-empty.");
	}
	const issue = await tracker.createIssue({
		title: spec.title,
		body: spec.content,
		workflow: { kind: "spec", ...initialWorkflowTarget(kind.initial) },
	});
	const log = await tracker.appendLog(issue.id, {
		type: "spec_created",
		payload: { input: inputPath },
	});
	return success({ issue, log });
}

async function applyPlanCommand(
	specId: string | undefined,
	inputPath: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
	stdin: string | undefined,
): Promise<Envelope> {
	if (specId === undefined || inputPath === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf apply plan <spec> --input <file|->",
		});
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
	const raw = await readInput(inputPath, stdin);
	const plan = parsePlanInput(raw);
	const validationIssues = validatePlan(plan);
	if (validationIssues.length > 0) {
		return failure("INVALID_PLAN", "Plan bundle is invalid.", {
			issues: validationIssues as JsonValue,
		});
	}

	const created: Array<{ key: string; id: string }> = [];
	const children: Array<string> = [];
	const dependencies: Array<{ issueId: string; blockedById: string }> = [];
	try {
		const ticketKind = manifest.kinds.find((kind) => kind.id === "ticket");
		if (ticketKind === undefined) {
			throw new Error("Manifest does not define ticket kind.");
		}
		for (const ticket of plan.tickets) {
			const issue = await tracker.createIssue({
				title: ticket.title,
				body: ticket.content,
				workflow: {
					kind: "ticket",
					...initialWorkflowTarget(ticketKind.initial),
				},
			});
			created.push({ key: ticket.key, id: issue.id });
			await tracker.addChild(specId, issue.id);
			children.push(issue.id);
		}
		const idsByKey = new Map(created.map((ticket) => [ticket.key, ticket.id]));
		for (const ticket of plan.tickets) {
			for (const dependencyKey of ticket.dependsOn ?? []) {
				const issueId = idsByKey.get(ticket.key);
				const blockedById = idsByKey.get(dependencyKey as string);
				if (issueId === undefined || blockedById === undefined) {
					throw new Error(
						"Plan dependency resolution failed after validation.",
					);
				}
				await tracker.addDependency(issueId, blockedById);
				dependencies.push({ issueId, blockedById });
			}
		}
		const target = planApplicationTarget(manifest, spec.workflow);
		if (target === undefined) {
			throw new Error("Spec has no success transition for plan application.");
		}
		const updated = await tracker.updateIssue(specId, {
			expect: { version: spec.workflow.version, hash: spec.workflow.hash },
			workflow: { ...workflowTarget(target), activeRunId: undefined },
		});
		const log = await tracker.appendLog(specId, {
			type: "plan_applied",
			payload: { input: inputPath, tickets: created },
		});
		return success({
			outcome: "SUCCESS",
			spec: updated,
			tickets: created,
			log,
		});
	} catch (error) {
		const rollbackErrors = await rollbackPlanApplication(
			tracker,
			specId,
			spec.workflow,
			dependencies,
			children,
			created.map((ticket) => ticket.id),
		);
		if (rollbackErrors.length === 0) {
			return failure(
				"PLAN_APPLY_FAILED",
				"Plan application failed and was rolled back.",
				{
					outcome: "ROLLED_BACK",
					message: error instanceof Error ? error.message : String(error),
				},
			);
		}
		await escalatePartialRollback(tracker, specId);
		return failure(
			"PLAN_APPLY_FAILED",
			"Plan application failed and rollback was partial.",
			{
				outcome: "PARTIAL_ROLLBACK",
				message: error instanceof Error ? error.message : String(error),
				rollbackErrors,
			},
		);
	}
}

async function getIssueCommand(
	id: string | undefined,
	tracker: Tracker,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf get <id>",
		});
	}

	try {
		const issue = await tracker.getIssue(id);
		const logs = await tracker.readLogs(id);
		return success({
			issue,
			runs: deriveRuns(issue.workflow.activeRunId, logs),
		});
	} catch (error) {
		if (error instanceof IssueNotFoundError) {
			return failure("NOT_FOUND", error.message, { id });
		}
		if (error instanceof CorruptWorkflowProjectionError) {
			return failure("CORRUPT_WORKFLOW_PROJECTION", error.message, { id });
		}
		throw error;
	}
}

async function readyCommand(
	options: ReadyOptions,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	const issues = await tracker.listIssues();
	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	const activeIssues = issues.filter(
		(issue) => issue.workflow.activeRunId !== undefined,
	);
	const filters = readinessFilters(manifest);
	const candidates = issues
		.filter((issue) => matchesReadinessFilters(issue.workflow, filters))
		.filter((issue) => issue.workflow.activeRunId === undefined)
		.filter((issue) =>
			issue.relationships.dependencies.every((id) => isDone(byId.get(id))),
		)
		.filter(
			(issue) =>
				options.specId === undefined ||
				issue.relationships.parent === options.specId,
		)
		.filter(() => !workflowConcurrencyBlocked(manifest, activeIssues))
		.filter(
			(issue) =>
				!kindConcurrencyBlocked(manifest, activeIssues, issue.workflow.kind),
		)
		.sort(compareReadyIssues)
		.slice(0, options.limit);

	return success({
		items: candidates.map((issue) => ({
			id: issue.id,
			title: issue.title,
			workflow: cleanWorkflowFields(issue.workflow),
			suggestedCommand: {
				argv: ["start", issue.id],
				display: `awf start ${issue.id}`,
			},
		})),
	});
}

async function logsCommand(
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

async function startCommand(
	id: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	if (id === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf start <id>",
		});
	}

	try {
		const issue = await tracker.getIssue(id);
		const transition = findTransition(manifest, issue.workflow, "start");
		if (transition === undefined) {
			return invalidTransition(id, "start");
		}
		const runId = `run-${randomUUID()}`;
		const updated = await tracker.updateIssue(id, {
			expect: {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			},
			workflow: { ...workflowTarget(transition.to), activeRunId: runId },
		});
		const log = await tracker.appendLog(id, {
			type: "action_started",
			runId,
			payload: { event: "start", to: cleanTransitionTarget(transition.to) },
		});
		return success({ issue: updated, run: { id: runId }, log });
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function terminalCommand(
	event: "succeed" | "fail",
	id: string | undefined,
	runId: string | undefined,
	tracker: Tracker,
	manifest: WorkflowManifest,
): Promise<Envelope> {
	if (id === undefined || runId === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: `awf ${event} <id> --run <run>`,
		});
	}

	try {
		const logs = await tracker.readLogs(id);
		const terminalPayload = terminalLogPayload(
			manifest,
			await tracker.getIssue(id),
			event,
		);
		const existing = logs.find(
			(log) => log.runId === runId && isTerminalLog(log.type),
		);
		const logType = terminalLogType(event);
		if (existing !== undefined) {
			if (
				existing.type === logType &&
				stableStringify(existing.payload) === stableStringify(terminalPayload)
			) {
				const issue = await tracker.getIssue(id);
				return success({
					issue,
					run: { id: runId, status: event },
					log: existing,
				});
			}
			return failure(
				"CONFLICTING_TERMINAL_OUTCOME",
				"Workflow run already has a different terminal outcome.",
				{ id, runId },
			);
		}

		const issue = await tracker.getIssue(id);
		if (issue.workflow.activeRunId !== runId) {
			return failure(
				"RUN_MISMATCH",
				"Command run id does not match the active workflow run.",
				{
					id,
					...(issue.workflow.activeRunId === undefined
						? {}
						: { activeRunId: issue.workflow.activeRunId }),
					runId,
				},
			);
		}
		const transition = findTransition(manifest, issue.workflow, event);
		if (transition === undefined) {
			return invalidTransition(id, event);
		}
		const updated = await tracker.updateIssue(id, {
			expect: {
				version: issue.workflow.version,
				hash: issue.workflow.hash,
			},
			workflow: { ...workflowTarget(transition.to), activeRunId: undefined },
		});
		const log = await tracker.appendLog(id, {
			type: logType,
			runId,
			payload: { event, to: cleanTransitionTarget(transition.to) },
		});
		return success({ issue: updated, run: { id: runId, status: event }, log });
	} catch (error) {
		return lifecycleError(id, error);
	}
}

async function validateManifestCommand(
	path: string | undefined,
): Promise<Envelope> {
	if (path === undefined) {
		return failure("INVALID_ARGUMENTS", "Invalid command arguments.", {
			usage: "awf manifest validate <file>",
		});
	}

	try {
		const manifest = await loadManifest(path);
		return success({
			manifest: manifest.workflow.id,
			version: manifest.version,
			kinds: manifest.kinds.map((kind) => kind.id),
		});
	} catch (error) {
		if (error instanceof ManifestValidationError) {
			return failure(
				"MANIFEST_VALIDATION_FAILED",
				"Workflow manifest validation failed.",
				{ issues: error.issues },
			);
		}
		return failure(
			"MANIFEST_LOAD_FAILED",
			"Workflow manifest could not be loaded.",
			{ message: error instanceof Error ? error.message : String(error) },
		);
	}
}

type WorkflowFields = {
	kind: string;
	state: string;
	action?: string;
	reason?: string;
	activeRunId?: string;
};

function readOption(args: Array<string>, name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function readInput(
	path: string,
	stdin: string | undefined,
): Promise<string> {
	if (path === "-") {
		return stdin ?? "";
	}
	return readFile(path, "utf8");
}

type SpecInput = { title: string; content: string };
type PlanBundle = { tickets: Array<PlanTicket> };
type PlanTicket = {
	key: string;
	title: string;
	content: string;
	dependsOn?: Array<unknown>;
};

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
	const parsed = parseJsonObject(raw);
	const tickets = Array.isArray(parsed?.tickets) ? parsed.tickets : [];
	return {
		tickets: tickets.map((ticket): PlanTicket => {
			const record = isRecord(ticket) ? ticket : {};
			return {
				key: typeof record.key === "string" ? record.key : "",
				title: typeof record.title === "string" ? record.title : "",
				content: readTicketContent(record),
				...(Array.isArray(record.dependsOn)
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

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function titleFromMarkdown(markdown: string): string {
	const heading = markdown
		.split(/\r?\n/u)
		.map((line) => line.match(/^#\s+(.+)$/u)?.[1]?.trim())
		.find((title) => title !== undefined && title !== "");
	return heading ?? "Spec";
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
		for (const dependency of ticket.dependsOn ?? []) {
			if (typeof dependency !== "string" || dependency.trim() === "") {
				issues.push({
					path: `$.tickets[${index}].dependsOn`,
					message: "Dependency references must be non-empty strings.",
				});
			} else if (!keys.has(dependency)) {
				issues.push({
					path: `$.tickets[${index}].dependsOn`,
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

async function rollbackPlanApplication(
	tracker: Tracker,
	specId: string,
	specWorkflow: WorkflowFields,
	dependencies: Array<{ issueId: string; blockedById: string }>,
	children: Array<string>,
	createdIssueIds: Array<string>,
): Promise<Array<string>> {
	const errors: Array<string> = [];
	for (const dependency of [...dependencies].reverse()) {
		try {
			await tracker.removeDependency(
				dependency.issueId,
				dependency.blockedById,
			);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const childId of [...children].reverse()) {
		try {
			await tracker.removeChild(specId, childId);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const issueId of [...createdIssueIds].reverse()) {
		try {
			await tracker.deleteIssue(issueId);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		await tracker.updateIssue(specId, {
			workflow: {
				state: specWorkflow.state,
				action: specWorkflow.action,
				reason: specWorkflow.reason,
				activeRunId: specWorkflow.activeRunId,
			},
		});
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return errors;
}

async function escalatePartialRollback(
	tracker: Tracker,
	specId: string,
): Promise<void> {
	try {
		await tracker.updateIssue(specId, {
			workflow: { state: "need-human", action: "none", activeRunId: undefined },
		});
	} catch {
		// Best-effort escalation: the original partial rollback error remains the outcome.
	}
}

function readinessFilters(
	manifest: WorkflowManifest,
): Array<{ kind?: string; state?: string; action?: string; reason?: string }> {
	if (manifest.readiness !== undefined) {
		return manifest.readiness.filters;
	}
	return manifest.kinds.flatMap((kind) =>
		kind.transitions
			.filter((transition) => transition.event === "start")
			.map((transition) => ({ kind: kind.id, ...transition.from })),
	);
}

function matchesReadinessFilters(
	workflow: WorkflowFields,
	filters: Array<{
		kind?: string;
		state?: string;
		action?: string;
		reason?: string;
	}>,
): boolean {
	return filters.some(
		(filter) =>
			fieldMatches(filter.kind, workflow.kind) &&
			fieldMatches(filter.state, workflow.state) &&
			fieldMatches(filter.action, workflow.action) &&
			fieldMatches(filter.reason, workflow.reason),
	);
}

function fieldMatches(
	expected: string | undefined,
	actual: string | undefined,
): boolean {
	return expected === undefined || expected === actual;
}

function isDone(issue: { workflow: WorkflowFields } | undefined): boolean {
	return issue?.workflow.state === "done";
}

function workflowConcurrencyBlocked(
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
): boolean {
	return (
		manifest.concurrency.perWorkflow !== undefined &&
		activeIssues.length >= manifest.concurrency.perWorkflow
	);
}

function kindConcurrencyBlocked(
	manifest: WorkflowManifest,
	activeIssues: Array<{ workflow: WorkflowFields }>,
	kind: string,
): boolean {
	const limit = manifest.concurrency.perKind?.[kind];
	return (
		limit !== undefined &&
		activeIssues.filter((issue) => issue.workflow.kind === kind).length >= limit
	);
}

function compareReadyIssues(
	left: { id: string; title: string },
	right: { id: string; title: string },
): number {
	return (
		left.id.localeCompare(right.id, undefined, { numeric: true }) ||
		left.title.localeCompare(right.title) ||
		left.id.localeCompare(right.id)
	);
}

function cleanWorkflowFields(workflow: WorkflowFields): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			kind: workflow.kind,
			state: workflow.state,
			action: workflow.action,
			reason: workflow.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string>;
}

function planApplicationTarget(
	manifest: WorkflowManifest,
	workflow: WorkflowFields,
): ManifestTransition["to"] | undefined {
	const direct = findTransition(manifest, workflow, "succeed");
	if (direct !== undefined) {
		return direct.to;
	}
	const started = findTransition(manifest, workflow, "start");
	if (started === undefined) {
		return undefined;
	}
	return findTransition(
		manifest,
		{ ...workflow, ...workflowTarget(started.to) },
		"succeed",
	)?.to;
}

function findTransition(
	manifest: WorkflowManifest,
	workflow: WorkflowFields,
	event: string,
): ManifestTransition | undefined {
	const kind = manifest.kinds.find(
		(candidate) => candidate.id === workflow.kind,
	);
	return kind?.transitions.find(
		(transition) =>
			transition.event === event && fieldsMatch(transition.from, workflow),
	);
}

function fieldsMatch(
	from: ManifestTransition["from"],
	workflow: WorkflowFields,
): boolean {
	return (
		from.state === workflow.state &&
		from.action === workflow.action &&
		from.reason === workflow.reason
	);
}

function invalidTransition(id: string, event: string): Envelope {
	return failure(
		"INVALID_TRANSITION",
		"No manifest transition matches the current workflow fields for this event.",
		{ id, event },
	);
}

function lifecycleError(id: string, error: unknown): Envelope {
	if (error instanceof IssueNotFoundError) {
		return failure("NOT_FOUND", error.message, { id });
	}
	if (error instanceof CorruptWorkflowProjectionError) {
		return failure("CORRUPT_WORKFLOW_PROJECTION", error.message, { id });
	}
	throw error;
}

function terminalLogType(event: "succeed" | "fail"): string {
	return event === "succeed" ? "action_succeeded" : "action_failed";
}

function isTerminalLog(type: string): boolean {
	return type === "action_succeeded" || type === "action_failed";
}

function terminalLogPayload(
	manifest: WorkflowManifest,
	issue: { workflow: WorkflowFields },
	event: "succeed" | "fail",
): unknown {
	const transition = findTransition(manifest, issue.workflow, event);
	return {
		event,
		to: cleanTransitionTarget(transition?.to ?? issue.workflow),
	};
}

function initialWorkflowTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): { state: string; action: string; reason?: string } {
	return { ...workflowTarget(target), action: target.action ?? "none" };
}

function workflowTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): { state: string; action?: string; reason?: string } {
	return {
		state: target.state,
		...(target.action === undefined ? {} : { action: target.action }),
		...(target.reason === undefined || target.reason === null
			? {}
			: { reason: target.reason }),
	};
}

function cleanTransitionTarget(target: {
	state: string;
	action?: string;
	reason?: string | null;
}): Record<string, string | null> {
	return Object.fromEntries(
		Object.entries({
			state: target.state,
			action: target.action,
			reason: target.reason,
		}).filter(([, value]) => value !== undefined),
	) as Record<string, string | null>;
}

function deriveRuns(
	activeRunId: string | undefined,
	logs: Array<{ type: string; runId?: string }>,
): {
	activeRunId?: string;
	attempts: Array<{ runId: string; status: string }>;
} {
	const attempts = new Map<string, { runId: string; status: string }>();
	for (const log of logs) {
		if (log.runId === undefined) {
			continue;
		}
		if (!attempts.has(log.runId)) {
			attempts.set(log.runId, { runId: log.runId, status: "unknown" });
		}
		const attempt = attempts.get(log.runId);
		if (attempt === undefined) {
			continue;
		}
		if (log.type === "action_started") {
			attempt.status = "running";
		}
		if (log.type === "action_succeeded") {
			attempt.status = "succeeded";
		}
		if (log.type === "action_failed") {
			attempt.status = "failed";
		}
	}
	if (activeRunId !== undefined && !attempts.has(activeRunId)) {
		attempts.set(activeRunId, { runId: activeRunId, status: "running" });
	}
	return { activeRunId, attempts: [...attempts.values()] };
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function unknownCommand(args: Array<string>): Envelope {
	return failure("UNKNOWN_COMMAND", "Unknown command.", {
		command: args.join(" "),
	});
}
