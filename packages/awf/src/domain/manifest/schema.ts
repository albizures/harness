import { z } from "zod";

export type Identifier = string;
export type PayloadZodSchema = z.ZodType<unknown>;
export type PayloadSchema = PayloadZodSchema;

type ManifestStateReference = {
	state: Identifier;
	action?: Identifier;
};

export type ManifestTransition = {
	from: ManifestStateReference;
	event: Identifier;
	to: ManifestStateReference;
};

export type ManifestTransitionDefinition = ManifestTransition;

export type ManifestKind = {
	id: Identifier;
	label: string;
	initial: ManifestStateReference;
	subkinds?: Array<Identifier>;
	transitions: Array<ManifestTransition>;
};

export type ManifestKindDefinition = Omit<ManifestKind, "transitions"> & {
	transitions: Array<ManifestTransitionDefinition>;
};

export type ManifestCli = {
	verb: Identifier;
	target: Identifier;
};

export type ManifestCommand = {
	id: Identifier;
	cli?: ManifestCli;
	target: {
		kind: Identifier;
		state?: Identifier;
		action?: Identifier;
	};
	transition?: { event: Identifier; attempt?: "none" | "start" | "complete" };
	input?: PayloadSchema;
};

export type ManifestReadinessFilter = {
	kind?: Identifier;
	state?: Identifier;
	action?: Identifier;
};

export type ManifestNamedReadinessFilter = {
	name: Identifier;
	kind: Identifier;
	relationship: "parent";
};

export type ManifestWorkflowFilter = {
	kind?: Identifier;
	state?: Identifier;
	action?: Identifier;
};

export type ManifestReadinessRelationshipPolicy = {
	relationship: "children";
	where: ManifestWorkflowFilter;
	children: { all: ManifestWorkflowFilter; min?: number };
	gate?: Identifier;
};

export type ManifestRelationship = {
	id: Identifier;
	from: Identifier;
	to: Identifier;
	projection: {
		type: "parent-child" | "dependency" | "generated-by";
	};
};

export type ManifestLifecycleRelationshipPolicy = {
	relationship: "parent";
	child: ManifestWorkflowFilter;
	parent: ManifestWorkflowFilter;
	siblings: { all: ManifestWorkflowFilter; min?: number };
	to: ManifestStateReference;
};

export type WorkflowManifest = {
	version: "v1";
	workflow: { id: Identifier; version: string };
	vocabulary: {
		states: Array<Identifier>;
		actions: Array<Identifier>;
		events: Array<Identifier>;
	};
	github: {
		reservedPrefix: string;
	};
	concurrency: {
		perIssue: 1;
		perWorkflow?: number;
		perKind?: Record<string, number>;
		perSubkind?: Record<string, Record<string, number>>;
	};
	readiness?: {
		filters: Array<ManifestReadinessFilter>;
		namedFilters?: Array<ManifestNamedReadinessFilter>;
		relationshipPolicies?: Array<ManifestReadinessRelationshipPolicy>;
	};
	lifecycle?: {
		activeStates?: Array<Identifier>;
		terminalStates?: Array<Identifier>;
		relationshipPolicies?: Array<ManifestLifecycleRelationshipPolicy>;
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
	commands: Array<ManifestCommand>;
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

export function getKind(manifest: WorkflowManifest, name: string) {
	return manifest.kinds.find((candidate) => candidate.id === name);
}

export function isPayloadZodSchema(value: unknown): value is PayloadZodSchema {
	return value instanceof z.ZodType;
}

const payloadZodSchemaSchema = z.custom<PayloadZodSchema>(isPayloadZodSchema, {
	message: "Payload schema must be a Zod schema.",
});

const stateReferenceSchema = z.strictObject({
	state: z.string(),
	action: z.string().optional(),
});

const workflowFilterSchema = z.strictObject({
	kind: z.string().optional(),
	state: z.string().optional(),
	action: z.string().optional(),
});

export const workflowManifestStructuralSchema = z.strictObject({
	version: z.literal("v1"),
	workflow: z.strictObject({ id: z.string(), version: z.string() }),
	vocabulary: z.strictObject({
		states: z.array(z.string()),
		actions: z.array(z.string()),
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
		perSubkind: z
			.record(z.string(), z.record(z.string(), z.number().int().positive()))
			.optional(),
	}),
	readiness: z
		.strictObject({
			filters: z.array(workflowFilterSchema),
			namedFilters: z
				.array(
					z.strictObject({
						name: z.string(),
						kind: z.string(),
						relationship: z.literal("parent"),
					}),
				)
				.optional(),
			relationshipPolicies: z
				.array(
					z.strictObject({
						relationship: z.literal("children"),
						where: workflowFilterSchema,
						children: z.strictObject({
							all: workflowFilterSchema,
							min: z.number().int().nonnegative().optional(),
						}),
						gate: z.string().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
	lifecycle: z
		.strictObject({
			activeStates: z.array(z.string()).optional(),
			terminalStates: z.array(z.string()).optional(),
			relationshipPolicies: z
				.array(
					z.strictObject({
						relationship: z.literal("parent"),
						child: workflowFilterSchema,
						parent: workflowFilterSchema,
						siblings: z.strictObject({
							all: workflowFilterSchema,
							min: z.number().int().nonnegative().optional(),
						}),
						to: stateReferenceSchema,
					}),
				)
				.optional(),
		})
		.optional(),
	kinds: z.array(
		z.strictObject({
			id: z.string(),
			label: z.string().min(1),
			initial: stateReferenceSchema,
			subkinds: z.array(z.string()).optional(),
			transitions: z.array(
				z.strictObject({
					from: stateReferenceSchema,
					event: z.string(),
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
					verb: z.string().min(1),
					target: z.string(),
				})
				.optional(),
			target: workflowFilterSchema.extend({ kind: z.string() }),
			transition: z
				.strictObject({
					event: z.string(),
					attempt: z.enum(["none", "start", "complete"]).optional(),
				})
				.optional(),
			input: payloadZodSchemaSchema.optional(),
		}),
	),
	relationships: z
		.array(
			z.strictObject({
				id: z.string(),
				from: z.string(),
				to: z.string(),
				projection: z.strictObject({
					type: z.enum(["parent-child", "dependency", "generated-by"], {
						error:
							"Relationship projection type must be parent-child, dependency, or generated-by.",
					}),
				}),
			}),
		)
		.optional(),
});
