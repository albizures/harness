import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";

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
export type PayloadZodSchema = z.ZodType<unknown>;
export type PayloadSchema = PayloadZodSchema;

type ManifestStateReference = {
	state: Identifier;
	action?: Identifier;
	reason?: Identifier | null;
};

export type ManifestTransition = {
	from: ManifestStateReference;
	event: Identifier;
	input?: PayloadSchema;
	to: ManifestStateReference;
};

export type ManifestTransitionDefinition = ManifestTransition;

export type ManifestKind = {
	id: Identifier;
	label: string;
	initial: ManifestStateReference;
	transitions: Array<ManifestTransition>;
};

export type ManifestKindDefinition = Omit<ManifestKind, "transitions"> & {
	transitions: Array<ManifestTransitionDefinition>;
};

export type ManifestCommand = {
	id: Identifier;
	cli?: { verb: "create" | "apply"; target: Identifier };
	target: { kind: Identifier; action: Identifier };
	input?: PayloadSchema;
	output?: PayloadSchema;
};

export type ManifestCommandDefinition = ManifestCommand;

export type ManifestReadinessFilter = {
	kind?: Identifier;
	state?: Identifier;
	action?: Identifier;
	reason?: Identifier;
};

export type ManifestNamedReadinessFilter = {
	name: Identifier;
	kind: Identifier;
	relationship: "parent";
};

export type ManifestRelationship = {
	id: Identifier;
	from: Identifier;
	to: Identifier;
	projection: {
		type: "parent-child" | "dependency";
		direction?: "outbound" | "inbound";
	};
};

export type LifecyclePolicyTarget = { kind: Identifier; action: Identifier };

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
		reservedPrefix: string;
	};
	concurrency: {
		perIssue: 1;
		perWorkflow?: number;
		perKind?: Record<string, number>;
	};
	readiness?: {
		filters: Array<ManifestReadinessFilter>;
		namedFilters?: Array<ManifestNamedReadinessFilter>;
	};
	lifecycle?: {
		retry?: { allow?: Array<LifecyclePolicyTarget> };
		escalation?: { allow?: Array<LifecyclePolicyTarget> };
		resume?: {
			allow?: Array<{ kind: Identifier; actions: Array<Identifier> }>;
		};
	};
	kinds: Array<ManifestKind>;
	commands: Array<ManifestCommand>;
	relationships?: Array<ManifestRelationship>;
};

export type WorkflowManifestDefinition = Omit<
	WorkflowManifest,
	"github" | "kinds" | "commands"
