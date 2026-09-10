import { it, expect } from "vitest";
import {
	createTrackerAdapter,
	createTrackerIntentModule,
	type TrackerIntentModulePrimitives,
} from "../../src/tracker-intents.ts";
import { NeedReconciliationError, type Tracker } from "../../src/ports/tracker.ts";
import { WorkflowTrackerState } from "../../src/adapters/trackers/state.ts";
import type {
	CreateIssueInput,
	UpdateIssueInput,
	WorkflowIssue,
} from "../../src/domain/workflow/issue.ts";
import type { WorkflowLog } from "../../src/domain/workflow/log.ts";

type RemovedLifecycleIntentKeys = Extract<
	keyof Tracker,
	| "startRun"
	| "completeRun"
	| "escalateWorkflow"
	| "resumeWorkflow"
	| "advanceWorkflow"
>;
type AssertPublicTrackerLifecycleIntentsRemoved<T extends never> = T;
type _PublicTrackerLifecycleIntentContract =
	AssertPublicTrackerLifecycleIntentsRemoved<RemovedLifecycleIntentKeys>;

it("should ensure that tracker adapter composition exposes public intents without adapter-owned choreography", async () => {
	const state = new WorkflowTrackerState();
	const primitives = primitiveStubs({
		createIssue: async (input) => state.createIssue(input),
		updateIssue: async (id, input) => state.updateIssue(id, input),
		appendLog: async (id, input) => state.appendLog(id, input),
		getIssue: async (id) => state.getIssue(id),
		readLogs: async (id) => state.readLogs(id),
	});
	const tracker = createTrackerAdapter(primitives);

	const result = await tracker.createWorkflowIssue({
		title: "Ticket",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
		initialLog: { type: "created" },
	});

	expect(result.issue.id).toBe("1");
	expect(await tracker.readLogs("1")).toEqual([
		expect.objectContaining({ issueId: "1", sequence: 1, type: "created" }),
	]);
	expect(
		await tracker.createIssue(workflowIssueSeed("primitive", "Primitive")),
	).toEqual(expect.objectContaining({ id: "primitive", title: "Primitive" }));
});

it("should ensure that tracker intent module composes adapter primitives and verification hooks", async () => {
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
			verifyWorkflowEffects: (result, effects) => {
				state.verifyWorkflowEffects(result, effects);
				verified.push(
					`effects:${result.createdIssues.length}:${effects.length}`,
				);
			},
		},
	});

	const spec = await tracker.getIssue("spec-1");
	const result = await tracker.applyWorkflowEffects({
		effects: [
			{
				type: "create-workflow-issue",
				key: "first",
				input: {
					title: "First workflow issue",
					workflow: { kind: "item", state: "ready", action: "process" },
				},
			},
			{
				type: "create-workflow-issue",
				key: "second",
				input: {
					title: "Second workflow issue",
					workflow: { kind: "item", state: "blocked", action: "none" },
				},
			},
			{ type: "add-child", parent: { id: spec.id }, child: { key: "first" } },
			{ type: "add-child", parent: { id: spec.id }, child: { key: "second" } },
			{
				type: "add-dependency",
				issue: { key: "second" },
				blockedBy: { key: "first" },
			},
			{
				type: "update-workflow",
				issue: { id: spec.id },
				expect: { version: spec.workflow.version, hash: spec.workflow.hash },
				workflow: { state: "waiting", action: "none" },
			},
			{
				type: "record-command",
				issue: { id: spec.id },
				log: { type: "applied" },
			},
		],
	});

	expect(result.createdIssues.map(({ key, id }) => ({ key, id }))).toEqual([
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
	expect(result.logs).toEqual([expect.objectContaining({ type: "applied" })]);
	expect(verified).toEqual([
		"child:spec-1:1:true",
		"child:spec-1:2:true",
		"dependency:2:1:true",
		"effects:2:7",
	]);
});

