import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	NeedReconciliationError,
	ProjectionConflictError,
	type SeedIssueInput,
	type Tracker,
} from "./tracker.ts";
import { createFileSystemTracker } from "./trackers/filesystem.ts";
import { createInMemoryTracker } from "./trackers/memory.ts";

type TrackerFixture = {
	tracker: Tracker;
	cleanup?: () => Promise<void>;
};

type TrackerFamily = {
	name: string;
	create: (seed?: Array<SeedIssueInput>) => Promise<TrackerFixture>;
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

			expect((await tracker.getIssue(created.issue.id)).workflow).toMatchObject({
				kind: "ticket",
				state: "ready",
				action: "implement",
			});
			expect(
				(await tracker.readLogs(created.issue.id)).map((log) => log.type),
			).toEqual([
				"workflow_created",
				"action_started",
				"action_resumed",
			]);
		});
	});

	test(`${family.name}: public Tracker API records relationships and plan outcomes`, async () => {
		await withTracker(
			family,
			async (tracker) => {
				const spec = await tracker.getIssue("spec-1");

				const result = await tracker.applyPlan({
					specId: "spec-1",
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
					artifacts: [{ kind: "file", uri: "plans/plan.json", name: "Plan" }],
					log: { type: "plan_applied", payload: { source: "planner" } },
				});

				expect(result.tickets.map((ticket) => ticket.key)).toEqual([
					"setup",
					"finish",
				]);
				const setupId = result.tickets[0]?.id ?? "missing-setup";
				const finishId = result.tickets[1]?.id ?? "missing-finish";
				expect((await tracker.getIssue("spec-1")).workflow.action).toBe("none");
				expect((await tracker.getIssue("spec-1")).relationships.children).toEqual([
					setupId,
					finishId,
				]);
				expect(
					(await tracker.getIssue(finishId)).relationships.dependencies,
				).toEqual([setupId]);
				expect(result.artifacts[0]).toMatchObject({
					kind: "file",
					uri: "plans/plan.json",
					name: "Plan",
				});
				expect((await tracker.readLogs("spec-1"))[0]?.payload).toEqual({
					source: "planner",
					tickets: result.tickets,
					artifacts: result.artifacts,
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

				const spec = await tracker.getIssue("spec-1");
				await expect(
					tracker.applyPlan({
						specId: "spec-1",
						expect: { version: spec.workflow.version, hash: spec.workflow.hash },
						specWorkflow: { state: "ready", action: "none" },
						tickets: [
							{
								key: "a",
								title: "A",
								workflow: {
									kind: "ticket",
									state: "ready",
									action: "implement",
								},
							},
						],
						artifacts: [{ kind: "file", uri: "https://example.com/not-a-file" }],
						log: { type: "plan_applied" },
					}),
				).rejects.toThrow(NeedReconciliationError);
				const partialChildren = (await tracker.getIssue("spec-1")).relationships
					.children;
				expect(partialChildren).toHaveLength(1);
				expect(await tracker.getIssue(partialChildren[0] ?? "missing-child")).toMatchObject(
					{ title: "A" },
				);
				const issueIds = (await tracker.listIssues()).map((issue) => issue.id);
				expect(issueIds).toHaveLength(3);
				expect(issueIds).toEqual(
					expect.arrayContaining([
						"spec-1",
						ticket.issue.id,
						partialChildren[0],
					]),
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
}

async function withTracker(
	family: TrackerFamily,
	fn: (tracker: Tracker) => Promise<void>,
	seed?: Array<SeedIssueInput>,
): Promise<void> {
	const fixture = await family.create(seed);
	try {
		await fn(fixture.tracker);
	} finally {
		await fixture.cleanup?.();
	}
}
