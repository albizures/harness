import { test, expect } from "vitest";
import {
	createTrackerAdapter,
	createTrackerIntentModule,
	type TrackerIntentModulePrimitives,
} from "./tracker-intents.ts";
import { NeedReconciliationError } from "./tracker.ts";
import type {
	CreateIssueInput,
	UpdateIssueInput,
	WorkflowArtifactInput,
	WorkflowChange,
	WorkflowIssue,
	WorkflowLog,
} from "./tracker.ts";
import { WorkflowTrackerState } from "./trackers/state.ts";

test("tracker adapter composition exposes public intents without adapter-owned choreography", async () => {
	const state = new WorkflowTrackerState();
	const primitives = primitiveStubs({
		createIssue: async (input) => state.createIssue(input),
		updateIssue: async (id, input) => state.updateIssue(id, input),
		appendLog: async (id, input) => state.appendLog(id, input),
		registerArtifact: async (issueId, input) =>
			state.registerArtifact(issueId, input),
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
	expect(await tracker.createIssue(workflowIssueSeed("primitive", "Primitive"))).toEqual(
		expect.objectContaining({ id: "primitive", title: "Primitive" }),
	);
});

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

test("tracker intent module verifies plan application with adapter reads when hooks are absent", async () => {
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
			registerArtifact: async (issueId, input) =>
				state.registerArtifact(issueId, input),
			getIssue: async (id) => state.getIssue(id),
			readLogs: async (id) => state.readLogs(id),
		}),
	);
	const spec = await tracker.getIssue("spec-1");

	const result = await tracker.applyPlan({
		specId: spec.id,
		expect: { version: spec.workflow.version, hash: spec.workflow.hash },
		specWorkflow: { state: "ready", action: "none" },
		tickets: [
			{
				key: "setup",
				title: "Set up",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			},
			{
				key: "finish",
				title: "Finish",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				dependsOn: ["setup"],
			},
		],
		artifacts: [{ kind: "file", uri: "plan.json", name: "Plan bundle" }],
		log: { type: "plan-applied", payload: { input: "plan.json" } },
	});

	expect(result.tickets).toEqual([
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
	expect(result.artifacts).toEqual([
		expect.objectContaining({
			id: "artifact-1",
			kind: "file",
			uri: "plan.json",
			name: "Plan bundle",
		}),
	]);
	expect(result.log.payload).toEqual({
		input: "plan.json",
		tickets: result.tickets,
		artifacts: result.artifacts,
	});
});

test("tracker intent module verifies relationship intents with adapter reads when hooks are absent", async () => {
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

test("tracker intent module reports relationship verification mismatches as reconciliation", async () => {
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

test("tracker intent module wraps relationship primitive failures as reconciliation", async () => {
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

test("tracker intent module creates workflow issues with initial logs and rereads", async () => {
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

test("tracker intent module composes basic workflow mutation intents", async () => {
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
	await tracker.advanceWorkflow("1", {
		expect: { version: 1 },
		workflow: { state: "running", action: "implement" },
	});
	await tracker.repairIssue("1", {
		expect: { version: 1 },
		workflow: { state: "ready", action: "none" },
	});
	await tracker.escalateWorkflow("1", {
		expect: { version: 1 },
		workflow: { state: "waiting", action: "none" },
		log: { type: "escalated" },
	});
	await tracker.resumeWorkflow("1", {
		expect: { version: 1 },
		workflow: { state: "ready", action: "implement" },
		log: { type: "resumed" },
	});

	expect(calls).toEqual([
		"appendLog:1:command",
		"getIssue:1",
		"updateIssue:1:running:implement",
		"updateIssue:1:ready:none",
		"updateIssue:1:waiting:none",
		"appendLog:1:escalated",
		"updateIssue:1:ready:implement",
		"appendLog:1:resumed",
	]);
});

test("tracker intent module starts runs by projecting the active run before logging", async () => {
	const calls: Array<string> = [];
	const issue = workflowIssue({ id: "1", title: "Ticket" });
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			updateIssue: async (id, input) => {
				calls.push(
					`updateIssue:${id}:${input.workflow?.state}:${input.workflow?.action}:${input.workflow?.activeRunId}`,
				);
				return {
					...issue,
					workflow: { ...issue.workflow, ...input.workflow },
				};
			},
			appendLog: async (id, input) => {
				calls.push(`appendLog:${id}:${input.type}:${input.runId}`);
				return { ...input, issueId: id, sequence: 1 };
			},
		}),
	);

	const result = await tracker.startRun("1", {
		expect: { version: 1, hash: "hash-1" },
		runId: "run-1",
		workflow: { state: "running", action: "implement" },
		log: { type: "run-started", runId: "run-1" },
	});

	expect(result.issue.workflow).toMatchObject({
		state: "running",
		action: "implement",
		activeRunId: "run-1",
	});
	expect(result.log).toMatchObject({
		type: "run-started",
		runId: "run-1",
		issueId: "1",
	});
	expect(calls).toEqual([
		"updateIssue:1:running:implement:run-1",
		"appendLog:1:run-started:run-1",
	]);
});

test("tracker intent module completes runs before recording outputs and terminal logs", async () => {
	const calls: Array<string> = [];
	let storedIssue: WorkflowIssue = {
		...workflowIssue({ id: "1", title: "Ticket" }),
		workflow: {
			...workflowIssue({ id: "1", title: "Ticket" }).workflow,
			state: "running",
			action: "implement",
			activeRunId: "run-1",
		},
	};
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			updateIssue: async (id, input) => {
				calls.push(
					`updateIssue:${id}:${input.workflow?.state}:${input.workflow?.action}:${String(input.workflow?.activeRunId)}`,
				);
				storedIssue = {
					...storedIssue,
					workflow: { ...storedIssue.workflow, ...input.workflow },
				};
				return storedIssue;
			},
			registerArtifact: async (issueId, input) => {
				calls.push(`registerArtifact:${issueId}:${input.kind}:${input.uri}`);
				const artifact = { ...input, type: input.type ?? input.kind, id: "artifact-1" };
				storedIssue = {
					...storedIssue,
					artifacts: [...storedIssue.artifacts, artifact],
				};
				return artifact;
			},
			registerChange: async (issueId, input) => {
				calls.push(`registerChange:${issueId}:${input.kind}:${input.uri}`);
				const change = { id: "change-1", ...input };
				storedIssue = {
					...storedIssue,
					changes: [...storedIssue.changes, change],
				};
				return change;
			},
			appendLog: async (id, input) => {
				calls.push(`appendLog:${id}:${input.type}:${input.runId}`);
				return { ...input, issueId: id, sequence: 1 };
			},
			getIssue: async (id) => {
				calls.push(`getIssue:${id}`);
				return storedIssue;
			},
		}),
	);

	const result = await tracker.completeRun("1", {
		expect: { version: 1, hash: "hash-1" },
		runId: "run-1",
		workflow: { state: "done", action: "none" },
		artifacts: [{ kind: "file", uri: "artifact.md" }],
		changes: [{ kind: "pull-request", uri: "https://github.com/o/r/pull/1" }],
		log: { type: "run-completed", runId: "run-1" },
	});

	expect(result.issue.workflow).toMatchObject({
		state: "done",
		action: "none",
		activeRunId: undefined,
	});
	expect(result.artifacts).toEqual([
		expect.objectContaining({ id: "artifact-1", kind: "file", uri: "artifact.md" }),
	]);
	expect(result.changes).toEqual([
		expect.objectContaining({
			id: "change-1",
			kind: "pull-request",
			uri: "https://github.com/o/r/pull/1",
		}),
	]);
	expect(result.log).toMatchObject({ type: "run-completed", runId: "run-1" });
	expect(calls).toEqual([
		"updateIssue:1:done:none:undefined",
		"registerArtifact:1:file:artifact.md",
		"registerChange:1:pull-request:https://github.com/o/r/pull/1",
		"appendLog:1:run-completed:run-1",
		"getIssue:1",
	]);
});

test("tracker intent module records artifacts, changes, and workflow logs together", async () => {
	const calls: Array<string> = [];
	let storedIssue = workflowIssue({ id: "1", title: "Ticket" });
	const tracker = createTrackerIntentModule(
		primitiveStubs({
			registerArtifact: async (issueId, input) => {
				calls.push(`registerArtifact:${issueId}:${input.kind}:${input.uri}`);
				const artifact = { ...input, type: input.type ?? input.kind, id: "artifact-1" };
				storedIssue = {
					...storedIssue,
					artifacts: [...storedIssue.artifacts, artifact],
				};
				return artifact;
			},
			registerChange: async (issueId, input) => {
				calls.push(`registerChange:${issueId}:${input.kind}:${input.uri}`);
				const change = { id: "change-1", ...input };
				storedIssue = {
					...storedIssue,
					changes: [...storedIssue.changes, change],
				};
				return change;
			},
			appendLog: async (id, input) => {
				calls.push(`appendLog:${id}:${input.type}`);
				return { ...input, issueId: id, sequence: 1 };
			},
			getIssue: async (id) => {
				calls.push(`getIssue:${id}`);
				return storedIssue;
			},
		}),
	);

	const result = await tracker.recordArtifacts("1", {
		artifacts: [{ kind: "file", uri: "notes.md" }],
		changes: [{ kind: "pull-request", uri: "https://github.com/o/r/pull/2" }],
		log: { type: "artifacts-recorded" },
	});

	expect(result.issue.artifacts).toEqual(result.artifacts);
	expect(result.issue.changes).toEqual(result.changes);
	expect(result.log).toMatchObject({ type: "artifacts-recorded", issueId: "1" });
	expect(calls).toEqual([
		"registerArtifact:1:file:notes.md",
		"registerChange:1:pull-request:https://github.com/o/r/pull/2",
		"appendLog:1:artifacts-recorded",
		"getIssue:1",
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
		artifacts: [],
		changes: [],
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
		registerArtifact: async (_issueId, input) => ({
			...input,
			type: input.type ?? input.kind,
			id: input.id ?? "artifact-1",
		}),
		registerChange: async (_issueId, input) => ({ id: "change-1", ...input }),
		getIssue: async () => defaultIssue,
		listIssues: async () => [defaultIssue],
		readLogs: async () => [],
		...overrides,
	};
}
