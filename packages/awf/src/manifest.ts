import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

export type Identifier = string;
export type ArtifactKind =
	| "markdown"
	| "inline"
	| "file"
	| "issue"
	| "pull-request"
	| "url"
	| "git-ref"
	| "handoff"
	| "finding";
export type JsonSchema =
	| { type: "string"; artifact?: ArtifactKind }
	| { type: "number" | "integer" | "boolean" | "null" }
	| { type: "array"; items: JsonSchema }
	| {
			type: "object";
			properties?: Readonly<Record<string, JsonSchema>>;
			required?: ReadonlyArray<string>;
			additionalProperties?: boolean;
	  };

export type ManifestTransition = {
	from: { state: Identifier; action?: Identifier; reason?: Identifier };
	event: Identifier;
	input?: JsonSchema;
	to: { state: Identifier; action?: Identifier; reason?: Identifier | null };
};

export type ManifestKind = {
	id: Identifier;
	label: string;
	initial: {
		state: Identifier;
		action?: Identifier;
		reason?: Identifier | null;
	};
	transitions: Array<ManifestTransition>;
};

export type ManifestCommand = {
	id: Identifier;
	target: { kind: Identifier; action: Identifier };
	input?: JsonSchema;
	output?: JsonSchema;
};

export type ManifestReadinessFilter = {
	kind?: Identifier;
	state?: Identifier;
	action?: Identifier;
	reason?: Identifier;
};

export type ManifestRelationship = {
	id: Identifier;
	from: Identifier;
	to: Identifier;
	projection: {
		type: "parent-child" | "dependency" | "link";
		direction?: "outbound" | "inbound";
	};
};

export type WorkflowManifest = {
	version: "v1";
	workflow: { id: Identifier };
	vocabulary: {
		states: Array<Identifier>;
		actions: Array<Identifier>;
		reasons?: Array<Identifier>;
		events: Array<Identifier>;
	};
	github: {
		labelPrefixes: {
			kind: string;
			state: string;
			action: string;
			reason: string;
		};
	};
	concurrency: {
		perIssue: 1;
		perWorkflow?: number;
		perKind?: Record<string, number>;
	};
	readiness?: {
		filters: Array<ManifestReadinessFilter>;
	};
	kinds: Array<ManifestKind>;
	commands: Array<ManifestCommand>;
	relationships?: Array<ManifestRelationship>;
};

export type ValidationIssue = { path: string; message: string };

export class ManifestValidationError extends Error {
	readonly issues: Array<ValidationIssue>;

	constructor(issues: Array<ValidationIssue>) {
		super("Workflow manifest validation failed.");
		this.name = "ManifestValidationError";
		this.issues = issues;
	}
}

export function defineManifest<const T extends WorkflowManifest>(
	manifest: T,
): T {
	return manifest;
}

export async function loadManifest(
	modulePath: string,
): Promise<WorkflowManifest> {
	const absolutePath = resolve(modulePath);
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
	});
	const loaded = await jiti.import<unknown>(pathToFileURL(absolutePath).href, {
		default: true,
	});
	const manifest = extractManifest(loaded);
	const issues = validateManifest(manifest);
	if (issues.length > 0) {
		throw new ManifestValidationError(issues);
	}
	return manifest;
}

