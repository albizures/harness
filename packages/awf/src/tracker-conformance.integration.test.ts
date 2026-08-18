import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	NeedReconciliationError,
	type TrackerAdapter,
	type TrackerCreateWorkflowIssueIntent,
} from "./tracker.ts";
import { createFileSystemTracker } from "./trackers/filesystem.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";
import { ProjectionConflictError } from "./workflow/projection.ts";

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
	test(`${family.name}: public Tracker API records workflow state and logs`, async () => {
		await withTracker(family, async (tracker) => {
			const created = await tracker.createWorkflowIssue({
				title: "Conformance ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				initialLog: { type: "workflow_created", payload: { source: "test" } },
			});

			const started = await tracker.startRun(created.issue.id, {
				expect: {
					version: created.issue.workflow.version,
					hash: created.issue.workflow.hash,
				},
				runId: "run-1",
				workflow: { state: "running", action: "implement" },
				log: { type: "action_started", runId: "run-1" },
			});
			await tracker.resumeWorkflow(created.issue.id, {
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

	test(`${family.name}: public Tracker API records relationships and plan outcomes`, async () => {
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
							type: "record-artifacts",
							issue: { id: "spec-1" },
							artifacts: [
								{ kind: "file", uri: "plans/workflow.json", name: "Workflow" },
							],
							log: {
								type: "workflow_applied",
								payload: { source: "workflow" },
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
				expect(result.artifacts[0]?.artifact).toMatchObject({
					kind: "file",
					uri: "plans/workflow.json",
					name: "Workflow",
				});
				expect((await tracker.readLogs("spec-1"))[0]?.payload).toEqual({
					source: "workflow",
				});
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

	test(`${family.name}: public Tracker API preserves JSON-compatible artifact metadata and log payloads`, async () => {
		await withTracker(family, async (tracker) => {
			const created = await tracker.createWorkflowIssue({
				title: "JSON conformance ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
				initialLog: {
					type: "workflow_created",
					payload: { nested: { values: ["one", 2, true, null] } },
				},
			});

			const artifact = await tracker.registerArtifact(created.issue.id, {
				kind: "file",
				uri: "docs/result.md",
				metadata: {
					count: 2,
					nested: { ok: true, values: ["alpha", null] },
				},
			});
			await tracker.recordCommand(created.issue.id, {
				log: {
					type: "json_payload_recorded",
					payload: { artifact, flags: [true, false], empty: null },
				},
			});

			expect((await tracker.getIssue(created.issue.id)).artifacts).toEqual([
				artifact,
			]);
			expect(
				(await tracker.readLogs(created.issue.id)).map((log) => log.payload),
			).toEqual([
				{ nested: { values: ["one", 2, true, null] } },
				{ artifact, flags: [true, false], empty: null },
			]);
		});
	});

	test(`${family.name}: public Tracker API records artifacts, changes, and terminal logs`, async () => {
		await withTracker(family, async (tracker) => {
			const created = await tracker.createWorkflowIssue({
				title: "Conformance ticket",
				workflow: { kind: "ticket", state: "ready", action: "implement" },
			});
			const started = await tracker.startRun(created.issue.id, {
				expect: {
					version: created.issue.workflow.version,
					hash: created.issue.workflow.hash,
				},
				runId: "run-1",
				workflow: { state: "running", action: "implement" },
				log: { type: "action_started", runId: "run-1" },
			});

			const completed = await tracker.completeRun(created.issue.id, {
				expect: {
					version: started.issue.workflow.version,
					hash: started.issue.workflow.hash,
				},
				runId: "run-1",
				workflow: { state: "done", action: "none" },
				artifacts: [{ kind: "file", uri: "docs/result.md" }],
				changes: [{ kind: "git-ref", uri: "abc123", summary: "Implemented" }],
				log: { type: "action_succeeded", runId: "run-1" },
			});

			expect(completed.issue.workflow).toMatchObject({
				state: "done",
				action: "none",
			});
			expect(completed.issue.workflow).not.toHaveProperty("activeRunId");
			expect(completed.issue.artifacts).toEqual(completed.artifacts);
			expect(completed.issue.changes).toEqual(completed.changes);
			expect(
				(await tracker.readLogs(created.issue.id)).map((log) => log.type),
			).toEqual(["action_started", "action_succeeded"]);
		});
	});

	test(`${family.name}: public Tracker API exposes conflicts and reconciliation-visible failures`, async () => {
		await withTracker(
			family,
			async (tracker) => {
				const ticket = await tracker.createWorkflowIssue({
					title: "Conflict ticket",
					workflow: { kind: "ticket", state: "ready", action: "implement" },
				});
				await tracker.advanceWorkflow(ticket.issue.id, {
					expect: {
						version: ticket.issue.workflow.version,
						hash: ticket.issue.workflow.hash,
					},
					workflow: { state: "running", activeRunId: "run-1" },
				});

				await expect(
					tracker.startRun(ticket.issue.id, {
						expect: {
							version: ticket.issue.workflow.version,
							hash: ticket.issue.workflow.hash,
						},
						runId: "run-2",
						workflow: { state: "running" },
						log: { type: "action_started", runId: "run-2" },
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
								type: "record-artifacts",
								issue: { id: "spec-1" },
								artifacts: [
									{ kind: "file", uri: "https://example.com/not-a-file" },
								],
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
