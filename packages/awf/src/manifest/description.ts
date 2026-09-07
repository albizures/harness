import type {
	LifecyclePolicyTarget,
	ManifestReadinessFilter,
	ManifestWorkflowFilter,
	WorkflowManifest,
} from "./manifest.ts";

type ManifestStateReference = {
	state: string;
	action?: string;
	reason?: string | null;
};

export type WorkflowDescriptionStateRefV1 = {
	state: string;
	action?: string;
	reason?: string | null;
};

export type WorkflowDescriptionWorkflowFilterV1 = {
	kind?: string;
	state?: string;
	action?: string;
	reason?: string;
};

export type WorkflowDescriptionSchemaInputV1 = { required: boolean };
export type WorkflowDescriptionSchemaOutputV1 = { declared: boolean };

export type WorkflowDescriptionV1 = {
	version: "v1";
	workflow: { id: string };
	vocabulary: {
		states: Array<string>;
		actions: Array<string>;
		reasons?: Array<string>;
		events: Array<string>;
	};
	concurrency: {
		perIssue: 1;
		perWorkflow?: number;
		perKind?: Record<string, number>;
		perSubkind?: Record<string, Record<string, number>>;
	};
	kinds: Array<{
		id: string;
		label: string;
		initial: WorkflowDescriptionStateRefV1;
		subkinds?: Array<string>;
		transitions: Array<{
			from: WorkflowDescriptionStateRefV1;
			event: string;
			input: WorkflowDescriptionSchemaInputV1;
			to: WorkflowDescriptionStateRefV1;
		}>;
	}>;
	commands: Array<{
		id: string;
		target: { kind: string; action: string };
		cli?: {
			verb: "create" | "apply";
			target: string;
			source?: boolean;
			usage: string;
		};
		input: WorkflowDescriptionSchemaInputV1;
		output: WorkflowDescriptionSchemaOutputV1;
	}>;
	readiness?: {
		filters: Array<WorkflowDescriptionWorkflowFilterV1>;
		namedFilters?: Array<{
			name: string;
			kind: string;
			relationship: "parent";
			usage: string;
		}>;
		relationshipPolicies?: Array<{
			relationship: "children";
			where: WorkflowDescriptionWorkflowFilterV1;
			children: { all: WorkflowDescriptionWorkflowFilterV1; min?: number };
			gate?: string;
		}>;
	};
	lifecycle?: {
		retry?: { allow?: Array<{ kind: string; action: string }> };
		escalation?: {
			allow?: Array<{ kind: string; action: string }>;
			input: WorkflowDescriptionSchemaInputV1;
		};
		resume?: { allow?: Array<{ kind: string; actions: Array<string> }> };
		relationshipPolicies?: Array<{
			relationship: "parent";
			child: WorkflowDescriptionWorkflowFilterV1;
			parent: WorkflowDescriptionWorkflowFilterV1;
			siblings: { all: WorkflowDescriptionWorkflowFilterV1; min?: number };
			to: WorkflowDescriptionStateRefV1;
		}>;
	};
	relationships?: Array<{
		id: string;
		from: string;
		to: string;
		projection: {
			type: "parent-child" | "dependency" | "generated-by";
			direction?: "outbound" | "inbound";
		};
	}>;
	scopeNotes: Array<string>;
};

export const workflowDescriptionScopeNotes = [
	"Describes the loaded Workflow manifest only.",
	"Does not inspect Tracker API state, issue counts, active runs, actual dependencies, runtime handlers, config paths, raw Zod schemas, or parsed schema structures.",
] as const;

export function describeWorkflow(
	manifest: WorkflowManifest,
): WorkflowDescriptionV1 {
	return {
		version: "v1",
		workflow: { id: manifest.workflow.id },
		vocabulary: describeVocabulary(manifest),
		concurrency: describeConcurrency(manifest),
		kinds: manifest.kinds.map((kind) => ({
			id: kind.id,
			label: kind.label,
			initial: stateRef(kind.initial),
			...(kind.subkinds === undefined ? {} : { subkinds: [...kind.subkinds] }),
			transitions: kind.transitions.map((transition) => ({
				from: stateRef(transition.from),
				event: transition.event,
				input: inputMarker(transition.input),
				to: stateRef(transition.to),
			})),
		})),
		commands: manifest.commands.map((command) => ({
			id: command.id,
			target: { ...command.target },
			...(command.cli === undefined
				? {}
				: {
						cli: {
							...command.cli,
							usage: manifestCommandUsage(command.cli),
						},
					}),
			input: inputMarker(command.input),
			output: { declared: command.output !== undefined },
		})),
		...describeReadiness(manifest),
		...describeLifecycle(manifest),
		...(manifest.relationships === undefined
			? {}
			: {
					relationships: manifest.relationships.map((relationship) => ({
						id: relationship.id,
						from: relationship.from,
						to: relationship.to,
						projection: { ...relationship.projection },
					})),
				}),
		scopeNotes: [...workflowDescriptionScopeNotes],
	};
}

type ManifestCli = NonNullable<WorkflowManifest["commands"][number]["cli"]>;