export function validateManifest(value: unknown): Array<ValidationIssue> {
	const issues: Array<ValidationIssue> = [];

	if (!isRecord(value)) {
		return [{ path: "$", message: "Manifest must be an object." }];
	}

	rejectExecutableData(value, "$", issues);
	rejectHookKeys(value, "$", issues);

	if (value.version !== "v1") {
		issue(issues, "$.version", "Version must be v1.");
	}
	validateIdentifier(value.workflow, "$.workflow", "workflow object", issues);
	if (isRecord(value.workflow)) {
		validateId(value.workflow.id, "$.workflow.id", issues);
	}

	const vocabulary = isRecord(value.vocabulary) ? value.vocabulary : undefined;
	if (!vocabulary) {
		issue(issues, "$.vocabulary", "Vocabulary must be an object.");
	}
	const states = readIdentifierSet(
		vocabulary?.states,
		"$.vocabulary.states",
		issues,
	);
	const actions = readIdentifierSet(
		vocabulary?.actions,
		"$.vocabulary.actions",
		issues,
	);
	const reasons = readIdentifierSet(
		vocabulary?.reasons ?? [],
		"$.vocabulary.reasons",
		issues,
	);
	const events = readIdentifierSet(
		vocabulary?.events,
		"$.vocabulary.events",
		issues,
	);

	validateGithub(value.github, issues);
	validateConcurrency(value.concurrency, issues);

	const kinds = readArray(value.kinds, "$.kinds", issues);
	const kindIds = new Set<string>();
	const kindActions = new Map<string, Set<string>>();
	for (const [index, kind] of kinds.entries()) {
		const path = `$.kinds[${index}]`;
		if (!isRecord(kind)) {
			issue(issues, path, "Kind must be an object.");
			continue;
		}
		validateUniqueId(kind.id, path, kindIds, issues);
		const localActions = new Set<string>();
		if (typeof kind.id === "string") {
			kindActions.set(kind.id, localActions);
		}
		if (typeof kind.label !== "string" || kind.label === "") {
			issue(issues, `${path}.label`, "Kind label must be a non-empty string.");
		}
		validateStateRef(
			kind.initial,
			`${path}.initial`,
			states,
			actions,
			reasons,
			issues,
			true,
		);
		collectStateAction(kind.initial, localActions);
		for (const [transitionIndex, transition] of readArray(
			kind.transitions,
			`${path}.transitions`,
			issues,
		).entries()) {
			validateTransition(
				transition,
				`${path}.transitions[${transitionIndex}]`,
				states,
				actions,
				reasons,
				events,
				issues,
			);
			if (isRecord(transition)) {
				collectStateAction(transition.from, localActions);
				collectStateAction(transition.to, localActions);
			}
		}
	}

	validateReadiness(value.readiness, kindIds, states, actions, reasons, issues);

	for (const [index, command] of readArray(
		value.commands,
		"$.commands",
		issues,
	).entries()) {
		validateCommand(
			command,
			`$.commands[${index}]`,
			kindIds,
			actions,
			kindActions,
			issues,
		);
	}

	for (const [index, relationship] of readArray(
		value.relationships ?? [],
		"$.relationships",
		issues,
	).entries()) {
		validateRelationship(
			relationship,
			`$.relationships[${index}]`,
			kindIds,
			issues,
		);
	}

	return issues;
}

function extractManifest(loaded: unknown): WorkflowManifest {
	if (isRecord(loaded) && "manifest" in loaded) {
		return loaded.manifest as WorkflowManifest;
	}
	return loaded as WorkflowManifest;
}

function validateIdentifier(
	value: unknown,
	path: string,
	noun: string,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, `${noun} must be an object.`);
	}
}

function validateId(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (
		typeof value !== "string" ||
		!/^[a-z][a-z0-9-]*$/.test(value) ||
		value === "*"
	) {
		issue(
			issues,
			path,
			"Identifier must use lowercase letters, numbers, and hyphens, and cannot be a wildcard.",
		);
	}
}

function validateUniqueId(
	value: unknown,
	path: string,
	seen: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	validateId(value, `${path}.id`, issues);
	if (typeof value === "string") {
		if (seen.has(value)) {
			issue(issues, `${path}.id`, `Duplicate id '${value}'.`);
		}
		seen.add(value);
	}
}

function readIdentifierSet(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): Set<string> {
	const seen = new Set<string>();
	for (const [index, item] of readArray(value, path, issues).entries()) {
		validateId(item, `${path}[${index}]`, issues);
		if (typeof item === "string") {
			if (seen.has(item)) {
				issue(
					issues,
					`${path}[${index}]`,
					`Duplicate vocabulary id '${item}'.`,
				);
			}
			seen.add(item);
		}
	}
	return seen;
}

function validateGithub(value: unknown, issues: Array<ValidationIssue>): void {
	if (!isRecord(value) || !isRecord(value.labelPrefixes)) {
		issue(
			issues,
			"$.github.labelPrefixes",
			"GitHub label prefix metadata is required.",
		);
		return;
	}
	for (const key of ["kind", "state", "action", "reason"] as const) {
		if (
			typeof value.labelPrefixes[key] !== "string" ||
			value.labelPrefixes[key] === ""
		) {
			issue(
				issues,
				`$.github.labelPrefixes.${key}`,
				"Label prefix must be a non-empty string.",
			);
		}
	}
}

