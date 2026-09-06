import { z } from "zod";

export type Identifier = string;
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
	cli?: { verb: "create" | "apply"; target: Identifier; source?: boolean };
	target: { kind: Identifier; action: Identifier };
	input?: PayloadSchema;
	output?: PayloadSchema;
};

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

export type ManifestWorkflowFilter = {
	kind?: Identifier;
	state?: Identifier;
	action?: Identifier;
	reason?: Identifier;
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
		type: "parent-child" | "dependency";
		direction?: "outbound" | "inbound";
	};
};

export type LifecyclePolicyTarget = { kind: Identifier; action: Identifier };

export type ManifestLifecycleRelationshipPolicy = {
	relationship: "parent";
	child: ManifestWorkflowFilter;
	parent: ManifestWorkflowFilter;
	siblings: { all: ManifestWorkflowFilter; min?: number };
	to: ManifestStateReference;
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
		relationshipPolicies?: Array<ManifestReadinessRelationshipPolicy>;
	};
	lifecycle?: {
		retry?: { allow?: Array<LifecyclePolicyTarget> };
		escalation?: {
			allow?: Array<LifecyclePolicyTarget>;
			input?: PayloadSchema;
		};
		resume?: {
			allow?: Array<{ kind: Identifier; actions: Array<Identifier> }>;
		};
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
	reason: z.string().nullable().optional(),
});

const lifecyclePolicyTargetSchema = z.strictObject({
	kind: z.string(),
	action: z.string(),
});

const workflowFilterSchema = z.strictObject({
	kind: z.string().optional(),
	state: z.string().optional(),
	action: z.string().optional(),
	reason: z.string().optional(),
});

export const workflowManifestStructuralSchema = z.strictObject({
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
			retry: z
				.strictObject({
					allow: z.array(lifecyclePolicyTargetSchema).optional(),
				})
				.optional(),
			escalation: z
				.strictObject({
					allow: z.array(lifecyclePolicyTargetSchema).optional(),
					input: payloadZodSchemaSchema.optional(),
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
					source: z.boolean().optional(),
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
