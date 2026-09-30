import { readFile } from "node:fs/promises";
import { z } from "zod";
import { failure } from "../../runtime/envelope.ts";
import type { LifecycleTransitionHandlers } from "../../runtime/lifecycle-handlers.ts";
import type { TrackerWorkflowEffect } from "../../ports/tracker.ts";

const nonEmptyString = z.string().trim().min(1);
const wayfinderChildOutcomeSchema = z.strictObject({
	outcome: z.discriminatedUnion("type", [
		z.strictObject({
			type: z.literal("decision"),
			resolution: nonEmptyString,
			gist: nonEmptyString,
		}),
		z
			.strictObject({
				type: z.literal("out-of-scope"),
				reason: nonEmptyString.optional(),
				scopeNote: nonEmptyString.optional(),
			})
			.refine(
				(value) => value.reason !== undefined || value.scopeNote !== undefined,
				"Out-of-scope outcomes require a reason or scope note.",
			),
		z.strictObject({
			type: z.literal("completed"),
			facts: z.array(nonEmptyString).min(1),
		}),
	]),
	mapRevision: z
		.union([
			z.strictObject({ body: nonEmptyString }),
			z.strictObject({ bodyFile: nonEmptyString }),
		])
		.optional(),
});

export const agentWorkflowLifecycleHandlers: LifecycleTransitionHandlers = {
	"wayfinder:ready/planning:succeed": validateWayfinderChildrenTerminal,
	"wayfinder:running/planning:succeed": validateWayfinderChildrenTerminal,
	"task:running/work:succeed": validateWayfinderChildTerminalOutcome,
	"grilling:in-discussion/discuss:succeed":
		validateWayfinderChildTerminalOutcome,
};

async function validateWayfinderChildTerminalOutcome({
	issue,
	tracker,
	input,
}: Parameters<LifecycleTransitionHandlers[string]>[0]) {
	if (issue.relationships.parent === undefined) {
		return undefined;
	}
	const parent = await tracker.getIssue(issue.relationships.parent);
	if (parent.workflow.kind !== "wayfinder") {
		return undefined;
	}
	const parsed = wayfinderChildOutcomeSchema.safeParse(input);
	if (!parsed.success) {
		return failure(
			"WAYFINDER_CHILD_OUTCOME_INVALID",
			"Wayfinder child completion requires structured outcome data.",
			{
				id: issue.id,
				issues: parsed.error.issues.map((error) => ({
					path: error.path.map(String),
					message: error.message,
				})),
			},
		);
	}
	const effects: Array<TrackerWorkflowEffect> = [];
	if (parsed.data.mapRevision !== undefined) {
		const body = await mapRevisionBody(parsed.data.mapRevision, issue.id);
		if (body.ok === false) {
			return body;
		}
		effects.push({
			type: "update-issue",
			issue: { id: parent.id },
			expect: { version: parent.workflow.version, hash: parent.workflow.hash },
			body: body.value,
		});
	}
	return { effects };
}

async function mapRevisionBody(
	mapRevision: { body: string } | { bodyFile: string },
	issueId: string,
): Promise<{ ok: true; value: string } | ReturnType<typeof failure>> {
	if ("body" in mapRevision) {
		return { ok: true, value: mapRevision.body };
	}
	let value: string;
	try {
		value = await readFile(mapRevision.bodyFile, "utf8");
	} catch (error) {
		return failure(
			"WAYFINDER_CHILD_OUTCOME_INVALID",
			"Wayfinder child completion requires structured outcome data.",
			{
				id: issueId,
				issues: [
					{
						path: ["mapRevision", "bodyFile"],
						message: error instanceof Error ? error.message : String(error),
					},
				],
			},
		);
	}
	if (value.trim() === "") {
		return failure(
			"WAYFINDER_CHILD_OUTCOME_INVALID",
			"Wayfinder child completion requires structured outcome data.",
			{
				id: issueId,
				issues: [
					{
						path: ["mapRevision", "bodyFile"],
						message: "Map body revision file must not be empty.",
					},
				],
			},
		);
	}
	return { ok: true, value };
}

async function validateWayfinderChildrenTerminal({
	issue,
	tracker,
}: Parameters<LifecycleTransitionHandlers[string]>[0]) {
	const incomplete = [];
	for (const childId of issue.relationships.children) {
		const child = await tracker.getIssue(childId);
		if (child.workflow.state !== "done") {
			incomplete.push({
				id: child.id,
				title: child.title,
				workflow: {
					kind: child.workflow.kind,
					state: child.workflow.state,
					action: child.workflow.action,
				},
			});
		}
	}
	if (incomplete.length > 0) {
		return failure(
			"WAYFINDER_CHILDREN_INCOMPLETE",
			"Wayfinder completion requires all child Workflow issues to be done.",
			{ id: issue.id, blockedBy: incomplete },
		);
	}
	return undefined;
}
