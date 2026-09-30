import type { JsonValue } from "type-fest";
import { describe, expect, it } from "vitest";
import { createInMemoryTracker } from "../../../src/adapters/trackers/memory.ts";
import type { SeedIssueInput } from "../../../src/domain/workflow/issue.ts";
import type { LegacyTaskKindMigrationResult } from "../../../src/runtime/commands/migrate.ts";
import { agentWorkflowManifest } from "../../../src/workflows/agent-workflow/index.ts";
import { execute as rawExecute } from "../../support/execute.ts";

function execute(
	args: Parameters<typeof rawExecute>[0],
	options: Parameters<typeof rawExecute>[1] = {},
): ReturnType<typeof rawExecute> {
	return rawExecute(args, { manifest: agentWorkflowManifest, ...options });
}

describe("when migrating legacy task subkind data", () => {
	it("should dry-run concrete Task kind rewrites without mutating issues", async () => {
		const tracker = createInMemoryTracker({
			issues: [
				legacyTask("1", { subkind: "work", profile: "implement" }),
				legacyTask("2", { subkind: "research", profile: "research" }),
				legacyTask("3", { subkind: "prototype", profile: "prototype" }),
				legacyTask("4", { subkind: "work", profile: "integration-test" }),
				legacyTask("5", { subkind: "work", profile: "merge" }),
			],
		});

		const envelope = await execute(["migrate", "legacy-task-subkinds"], {
			tracker,
		});

		expect(envelope.ok).toBe(true);
		expect(envelope.ok ? envelope.data : {}).toMatchObject({
			mode: "dry-run",
			status: "would-migrate",
			scanned: 5,
			migrated: 0,
		});
		const data = envelope.ok
			? (envelope.data as LegacyTaskKindMigrationResult)
			: undefined;
		expect(data?.diagnostics).toMatchObject([
			{ id: "1", toKind: "task:work", applied: false },
			{ id: "2", toKind: "task:research", applied: false },
			{ id: "3", toKind: "task:prototype", applied: false },
			{ id: "4", toKind: "task:work:integration-test", applied: false },
			{ id: "5", toKind: "task:work:merge", applied: false },
		]);
		expect((await tracker.getIssue("1")).workflow.kind).toBe("task");
	});

	it("should apply migrations, remove legacy subkind, and preserve profile", async () => {
		const tracker = createInMemoryTracker({
			issues: [legacyTask("1", { subkind: "work", profile: "implement" })],
		});

		const envelope = await execute(
			["migrate", "legacy-task-subkinds", "--apply"],
			{ tracker },
		);

		expect(envelope.ok).toBe(true);
		expect(envelope.ok ? envelope.data : {}).toMatchObject({
			mode: "apply",
			status: "migrated",
			migrated: 1,
		});
		expect((await tracker.getIssue("1")).workflow).toMatchObject({
			kind: "task:work",
			data: { profile: "implement" },
		});
		expect((await tracker.getIssue("1")).workflow.data).not.toHaveProperty(
			"subkind",
		);
	});

	it("should leave unmapped profiles as ordinary work Task routing data", async () => {
		const tracker = createInMemoryTracker({
			issues: [legacyTask("1", { subkind: "work", profile: "review" })],
		});

		await execute(["migrate", "legacy-task-subkinds", "--apply"], {
			tracker,
		});

		expect((await tracker.getIssue("1")).workflow).toMatchObject({
			kind: "task:work",
			data: { profile: "review" },
		});
	});

	it("should block malformed legacy subkind data without partial mutation", async () => {
		const tracker = createInMemoryTracker({
			issues: [
				legacyTask("1", { subkind: "work", profile: "implement" }),
				legacyTask("2", { subkind: 7, profile: "implement" }),
			],
		});

		const envelope = await execute(
			["migrate", "legacy-task-subkinds", "--apply"],
			{ tracker },
		);

		expect(envelope.ok).toBe(true);
		expect(envelope.ok ? envelope.data : {}).toMatchObject({
			status: "blocked",
			migrated: 0,
		});
		const data = envelope.ok
			? (envelope.data as LegacyTaskKindMigrationResult)
			: undefined;
		expect(data?.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "LEGACY_TASK_SUBKIND_MALFORMED",
				id: "2",
			}),
		);
		expect((await tracker.getIssue("1")).workflow.kind).toBe("task");
	});

	it("should be idempotent after applying once", async () => {
		const tracker = createInMemoryTracker({
			issues: [legacyTask("1", { subkind: "work", profile: "implement" })],
		});

		await execute(["migrate", "legacy-task-subkinds", "--apply"], {
			tracker,
		});
		const envelope = await execute(
			["migrate", "legacy-task-subkinds", "--apply"],
			{ tracker },
		);

		expect(envelope.ok).toBe(true);
		expect(envelope.ok ? envelope.data : {}).toMatchObject({
			status: "clean",
			migrated: 0,
			diagnostics: [],
		});
	});
});

function legacyTask(
	id: string,
	data: Record<string, JsonValue>,
): SeedIssueInput {
	return {
		id,
		title: `Legacy task ${id}`,
		workflow: { kind: "task", state: "ready", action: "work", data },
	};
}
