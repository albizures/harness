import { failure } from "../../envelope.ts";
import type { LifecycleTransitionHandlers } from "../../lifecycle-handlers.ts";

export const genericTaskLifecycleHandlers: LifecycleTransitionHandlers = {
	"wayfinder:ready/planning:succeed": validateWayfinderChildrenTerminal,
	"wayfinder:running/planning:succeed": validateWayfinderChildrenTerminal,
};

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
