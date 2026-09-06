import type { JsonValue } from "type-fest";
import { failure, type ErrorEnvelope } from "./envelope.ts";
import { isJsonRecord } from "./json.ts";
import type {
	ManifestTransition,
	WorkflowManifest,
} from "./manifest/manifest.ts";
import type { TrackerWorkflowEffect } from "./tracker.ts";
import type { WorkflowArtifactInput } from "./workflow/artifact.ts";
import type { WorkflowChange } from "./workflow/change.ts";
import type { WorkflowIssue } from "./workflow/issue.ts";

export type LifecycleTransitionHandlerContext = {
	manifest: WorkflowManifest;
	transition: ManifestTransition;
	issue: WorkflowIssue;
	event: string;
	input: JsonValue;
	runId?: string;
};

export type LifecycleTransitionHandlerContribution = {
	/** Additional JSON object fields to merge into the core lifecycle log payload. */
	log?: Record<string, unknown>;
	/** Artifacts to record on the transitioning issue with the core lifecycle log. */
	artifacts?: Array<WorkflowArtifactInput>;
	/** Changes to record on the transitioning issue with the core lifecycle log. */
	changes?: Array<Omit<WorkflowChange, "id">>;
	/** Additional declarative workflow effects to apply in the same verified batch. */
	effects?: Array<TrackerWorkflowEffect>;
};

export type LifecycleTransitionHandler = (
	context: LifecycleTransitionHandlerContext,
) =>
	| LifecycleTransitionHandlerContribution
	| ErrorEnvelope
	| undefined
	| Promise<LifecycleTransitionHandlerContribution | ErrorEnvelope | undefined>;

export type LifecycleTransitionHandlers = Record<
	string,
	LifecycleTransitionHandler
>;

export type ParsedLifecycleHandlerContribution = {
	log: Record<string, JsonValue>;
	artifacts: Array<WorkflowArtifactInput>;
	changes: Array<Omit<WorkflowChange, "id">>;
	effects: Array<TrackerWorkflowEffect>;
};

export function lifecycleTransitionHandlerKey(
	kind: string,
	from: { state: string; action?: string },
	event: string,
): string {
	return `${kind}:${from.state}/${from.action ?? "*"}:${event}`;
}

export function findLifecycleTransitionHandler(
	handlers: LifecycleTransitionHandlers | undefined,
	kind: string,
	transition: ManifestTransition,
): LifecycleTransitionHandler | undefined {
	return handlers?.[
		lifecycleTransitionHandlerKey(kind, transition.from, transition.event)
	];
}

export async function runLifecycleTransitionHandler(
	handlers: LifecycleTransitionHandlers | undefined,
	context: LifecycleTransitionHandlerContext,
): Promise<
	{ ok: true; contribution: ParsedLifecycleHandlerContribution } | ErrorEnvelope
> {
	const handler = findLifecycleTransitionHandler(
		handlers,
		context.issue.workflow.kind,
		context.transition,
	);
	if (handler === undefined) {
		return { ok: true, contribution: emptyContribution() };
	}
	let raw: LifecycleTransitionHandlerContribution | ErrorEnvelope | undefined;
	try {
		raw = await handler(context);
	} catch (error) {
		return failure(
			"LIFECYCLE_HANDLER_FAILED",
			"Lifecycle transition handler failed.",
			{
				key: lifecycleTransitionHandlerKey(
					context.issue.workflow.kind,
					context.transition.from,
					context.transition.event,
				),
				message: error instanceof Error ? error.message : String(error),
			},
		);
	}
	if (isErrorEnvelope(raw)) {
		return raw;
	}
	return parseLifecycleHandlerContribution(raw);
}

function emptyContribution(): ParsedLifecycleHandlerContribution {
	return { log: {}, artifacts: [], changes: [], effects: [] };
}

function parseLifecycleHandlerContribution(
	contribution: LifecycleTransitionHandlerContribution | undefined,
):
	| { ok: true; contribution: ParsedLifecycleHandlerContribution }
	| ErrorEnvelope {
	if (contribution === undefined) {
		return { ok: true, contribution: emptyContribution() };
	}
	const issues: Array<{ path: string; message: string }> = [];
	if (!isPlainObject(contribution)) {
		return failure(
			"LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED",
			"Lifecycle transition handler output is invalid.",
			{ issues: [{ path: "$", message: "Handler output must be an object." }] },
		);
	}
	if (contribution.log !== undefined && !isJsonRecord(contribution.log)) {
		issues.push({
			path: "$.log",
			message: "Handler log payload additions must be a JSON object.",
		});
	}
	if (
		contribution.artifacts !== undefined &&
		!Array.isArray(contribution.artifacts)
	) {
		issues.push({
			path: "$.artifacts",
			message: "Handler artifacts must be an array.",
		});
	}
	if (
		contribution.changes !== undefined &&
		!Array.isArray(contribution.changes)
	) {
		issues.push({
			path: "$.changes",
			message: "Handler changes must be an array.",
		});
	}
	if (
		contribution.effects !== undefined &&
		!Array.isArray(contribution.effects)
	) {
		issues.push({
			path: "$.effects",
			message: "Handler effects must be an array.",
		});
	}
	if (issues.length > 0) {
		return failure(
			"LIFECYCLE_HANDLER_OUTPUT_VALIDATION_FAILED",
			"Lifecycle transition handler output is invalid.",
			{ issues },
		);
	}
	return {
		ok: true,
		contribution: {
			log: (contribution.log ?? {}) as Record<string, JsonValue>,
			artifacts: contribution.artifacts ?? [],
			changes: contribution.changes ?? [],
			effects: contribution.effects ?? [],
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
	return (
		isPlainObject(value) &&
		value.ok === false &&
		isPlainObject(value.error) &&
		typeof value.error.code === "string" &&
		typeof value.error.message === "string"
	);
}