function validateConcurrency(
	value: unknown,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, "$.concurrency", "Concurrency rules are required.");
		return;
	}
	if (value.perIssue !== 1) {
		issue(
			issues,
			"$.concurrency.perIssue",
			"perIssue concurrency must be exactly 1.",
		);
	}
	if (value.perWorkflow !== undefined) {
		if (
			typeof value.perWorkflow !== "number" ||
			!Number.isInteger(value.perWorkflow) ||
			value.perWorkflow < 1
		) {
			issue(
				issues,
				"$.concurrency.perWorkflow",
				"perWorkflow concurrency must be a positive integer.",
			);
		}
	}
}

function validateTransition(
	value: unknown,
	path: string,
	states: Set<string>,
	actions: Set<string>,
	reasons: Set<string>,
	events: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Transition must be an object.");
		return;
	}
	validateStateRef(
		value.from,
		`${path}.from`,
		states,
		actions,
		reasons,
		issues,
		false,
	);
	validateStateRef(
		value.to,
		`${path}.to`,
		states,
		actions,
		reasons,
		issues,
		false,
	);
	if (
		typeof value.event !== "string" ||
		!events.has(value.event) ||
		value.event === "*"
	) {
		issue(
			issues,
			`${path}.event`,
			"Transition event must reference a known event and cannot be a wildcard.",
		);
	}
	if (value.input !== undefined) {
		validateJsonSchema(value.input, `${path}.input`, issues);
	}
}

function validateStateRef(
	value: unknown,
	path: string,
	states: Set<string>,
	actions: Set<string>,
	reasons: Set<string>,
	issues: Array<ValidationIssue>,
	requireAction: boolean,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "State reference must be an object.");
		return;
	}
	if (
		typeof value.state !== "string" ||
		!states.has(value.state) ||
		value.state === "*"
	) {
		issue(
			issues,
			`${path}.state`,
			"State must reference a known state and cannot be a wildcard.",
		);
	}
	if (value.action === undefined) {
		if (requireAction) {
			issue(issues, `${path}.action`, "Action is required.");
		}
	} else if (
		typeof value.action !== "string" ||
		!actions.has(value.action) ||
		value.action === "*"
	) {
		issue(
			issues,
			`${path}.action`,
			"Action must reference a known action and cannot be a wildcard.",
		);
	}
	if (
		value.reason !== undefined &&
		value.reason !== null &&
		(typeof value.reason !== "string" ||
			!reasons.has(value.reason) ||
			value.reason === "*")
	) {
		issue(
			issues,
			`${path}.reason`,
			"Reason must reference a known reason, null, or be omitted.",
		);
	}
}

function validateReadiness(
	value: unknown,
	kindIds: Set<string>,
	states: Set<string>,
	actions: Set<string>,
	reasons: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		issue(issues, "$.readiness", "Readiness metadata must be an object.");
		return;
	}
	for (const [index, filter] of readArray(
		value.filters,
		"$.readiness.filters",
		issues,
	).entries()) {
		const path = `$.readiness.filters[${index}]`;
		if (!isRecord(filter)) {
			issue(issues, path, "Readiness filter must be an object.");
			continue;
		}
		if (filter.kind !== undefined && !kindIds.has(String(filter.kind))) {
			issue(issues, `${path}.kind`, "Readiness filter kind must be known.");
		}
		if (filter.state !== undefined && !states.has(String(filter.state))) {
			issue(issues, `${path}.state`, "Readiness filter state must be known.");
		}
		if (filter.action !== undefined && !actions.has(String(filter.action))) {
			issue(issues, `${path}.action`, "Readiness filter action must be known.");
		}
		if (filter.reason !== undefined && !reasons.has(String(filter.reason))) {
			issue(issues, `${path}.reason`, "Readiness filter reason must be known.");
		}
	}
}

function validateCommand(
	value: unknown,
	path: string,
	kindIds: Set<string>,
	actions: Set<string>,
	kindActions: Map<string, Set<string>>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Command must be an object.");
		return;
	}
	validateId(value.id, `${path}.id`, issues);
	if (!isRecord(value.target)) {
		issue(issues, `${path}.target`, "Command target must be an object.");
	} else {
		if (
			typeof value.target.kind !== "string" ||
			!kindIds.has(value.target.kind)
		) {
			issue(
				issues,
				`${path}.target.kind`,
				"Command target kind must reference a known kind.",
			);
		}
		if (
			typeof value.target.action !== "string" ||
			!actions.has(value.target.action)
		) {
			issue(
				issues,
				`${path}.target.action`,
				"Command target action must reference a known action.",
			);
		} else if (
			typeof value.target.kind === "string" &&
			!kindActions.get(value.target.kind)?.has(value.target.action)
		) {
			issue(
				issues,
				`${path}.target.action`,
				"Command target action must be declared by the target kind's local states or transitions.",
			);
		}
	}
	if (value.input !== undefined) {
		validateJsonSchema(value.input, `${path}.input`, issues);
	}
	if (value.output !== undefined) {
		validateJsonSchema(value.output, `${path}.output`, issues);
	}
}

