import type { JsonValue } from "type-fest";
import { failure, type ErrorEnvelope } from "./envelope.ts";
import type {
	ManifestTransition,
	WorkflowManifest,
} from "./domain/manifest/schema.ts";
import type {
	TrackerAdapterPrimitiveReads,
	TrackerWorkflowEffect,
} from "./ports/tracker.ts";
import type { WorkflowIssue } from "./domain/workflow/issue.ts";

export type LifecycleTransitionHandlerContext = {
	manifest: WorkflowManifest;
	transition: ManifestTransition;
	issue: WorkflowIssue;
	tracker: TrackerAdapterPrimitiveReads;
	event: string;
	input: JsonValue;
};

export type LifecycleTransitionHandlerContribution = {
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
	return { effects: [] };
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
