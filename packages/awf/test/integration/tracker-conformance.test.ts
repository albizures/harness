import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	NeedReconciliationError,
	type TrackerAdapter,
	type TrackerCreateWorkflowIssueIntent,
	type TrackerLog,
	type TrackerProjectionExpectation,
	type TrackerWorkflow,
} from "../../src/tracker.ts";
import { createFileSystemTracker } from "../../src/trackers/filesystem.ts";
import { createInMemoryTracker } from "../../src/trackers/memory.ts";
import { ProjectionConflictError } from "../../src/workflow/projection.ts";

type TrackerFixture = {
	tracker: TrackerAdapter;
	cleanup?: () => Promise<void>;
};

type TrackerFamily = {
	name: string;
	create: (
		seed?: Array<TrackerCreateWorkflowIssueIntent>,
	) => Promise<TrackerFixture>;
};

async function applyWorkflowAndLog(
	tracker: TrackerAdapter,
	id: string,
	input: {
		expect: TrackerProjectionExpectation;
		workflow: TrackerWorkflow;
		log: TrackerLog;
	},
): Promise<{ issue: Awaited<ReturnType<TrackerAdapter["getIssue"]>> }> {
	const result = await tracker.applyWorkflowEffects({
		effects: [
			{
				type: "update-workflow",
				issue: { id },
				expect: input.expect,
				workflow: input.workflow,
			},
			{ type: "record-command", issue: { id }, log: input.log },
		],
	});
	return { issue: result.issues[id] ?? (await tracker.getIssue(id)) };
}

const trackerFamilies: Array<TrackerFamily> = [
	{
		name: "in-memory tracker",
		create: async (seed = []) => ({
			tracker: createInMemoryTracker({ issues: seed }),
		}),
	},
	{
		name: "file-backed tracker",
		create: async (seed = []) => {
			const dir = await mkdtemp(join(tmpdir(), "awf-conformance-"));
			const tracker = createFileSystemTracker({
				path: join(dir, "tracker.json"),
			});
			for (const issue of seed) {
				await tracker.createWorkflowIssue(issue);
			}
			return {
				tracker,
				cleanup: async () => {
					await rm(dir, { recursive: true, force: true });
				},
			};
		},
	},
];