function collectStateAction(value: unknown, actions: Set<string>): void {
	if (
		isRecord(value) &&
		typeof value.action === "string" &&
		value.action !== "*"
	) {
		actions.add(value.action);
	}
}

function validateRelationship(
	value: unknown,
	path: string,
	kindIds: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Relationship must be an object.");
		return;
	}
	validateId(value.id, `${path}.id`, issues);
	if (typeof value.from !== "string" || !kindIds.has(value.from)) {
		issue(issues, `${path}.from`, "Relationship source kind must be known.");
	}
	if (typeof value.to !== "string" || !kindIds.has(value.to)) {
		issue(issues, `${path}.to`, "Relationship target kind must be known.");
	}
	if (!isRecord(value.projection)) {
		issue(
			issues,
			`${path}.projection`,
			"Relationship projection must be an object.",
		);
		return;
	}
	if (
		!["parent-child", "dependency", "link"].includes(
			String(value.projection.type),
		)
	) {
		issue(
			issues,
			`${path}.projection.type`,
			"Relationship projection type is invalid.",
		);
	}
	if (
		value.projection.direction !== undefined &&
		value.projection.direction !== "outbound" &&
		value.projection.direction !== "inbound"
	) {
		issue(
			issues,
			`${path}.projection.direction`,
			"Relationship projection direction is invalid.",
		);
	}
}

function validateJsonSchema(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Command schema must be an object.");
		return;
	}
	const type = value.type;
	if (
		![
			"string",
			"number",
			"integer",
			"boolean",
			"null",
			"array",
			"object",
		].includes(String(type))
	) {
		issue(issues, `${path}.type`, "Command schema type is invalid.");
		return;
	}
	if (
		value.artifact !== undefined &&
		(type !== "string" ||
			![
				"markdown",
				"inline",
				"file",
				"issue",
				"pull-request",
				"url",
				"git-ref",
				"handoff",
				"finding",
			].includes(String(value.artifact)))
	) {
		issue(
			issues,
			`${path}.artifact`,
			"Artifact reference declarations must be string schemas with a known artifact kind.",
		);
	}
	if (type === "array") {
		validateJsonSchema(value.items, `${path}.items`, issues);
	}
	if (type === "object") {
		if (value.properties !== undefined && !isRecord(value.properties)) {
			issue(
				issues,
				`${path}.properties`,
				"Object schema properties must be an object.",
			);
		}
		if (isRecord(value.properties)) {
			for (const [key, child] of Object.entries(value.properties)) {
				validateJsonSchema(child, `${path}.properties.${key}`, issues);
			}
		}
		if (
			value.required !== undefined &&
			(!Array.isArray(value.required) ||
				value.required.some((item) => typeof item !== "string"))
		) {
			issue(
				issues,
				`${path}.required`,
				"Object schema required must be an array of property names.",
			);
		}
	}
}

function rejectExecutableData(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (typeof value === "function") {
		issue(
			issues,
			path,
			"Executable hooks are not allowed in workflow manifests.",
		);
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectExecutableData(item, `${path}[${index}]`, issues);
		}
	}
	if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			rejectExecutableData(item, `${path}.${key}`, issues);
		}
	}
}

function rejectHookKeys(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectHookKeys(item, `${path}[${index}]`, issues);
		}
	}
	if (!isRecord(value)) {
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if (
			["hook", "hooks", "handler", "handlers", "run", "execute"].includes(key)
		) {
			issue(
				issues,
				`${path}.${key}`,
				"Executable hook fields are not part of the declarative v1 schema.",
			);
		}
		rejectHookKeys(item, `${path}.${key}`, issues);
	}
}

function readArray(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): Array<unknown> {
	if (!Array.isArray(value)) {
		issue(issues, path, "Expected an array.");
		return [];
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
	issues: Array<ValidationIssue>,
	path: string,
	message: string,
): void {
	issues.push({ path, message });
}