> & {
	github?: { reservedPrefix?: string };
	kinds: Array<ManifestKindDefinition>;
	commands: Array<ManifestCommandDefinition>;
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

const artifactMetadataKey = "awfArtifact";

export const artifacts = {
	string: () => z.string(),
	object: <const T extends z.ZodRawShape>(shape: T) => z.strictObject(shape),
	array: <T extends PayloadZodSchema>(item: T) => z.array(item),
	url: () => artifactReference("url"),
	file: () => artifactReference("file"),
	issue: () => artifactReference("issue"),
	pullRequest: () => artifactReference("pull-request"),
	gitRef: () => artifactReference("git-ref"),
	inlineMarkdown: () => artifactReference("markdown"),
	markdown: () => artifactReference("markdown"),
	inline: () => artifactReference("inline"),
	handoff: () => artifactReference("handoff"),
	finding: () => artifactReference("finding"),
};

export function validateArtifactReferenceValue(
	value: string,
	kind: ArtifactKind,
): string | undefined {
	if (value.trim() === "") {
		return "Artifact reference must be non-empty.";
	}
	switch (kind) {
		case "pull-request":
			return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u.test(value)
				? undefined
				: "Pull request artifact must be a GitHub pull request URL.";
		case "url":
			return /^https?:\/\//u.test(value)
				? undefined
				: "URL artifact must be http(s).";
		case "issue":
			return /^#\d+$/u.test(value) ||
				/^[a-z][a-z0-9-]*-\d+$/u.test(value) ||
				/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/u.test(value)
				? undefined
				: "Issue artifact must be a GitHub issue reference.";
		case "file":
			return !/^https?:\/\//u.test(value) && !value.startsWith("/")
				? undefined
				: "File artifact must be a relative path.";
		case "git-ref":
			return /\s/u.test(value)
				? "Git ref artifact must not contain whitespace."
				: undefined;
		default:
			return undefined;
	}
}

const structuredArtifactReferenceShape = {
	type: z.enum([
		"markdown",
		"inline",
		"file",
		"issue",
		"pull-request",
		"url",
		"git-ref",
		"handoff",
		"finding",
	]),
	ref: z.string().trim().optional(),
	url: z.string().trim().optional(),
	path: z.string().trim().optional(),
	id: z.string().trim().optional(),
	title: z.string().trim().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
};

function artifactReference(kind: ArtifactKind): PayloadZodSchema {
	return structuredArtifactReference(kind).meta({
		[artifactMetadataKey]: kind,
	});
}

function structuredArtifactReference(kind: ArtifactKind): PayloadZodSchema {
	return z
		.strictObject(structuredArtifactReferenceShape)
		.superRefine((value, context) => {
			if (value.type !== kind) {
				context.addIssue({
					code: "custom",
					path: ["type"],
					message: `Artifact type must be '${kind}'.`,
				});
			}
			validateStructuredArtifactReference(value, kind, context);
		});
}

type StructuredArtifactReferenceInput = z.infer<
	ReturnType<typeof z.strictObject<typeof structuredArtifactReferenceShape>>
>;

function validateStructuredArtifactReference(
	value: StructuredArtifactReferenceInput,
	kind: ArtifactKind,
	context: z.RefinementCtx,
): void {
	if (kind === "pull-request" || kind === "url") {
		validateStructuredField(value.url, "url", kind, context);
		return;
	}
	if (kind === "file") {
		validateStructuredField(value.path, "path", kind, context);
		return;
	}
	if (kind === "git-ref") {
		validateStructuredField(value.ref, "ref", kind, context);
		return;
	}
	if (kind === "issue") {
		if (
			value.ref === undefined &&
			value.url === undefined &&
			value.id === undefined
		) {
			context.addIssue({
				code: "custom",
				path: ["ref"],
				message: "Issue artifact must include ref, url, or id.",
			});
			return;
		}
		if (value.ref !== undefined) {
			validateStructuredField(value.ref, "ref", kind, context);
		}
		if (value.url !== undefined) {
			validateStructuredField(value.url, "url", kind, context);
		}
		if (value.id !== undefined && value.id.trim() === "") {
			context.addIssue({
				code: "custom",
				path: ["id"],
				message: "Artifact reference must be non-empty.",
			});
		}
		return;
	}
	validateStructuredField(value.ref, "ref", kind, context);
}

function validateStructuredField(
	value: string | undefined,
	field: "ref" | "url" | "path",
	kind: ArtifactKind,
	context: z.RefinementCtx,
): void {
	if (value === undefined) {
		context.addIssue({
			code: "custom",
			path: [field],
			message: `Artifact reference must include ${field}.`,
		});
		return;
	}
	const message = validateArtifactReferenceValue(value, kind);
	if (message !== undefined) {
		context.addIssue({ code: "custom", path: [field], message });
	}
}

const payloadZodSchemaSchema = z.custom<PayloadZodSchema>(isPayloadZodSchema, {
	message: "Payload schema must be a Zod schema.",
});

const stateReferenceSchema = z.strictObject({
	state: z.string(),
	action: z.string().optional(),
	reason: z.string().nullable().optional(),
});

const lifecyclePolicyTargetSchema = z.strictObject({
	kind: z.string(),
	action: z.string(),
});

const manifestSchema = z.strictObject({
	version: z.literal("v1"),
	workflow: z.strictObject({ id: z.string() }),
	vocabulary: z.strictObject({
		states: z.array(z.string()),
		actions: z.array(z.string()),
		reasons: z.array(z.string()).optional(),
		events: z.array(z.string()),
	}),
	github: z
		.strictObject({
			reservedPrefix: z.string().min(1).optional(),
		})
		.optional(),
	concurrency: z.strictObject({
		perIssue: z.literal(1),
		perWorkflow: z.number().int().positive().optional(),
		perKind: z.record(z.string(), z.number().int().positive()).optional(),
	}),
	readiness: z
		.strictObject({
			filters: z.array(
				z.strictObject({
					kind: z.string().optional(),
					state: z.string().optional(),
					action: z.string().optional(),
					reason: z.string().optional(),
				}),
			),
			namedFilters: z
				.array(
					z.strictObject({
						name: z.string(),
						kind: z.string(),
						relationship: z.literal("parent"),
					}),
				)
				.optional(),
		})
		.optional(),
	lifecycle: z
		.strictObject({
			retry: z
				.strictObject({
					allow: z.array(lifecyclePolicyTargetSchema).optional(),
				})
				.optional(),
			escalation: z
				.strictObject({
					allow: z.array(lifecyclePolicyTargetSchema).optional(),
				})
				.optional(),
			resume: z
				.strictObject({
					allow: z
						.array(
							z.strictObject({
								kind: z.string(),
								actions: z.array(z.string()),
							}),
						)
						.optional(),
				})
				.optional(),
		})
		.optional(),
	kinds: z.array(
		z.strictObject({
			id: z.string(),
			label: z.string().min(1),
			initial: stateReferenceSchema,
			transitions: z.array(
				z.strictObject({
					from: stateReferenceSchema,
					event: z.string(),
					input: payloadZodSchemaSchema.optional(),
					to: stateReferenceSchema,
				}),
			),
		}),
	),
	commands: z.array(
		z.strictObject({
			id: z.string(),
			cli: z
				.strictObject({
					verb: z.enum(["create", "apply"]),
					target: z.string(),
				})
				.optional(),
			target: z.strictObject({ kind: z.string(), action: z.string() }),
			input: payloadZodSchemaSchema.optional(),
			output: payloadZodSchemaSchema.optional(),
		}),
	),
	relationships: z
		.array(
			z.strictObject({
				id: z.string(),
				from: z.string(),
				to: z.string(),
				projection: z.strictObject({
					type: z.enum(["parent-child", "dependency"], {
						error:
							"Relationship projection type must be parent-child or dependency.",
					}),
					direction: z.enum(["outbound", "inbound"]).optional(),
				}),
			}),
		)
		.optional(),
});

export function defineManifest(
	manifest: WorkflowManifestDefinition,
): WorkflowManifest {
	return normalizeManifest(manifest);
}

function isPayloadZodSchema(value: unknown): value is PayloadZodSchema {
	return value instanceof z.ZodType;
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
	return normalizeManifest(manifest);
}

export function validateManifest(value: unknown): Array<ValidationIssue> {
	const issues: Array<ValidationIssue> = zodValidationIssues(value);

	if (!isRecord(value)) {
		return uniqueIssues([
			...issues,
			{ path: "$", message: "Manifest must be an object." },
		]);
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

	const commandIds = new Set<string>();
	const commandDeclarations = new Set<string>();
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
			commandIds,
			commandDeclarations,
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

	return uniqueIssues(issues);
}

function zodValidationIssues(value: unknown): Array<ValidationIssue> {
	const result = manifestSchema.safeParse(value);
	if (result.success) {
		return [];
	}
	return result.error.issues.map((issue) => ({
		path: formatZodPath(issue.path),
		message: issue.message,
	}));
}

function formatZodPath(path: ReadonlyArray<PropertyKey>): string {
	let formatted = "$";
	for (const part of path) {
		if (typeof part === "number") {
			formatted = `${formatted}[${part}]`;
		} else {
			formatted = `${formatted}.${String(part)}`;
		}
	}
	return formatted;
}

function uniqueIssues(issues: Array<ValidationIssue>): Array<ValidationIssue> {
	const seen = new Set<string>();
	return issues.filter((issue) => {
		const key = `${issue.path}\0${issue.message}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function extractManifest(loaded: unknown): WorkflowManifestDefinition {
	if (isRecord(loaded) && "manifest" in loaded) {
		return loaded.manifest as WorkflowManifestDefinition;
	}
	return loaded as WorkflowManifestDefinition;
}

function normalizeManifest(
	manifest: WorkflowManifestDefinition,
): WorkflowManifest {
	return {
		...manifest,
		github: { reservedPrefix: manifest.github?.reservedPrefix ?? "awf" },
		kinds: manifest.kinds,
		commands: manifest.commands,
	};
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
	if (value === undefined) {
		return;
	}
	if (!isRecord(value)) {
		issue(issues, "$.github", "GitHub metadata must be an object.");
		return;
	}
	if (
		value.reservedPrefix !== undefined &&
		(typeof value.reservedPrefix !== "string" || value.reservedPrefix === "")
	) {
		issue(
			issues,
			"$.github.reservedPrefix",
			"Reserved prefix must be a non-empty string.",
		);
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
		validatePayloadZodSchema(value.input, `${path}.input`, issues);
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
	const filterDeclarations = new Set<string>();
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
		const key = [filter.kind, filter.state, filter.action, filter.reason]
			.map((part) => String(part ?? "*"))
			.join("/");
		if (filterDeclarations.has(key)) {
			issue(issues, path, `Duplicate readiness filter declaration '${key}'.`);
		}
		filterDeclarations.add(key);
	}
	const namedFilterNames = new Set<string>();
	for (const [index, filter] of readArray(
		value.namedFilters ?? [],
		"$.readiness.namedFilters",
		issues,
	).entries()) {
		const path = `$.readiness.namedFilters[${index}]`;
		if (!isRecord(filter)) {
			issue(issues, path, "Named readiness filter must be an object.");
			continue;
		}
		validateId(filter.name, `${path}.name`, issues);
		if (typeof filter.name === "string") {
			if (namedFilterNames.has(filter.name)) {
				issue(
					issues,
					`${path}.name`,
					`Duplicate readiness filter name '${filter.name}'.`,
				);
			}
			namedFilterNames.add(filter.name);
		}
		if (typeof filter.kind !== "string" || !kindIds.has(filter.kind)) {
			issue(
				issues,
				`${path}.kind`,
				"Named readiness filter kind must be known.",
			);
		}
		if (filter.relationship !== "parent") {
			issue(
				issues,
				`${path}.relationship`,
				"Named readiness filter relationship must be parent.",
			);
		}
	}
}

function validateCommand(
	value: unknown,
	path: string,
	kindIds: Set<string>,
	actions: Set<string>,
	kindActions: Map<string, Set<string>>,
	commandIds: Set<string>,
	commandDeclarations: Set<string>,
	issues: Array<ValidationIssue>,
): void {
	if (!isRecord(value)) {
		issue(issues, path, "Command must be an object.");
		return;
	}
	validateUniqueId(value.id, path, commandIds, issues);
	if (value.cli !== undefined) {
		if (!isRecord(value.cli)) {
			issue(
				issues,
				`${path}.cli`,
				"Command CLI declaration must be an object.",
			);
		} else {
			if (value.cli.verb !== "create" && value.cli.verb !== "apply") {
				issue(
					issues,
					`${path}.cli.verb`,
					"Command CLI verb must be create or apply.",
				);
			}
			validateId(value.cli.target, `${path}.cli.target`, issues);
			if (
				typeof value.cli.verb === "string" &&
				typeof value.cli.target === "string"
			) {
				const declaration = `${value.cli.verb} ${value.cli.target}`;
				if (commandDeclarations.has(declaration)) {
					issue(
						issues,
						`${path}.cli`,
						`Duplicate command target declaration '${declaration}'.`,
					);
				}
				commandDeclarations.add(declaration);
			}
		}
	}
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
		validatePayloadZodSchema(value.input, `${path}.input`, issues);
	}
	if (value.output !== undefined) {
		validatePayloadZodSchema(value.output, `${path}.output`, issues);
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
	if (!["parent-child", "dependency"].includes(String(value.projection.type))) {
		issue(
			issues,
			`${path}.projection.type`,
			"Relationship projection type must be parent-child or dependency.",
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

function validatePayloadZodSchema(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (!isPayloadZodSchema(value)) {
		issue(issues, path, "Payload schema must be a Zod schema.");
	}
}

function rejectExecutableData(
	value: unknown,
	path: string,
	issues: Array<ValidationIssue>,
): void {
	if (isPayloadZodSchema(value)) {
		return;
	}
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
	if (isPayloadZodSchema(value)) {
		return;
	}
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
