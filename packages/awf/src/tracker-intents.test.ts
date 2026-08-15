import { test, expect } from "vitest";
import { createTrackerIntentModule } from "./tracker-intents.ts";
import type {
	CreateIssueInput,
	UpdateIssueInput,
	WorkflowArtifactInput,
	WorkflowChange,
	WorkflowLog,
} from "./tracker.ts";
import { WorkflowTrackerState } from "./trackers/state.ts";

test("tracker intent module composes adapter primitives and verification hooks", async () => {
	const state = new WorkflowTrackerState([
		{
			id: "spec-1",
			title: "Spec",
			workflow: {
				kind: "spec",
				state: "running",
				action: "plan",
				reason: "test",
			},
		},
	]);
	const verified: Array<string> = [];
	const tracker = createTrackerIntentModule({
		createIssue: async (input: CreateIssueInput) => state.createIssue(input),
		updateIssue: async (id: string, input: UpdateIssueInput) =>
			state.updateIssue(id, input),
		appendLog: async (
			id: string,
			input: Omit<WorkflowLog, "sequence" | "issueId">,
		) => state.appendLog(id, input),
		addChild: async (parentId: string, childId: string) =>
			state.addChild(parentId, childId),
		removeChild: async (parentId: string, childId: string) =>
			state.removeChild(parentId, childId),
		addDependency: async (issueId: string, blockedById: string) =>
			state.addDependency(issueId, blockedById),
		removeDependency: async (issueId: string, blockedById: string) =>
			state.removeDependency(issueId, blockedById),
		deleteIssue: async (id: string) => state.deleteIssue(id),
		registerArtifact: async (issueId: string, input: WorkflowArtifactInput) =>
			state.registerArtifact(issueId, input),
		registerChange: async (
			issueId: string,
			input: Omit<WorkflowChange, "id">,
		) => state.registerChange(issueId, input),
		getIssue: async (id: string) => state.getIssue(id),
		listIssues: async () => state.listIssues(),
		readLogs: async (id: string) => state.readLogs(id),
		verification: {
			verifyChild: (parentId, childId, expected) => {
				state.verifyChild(parentId, childId, expected);
				verified.push(`child:${parentId}:${childId}:${expected}`);
			},
			verifyDependency: (issueId, blockedById, expected) => {
				state.verifyDependency(issueId, blockedById, expected);
				verified.push(`dependency:${issueId}:${blockedById}:${expected}`);
			},
			verifyPlanApplication: (specId, tickets, inputs) => {
				state.verifyPlanApplication(specId, tickets, inputs);
				verified.push(`plan:${specId}:${tickets.length}:${inputs.length}`);
			},
		},
	});

	const spec = await tracker.getIssue("spec-1");
	const result = await tracker.applyPlan({
		specId: spec.id,
		expect: { version: spec.workflow.version, hash: spec.workflow.hash },
		specWorkflow: { state: "waiting", action: "none" },
		tickets: [
			{
				key: "first",
				title: "First ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
			{
				key: "second",
				title: "Second ticket",
				workflow: { kind: "ticket", state: "blocked", action: "none" },
				dependsOn: ["first"],
			},
		],
		log: { type: "plan-applied" },
	});

	expect(result.tickets).toEqual([
		{ key: "first", id: "1" },
		{ key: "second", id: "2" },
	]);
	expect((await tracker.getIssue("spec-1")).relationships.children).toEqual([
		"1",
		"2",
	]);
	expect((await tracker.getIssue("2")).relationships.dependencies).toEqual([
		"1",
	]);
	expect(result.log.payload).toMatchObject({ tickets: result.tickets });
	expect(verified).toEqual([
		"child:spec-1:1:true",
		"child:spec-1:2:true",
		"dependency:2:1:true",
		"plan:spec-1:2:2",
	]);
});