for (const family of trackerFamilies) {
	it(`should record workflow state and logs for ${family.name}`, async () => {
		await withTracker(family, async (tracker) => {
			const created = await tracker.createWorkflowIssue({
				title: "Conformance ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				initialLog: { type: "workflow_created", message: "test" },
			});

			const started = await applyWorkflowAndLog(tracker, created.issue.id, {
				expect: {
					version: created.issue.workflow.version,
					hash: created.issue.workflow.hash,
				},
				workflow: {
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
				log: { type: "action_started", runId: "run-1" },
			});
			await applyWorkflowAndLog(tracker, created.issue.id, {
				expect: {
					version: started.issue.workflow.version,
					hash: started.issue.workflow.hash,
				},
				workflow: { state: "ready", action: "implement" },
				log: { type: "action_resumed", runId: "run-1" },
			});

			expect((await tracker.getIssue(created.issue.id)).workflow).toMatchObject(
				{
					kind: "ticket",
					state: "ready",
					action: "implement",
				},
			);
			expect(
				(await tracker.readLogs(created.issue.id)).map((log) => log.type),
			).toEqual(["workflow_created", "action_started", "action_resumed"]);
		});
	});

	it(`should record relationships and plan outcomes for ${family.name}`, async () => {
		await withTracker(
			family,
			async (tracker) => {
				const spec = await tracker.getIssue("spec-1");

				const result = await tracker.applyWorkflowEffects({
					effects: [
						{
							type: "create-workflow-issue",
							key: "setup",
							input: {
								title: "Set up",
								workflow: {
									kind: "ticket",
									state: "ready",
									action: "implement",
								},
							},
						},
						{
							type: "create-workflow-issue",
							key: "finish",
							input: {
								title: "Finish",
								workflow: {
									kind: "ticket",
									state: "ready",
									action: "implement",
								},
							},
						},
						{
							type: "add-child",
							parent: { id: "spec-1" },
							child: { key: "setup" },
						},
						{
							type: "add-child",
							parent: { id: "spec-1" },
							child: { key: "finish" },
						},
						{
							type: "add-dependency",
							issue: { key: "finish" },
							blockedBy: { key: "setup" },
						},
						{
							type: "update-workflow",
							issue: { id: "spec-1" },
							expect: {
								version: spec.workflow.version,
								hash: spec.workflow.hash,
							},
							workflow: { state: "ready", action: "none" },
						},
						{
							type: "record-command",
							issue: { id: "spec-1" },
							log: {
								type: "workflow_applied",
								message: JSON.stringify({ source: "workflow" }),
							},
						},
					],
				});

				expect(result.createdIssues.map((issue) => issue.key)).toEqual([
					"setup",
					"finish",
				]);
				const setupId = result.createdIssues[0]?.id ?? "missing-setup";
				const finishId = result.createdIssues[1]?.id ?? "missing-finish";
				expect((await tracker.getIssue("spec-1")).workflow.action).toBe("none");
				expect(
					(await tracker.getIssue("spec-1")).relationships.children,
				).toEqual([setupId, finishId]);
				expect(
					(await tracker.getIssue(finishId)).relationships.dependencies,
				).toEqual([setupId]);
				expect((await tracker.readLogs("spec-1"))[0]?.message).toBe(
					JSON.stringify({ source: "workflow" }),
				);
			},
			[
				{
					id: "spec-1",
					title: "Spec",
					workflow: { kind: "spec", state: "ready", action: "plan" },
				},
			],
		);
	});

	it(`should preserve JSON-compatible log payloads for ${family.name}`, async () => {
		await withTracker(family, async (tracker) => {
			const created = await tracker.createWorkflowIssue({
				title: "JSON conformance ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				initialLog: {
					type: "workflow_created",
					message: JSON.stringify({
						nested: { values: ["one", 2, true, null] },
					}),
				},
			});

			await tracker.recordCommand(created.issue.id, {
				log: {
					type: "json_payload_recorded",
					message: JSON.stringify({ flags: [true, false], empty: null }),
				},
			});

			expect(
				(await tracker.readLogs(created.issue.id)).map((log) => log.message),
			).toEqual([
				JSON.stringify({ nested: { values: ["one", 2, true, null] } }),
				JSON.stringify({ flags: [true, false], empty: null }),
			]);
		});
	});

	it(`should record terminal logs for ${family.name}`, async () => {
		await withTracker(family, async (tracker) => {
			const created = await tracker.createWorkflowIssue({
				title: "Conformance ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			});
			const started = await applyWorkflowAndLog(tracker, created.issue.id, {
				expect: {
					version: created.issue.workflow.version,
					hash: created.issue.workflow.hash,
				},
				workflow: {
					state: "running",
					action: "implement",
					activeRunId: "run-1",
				},
				log: { type: "action_started", runId: "run-1" },
			});

			const completed = await applyWorkflowAndLog(tracker, created.issue.id, {
				expect: {
					version: started.issue.workflow.version,
					hash: started.issue.workflow.hash,
				},
				workflow: {
					state: "done",
					action: "none",
					activeRunId: undefined,
				},
				log: { type: "action_succeeded", runId: "run-1" },
			});

			expect(completed.issue.workflow).toMatchObject({
				state: "done",
				action: "none",
			});
			expect(completed.issue.workflow).not.toHaveProperty("activeRunId");
			expect(completed.issue).not.toHaveProperty("artifacts");
			expect(completed.issue).not.toHaveProperty("changes");
			expect(
				(await tracker.readLogs(created.issue.id)).map((log) => log.type),
			).toEqual(["action_started", "action_succeeded"]);
		});
	});

	it(`should expose conflicts and reconciliation-visible failures for ${family.name}`, async () => {
		await withTracker(
			family,
			async (tracker) => {
				const ticket = await tracker.createWorkflowIssue({
					title: "Conflict ticket",
					workflow: { kind: "ticket", state: "ready", action: "implement" },
				});
				await tracker.applyWorkflowEffects({
					effects: [
						{
							type: "update-workflow",
							issue: { id: ticket.issue.id },
							expect: {
								version: ticket.issue.workflow.version,
								hash: ticket.issue.workflow.hash,
							},
							workflow: { state: "running", activeRunId: "run-1" },
						},
					],
				});

				await expect(
					tracker.applyWorkflowEffects({
						effects: [
							{
								type: "update-workflow",
								issue: { id: ticket.issue.id },
								expect: {
									version: ticket.issue.workflow.version,
									hash: ticket.issue.workflow.hash,
								},
								workflow: { state: "running" },
							},
							{
								type: "record-command",
								issue: { id: ticket.issue.id },
								log: { type: "action_started", runId: "run-2" },
							},
						],
					}),
				).rejects.toThrow(ProjectionConflictError);

				await expect(
					tracker.applyWorkflowEffects({
						effects: [
							{
								type: "create-workflow-issue",
								key: "a",
								input: {
									title: "A",
									workflow: {
										kind: "ticket",
										state: "ready",
										action: "implement",
									},
								},
							},
							{
								type: "add-child",
								parent: { id: "spec-1" },
								child: { key: "a" },
							},
							{
								type: "record-command",
								issue: { key: "missing" },
								log: { type: "workflow_applied" },
							},
						],
					}),
				).rejects.toThrow(NeedReconciliationError);
				const partialChildren = (await tracker.getIssue("spec-1")).relationships
					.children;
				expect(partialChildren).toHaveLength(0);
				const issueIds = (await tracker.listIssues()).map((issue) => issue.id);
				expect(issueIds).toEqual(["spec-1", ticket.issue.id]);
			},
			[
				{
					id: "spec-1",
					title: "Spec",
					workflow: { kind: "spec", state: "ready", action: "plan" },
				},
			],
		);
	});
}

async function withTracker(
	family: TrackerFamily,
	fn: (tracker: TrackerAdapter) => Promise<void>,
	seed?: Array<TrackerCreateWorkflowIssueIntent>,
): Promise<void> {
	const fixture = await family.create(seed);
	try {
		await fn(fixture.tracker);
	} finally {
		await fixture.cleanup?.();
	}
}