export function manifestCommandUsage(cli: ManifestCli): string {
	if (cli.verb === "apply") {
		return `awf apply ${cli.target} <issue> --input <file|->`;
	}
	if (cli.source === true) {
		return `awf create ${cli.target} --source <issue> --input <file|->`;
	}
	return `awf create ${cli.target} --input <file|->`;
}

function describeVocabulary(manifest: WorkflowManifest) {
	return {
		states: [...manifest.vocabulary.states],
		actions: [...manifest.vocabulary.actions],
		...(manifest.vocabulary.reasons === undefined
			? {}
			: { reasons: [...manifest.vocabulary.reasons] }),
		events: [...manifest.vocabulary.events],
	};
}

function describeConcurrency(manifest: WorkflowManifest) {
	return {
		perIssue: manifest.concurrency.perIssue,
		...(manifest.concurrency.perWorkflow === undefined
			? {}
			: { perWorkflow: manifest.concurrency.perWorkflow }),
		...(manifest.concurrency.perKind === undefined
			? {}
			: { perKind: { ...manifest.concurrency.perKind } }),
		...(manifest.concurrency.perSubkind === undefined
			? {}
			: {
					perSubkind: Object.fromEntries(
						Object.entries(manifest.concurrency.perSubkind).map(
							([kind, limits]) => [kind, { ...limits }],
						),
					),
				}),
	};
}

function describeReadiness(manifest: WorkflowManifest) {
	if (manifest.readiness === undefined) {
		return {};
	}
	return {
		readiness: {
			filters: manifest.readiness.filters.map(workflowFilter),
			...(manifest.readiness.namedFilters === undefined
				? {}
				: {
						namedFilters: manifest.readiness.namedFilters.map((filter) => ({
							name: filter.name,
							kind: filter.kind,
							relationship: filter.relationship,
							usage: `awf ready --filter ${filter.name}=<${filter.kind}>`,
						})),
					}),
			...(manifest.readiness.relationshipPolicies === undefined
				? {}
				: {
						relationshipPolicies: manifest.readiness.relationshipPolicies.map(
							(policy) => ({
								relationship: policy.relationship,
								where: workflowFilter(policy.where),
								children: {
									all: workflowFilter(policy.children.all),
									...(policy.children.min === undefined
										? {}
										: { min: policy.children.min }),
								},
								...(policy.gate === undefined ? {} : { gate: policy.gate }),
							}),
						),
					}),
		},
	};
}

function describeLifecycle(manifest: WorkflowManifest) {
	if (manifest.lifecycle === undefined) {
		return {};
	}
	return {
		lifecycle: {
			...(manifest.lifecycle.retry === undefined
				? {}
				: {
						retry: {
							...(manifest.lifecycle.retry.allow === undefined
								? {}
								: { allow: manifest.lifecycle.retry.allow.map(policyTarget) }),
						},
					}),
			...(manifest.lifecycle.escalation === undefined
				? {}
				: {
						escalation: {
							...(manifest.lifecycle.escalation.allow === undefined
								? {}
								: {
										allow:
											manifest.lifecycle.escalation.allow.map(policyTarget),
									}),
							input: inputMarker(manifest.lifecycle.escalation.input),
						},
					}),
			...(manifest.lifecycle.resume === undefined
				? {}
				: {
						resume: {
							...(manifest.lifecycle.resume.allow === undefined
								? {}
								: {
										allow: manifest.lifecycle.resume.allow.map((target) => ({
											kind: target.kind,
											actions: [...target.actions],
										})),
									}),
						},
					}),
			...(manifest.lifecycle.relationshipPolicies === undefined
				? {}
				: {
						relationshipPolicies: manifest.lifecycle.relationshipPolicies.map(
							(policy) => ({
								relationship: policy.relationship,
								child: workflowFilter(policy.child),
								parent: workflowFilter(policy.parent),
								siblings: {
									all: workflowFilter(policy.siblings.all),
									...(policy.siblings.min === undefined
										? {}
										: { min: policy.siblings.min }),
								},
								to: stateRef(policy.to),
							}),
						),
					}),
		},
	};
}

function stateRef(
	reference: ManifestStateReference,
): WorkflowDescriptionStateRefV1 {
	return {
		state: reference.state,
		...(reference.action === undefined ? {} : { action: reference.action }),
		...(reference.reason === undefined ? {} : { reason: reference.reason }),
	};
}

function workflowFilter(
	filter: ManifestWorkflowFilter | ManifestReadinessFilter,
): WorkflowDescriptionWorkflowFilterV1 {
	return {
		...(filter.kind === undefined ? {} : { kind: filter.kind }),
		...(filter.state === undefined ? {} : { state: filter.state }),
		...(filter.action === undefined ? {} : { action: filter.action }),
		...(filter.reason === undefined ? {} : { reason: filter.reason }),
	};
}

function policyTarget(target: LifecyclePolicyTarget) {
	return { kind: target.kind, action: target.action };
}

function inputMarker(input: unknown): WorkflowDescriptionSchemaInputV1 {
	return { required: input !== undefined };
}