it("should ensure that tracker intent module verifies generic workflow effects with adapter reads when hooks are absent", async () => {
	const state = new WorkflowTrackerState([
		{
			id: "spec-1",
			title: "Spec",
			workflow: { kind: "spec", state: "ready", action: "plan" },
		},
	]);
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			createIssue: async (input) => state.createIssue(input),
			updateIssue: async (id, input) => state.updateIssue(id, input),
			appendLog: async (id, input) => state.appendLog(id, input),
			addChild: async (parentId, childId) => state.addChild(parentId, childId),
			addDependency: async (issueId, blockedById) =>
				state.addDependency(issueId, blockedById),
			getIssue: async (id) => state.getIssue(id),
			readLogs: async (id) => state.readLogs(id),
		}),
	);
	const spec = await tracker.getIssue("spec-1");

	const result = await tracker.applyWorkflowEffects({
		effects: [
			{
				type: "create-workflow-issue",
				key: "setup",
				input: {
					title: "Set up",
					workflow: { kind: "item", state: "ready", action: "process" },
				},
			},
			{
				type: "create-workflow-issue",
				key: "finish",
				input: {
					title: "Finish",
					workflow: { kind: "item", state: "ready", action: "process" },
				},
			},
			{ type: "add-child", parent: { id: spec.id }, child: { key: "setup" } },
			{ type: "add-child", parent: { id: spec.id }, child: { key: "finish" } },
			{
				type: "add-dependency",
				issue: { key: "finish" },
				blockedBy: { key: "setup" },
			},
			{
				type: "update-workflow",
				issue: { id: spec.id },
				expect: { version: spec.workflow.version, hash: spec.workflow.hash },
				workflow: { state: "ready", action: "none" },
			},
			{
				type: "record-command",
				issue: { id: spec.id },
				log: {
					type: "workflow-applied",
					message: JSON.stringify({ input: "bundle.json" }),
				},
			},
		],
	});

	expect(result.createdIssues.map(({ key, id }) => ({ key, id }))).toEqual([
		{ key: "setup", id: "1" },
		{ key: "finish", id: "2" },
	]);
	expect((await tracker.getIssue("spec-1")).relationships.children).toEqual([
		"1",
		"2",
	]);
	expect((await tracker.getIssue("2")).relationships.dependencies).toEqual([
		"1",
	]);
	expect(result.logs.at(-1)?.message).toBe(
		JSON.stringify({ input: "bundle.json" }),
	);
});

it("should ensure that tracker intent module verifies relationship intents with adapter reads when hooks are absent", async () => {
	const state = new WorkflowTrackerState([
		workflowIssueSeed("parent", "Parent"),
		workflowIssueSeed("child", "Child"),
		workflowIssueSeed("blocker", "Blocker"),
	]);
	const calls: Array<string> = [];
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			addChild: async (parentId, childId) => {
				calls.push(`addChild:${parentId}:${childId}`);
				state.addChild(parentId, childId);
			},
			removeChild: async (parentId, childId) => {
				calls.push(`removeChild:${parentId}:${childId}`);
				state.removeChild(parentId, childId);
			},
			addDependency: async (issueId, blockedById) => {
				calls.push(`addDependency:${issueId}:${blockedById}`);
				state.addDependency(issueId, blockedById);
			},
			removeDependency: async (issueId, blockedById) => {
				calls.push(`removeDependency:${issueId}:${blockedById}`);
				state.removeDependency(issueId, blockedById);
			},
			getIssue: async (id) => {
				calls.push(`getIssue:${id}`);
				return state.getIssue(id);
			},
		}),
	);

	await tracker.changeRelationship({
		type: "add-child",
		parentId: "parent",
		childId: "child",
	});
	await tracker.changeRelationship({
		type: "add-dependency",
		issueId: "child",
		blockedById: "blocker",
	});
	await tracker.changeRelationship({
		type: "remove-dependency",
		issueId: "child",
		blockedById: "blocker",
	});
	await tracker.changeRelationship({
		type: "remove-child",
		parentId: "parent",
		childId: "child",
	});

	expect(calls).toEqual([
		"addChild:parent:child",
		"getIssue:parent",
		"getIssue:child",
		"addDependency:child:blocker",
		"getIssue:child",
		"getIssue:blocker",
		"removeDependency:child:blocker",
		"getIssue:child",
		"getIssue:blocker",
		"removeChild:parent:child",
		"getIssue:parent",
		"getIssue:child",
	]);
});

it("should ensure that tracker intent module reports relationship verification mismatches as reconciliation", async () => {
	const state = new WorkflowTrackerState([
		workflowIssueSeed("parent", "Parent"),
		workflowIssueSeed("child", "Child"),
	]);
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			addChild: async () => {},
			getIssue: async (id) => state.getIssue(id),
		}),
	);

	await expect(
		tracker.changeRelationship({
			type: "add-child",
			parentId: "parent",
			childId: "child",
		}),
	).rejects.toThrow(NeedReconciliationError);
});

it("should ensure that tracker intent module wraps relationship primitive failures as reconciliation", async () => {
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			addDependency: async () => {
				throw new Error("api unavailable");
			},
		}),
	);

	await expect(
		tracker.changeRelationship({
			type: "add-dependency",
			issueId: "child",
			blockedById: "blocker",
		}),
	).rejects.toThrow(NeedReconciliationError);
});

it("should ensure that tracker intent module creates workflow issues with initial logs and rereads", async () => {
	const calls: Array<string> = [];
	let storedIssue: WorkflowIssue = workflowIssue({
		id: "1",
		title: "Ticket before log",
	});
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			createIssue: async (input) => {
				calls.push(`createIssue:${input.title}`);
				return storedIssue;
			},
			appendLog: async (id, input) => {
				calls.push(`appendLog:${id}:${input.type}`);
				storedIssue = { ...storedIssue, title: "Ticket after log" };
				return { ...input, issueId: id, sequence: 1 };
			},
			getIssue: async (id) => {
				calls.push(`getIssue:${id}`);
				return storedIssue;
			},
		}),
	);

	const result = await tracker.createWorkflowIssue({
		title: "Ticket",
		workflow: { kind: "ticket", state: "ready", action: "implement" },
		initialLog: { type: "created" },
	});

	expect(result.issue.title).toBe("Ticket after log");
	expect(result.log).toEqual({ type: "created", issueId: "1", sequence: 1 });
	expect(calls).toEqual([
		"createIssue:Ticket",
		"appendLog:1:created",
		"getIssue:1",
	]);
});

it("should ensure that tracker intent module composes basic workflow mutation intents", async () => {
	const calls: Array<string> = [];
	const issue = workflowIssue({ id: "1", title: "Ticket" });
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			updateIssue: async (id, input) => {
				calls.push(
					`updateIssue:${id}:${input.workflow?.state ?? "none"}:${input.workflow?.action ?? "none"}`,
				);
				return {
					...issue,
					workflow: { ...issue.workflow, ...input.workflow },
				};
			},
			appendLog: async (id, input) => {
				calls.push(`appendLog:${id}:${input.type}`);
				return { ...input, issueId: id, sequence: calls.length };
			},
			getIssue: async (id) => {
				calls.push(`getIssue:${id}`);
				return issue;
			},
		}),
	);

	await tracker.recordCommand("1", { log: { type: "command" } });
	await tracker.repairIssue("1", {
		expect: { version: 1 },
		workflow: { state: "ready", action: "none" },
	});

	expect(calls).toEqual([
		"appendLog:1:command",
		"getIssue:1",
		"updateIssue:1:ready:none",
	]);
});

function workflowIssueSeed(id: string, title: string): CreateIssueInput {
	return {
		id,
		title,
		workflow: { kind: "ticket", state: "ready", action: "implement" },
	};
}

function workflowIssue(input: { id: string; title: string }): WorkflowIssue {
	return {
		...input,
		workflow: {
			kind: "ticket",
			state: "ready",
			action: "implement",
			version: 1,
			hash: "hash-1",
		},
		relationships: {
			children: [],
			dependencies: [],
			dependents: [],
		},
	};
}

function primitiveStubs(
	overrides: Partial<TrackerIntentModulePrimitives>,
): TrackerIntentModulePrimitives {
	const defaultIssue = workflowIssue({ id: "default", title: "Default" });
	return {
		createIssue: async () => defaultIssue,
		updateIssue: async () => defaultIssue,
		appendLog: async (id, input) => ({ ...input, issueId: id, sequence: 1 }),
		addChild: async () => {},
		removeChild: async () => {},
		addDependency: async () => {},
		removeDependency: async () => {},
		deleteIssue: async () => {},
		getIssue: async () => defaultIssue,
		listIssues: async () => [defaultIssue],
		readLogs: async () => [],
		...overrides,
	};
}
