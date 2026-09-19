import { describe, expect, it } from "vitest";
import {
	createKindRegistry,
	defineManifest,
	validateManifest,
} from "../../src/manifest/index.ts";
import {
	concurrencyBlocking,
	workflowMatchesFilter,
} from "../../src/runtime/commands/shared.ts";

function hierarchicalManifest() {
	return defineManifest({
		version: "v1",
		workflow: { id: "hierarchical-kinds", version: "1.0.0" },
		vocabulary: {
			states: ["ready", "running", "done"],
			actions: ["work", "none"],
			events: ["start", "succeed"],
		},
		concurrency: { perIssue: 1, perKind: { task: 3 } },
		lifecycle: { activeStates: ["running"], terminalStates: ["done"] },
		readiness: { filters: [{ kind: "task", state: "ready", action: "work" }] },
		kinds: [
			{
				id: "task",
				label: "Task",
				initial: { state: "ready", action: "work" },
				transitions: [
					{
						from: { state: "ready", action: "work" },
						event: "start",
						to: { state: "running", action: "work" },
					},
				],
			},
			{
				id: "task:work",
				label: "Work task",
				transitions: [
					{
						from: { state: "running", action: "work" },
						event: "succeed",
						to: { state: "done", action: "none" },
					},
				],
			},
			{ id: "task:work:merge", label: "Merge task" },
			{
				id: "taskish",
				label: "Delimiter safety probe",
				initial: { state: "ready", action: "work" },
				transitions: [],
			},
		],
		commands: [
			{
				id: "start-merge-task",
				target: { kind: "task:work:merge", state: "ready", action: "work" },
				transition: { event: "start", attempt: "start" },
			},
		],
	});
}

describe("when normalizing hierarchical workflow kinds", () => {
	it("should inherit initial state and transitions through implicit colon ancestry", () => {
		const manifest = hierarchicalManifest();
		const merge = manifest.kinds.find((kind) => kind.id === "task:work:merge");

		expect(merge?.initial).toEqual({ state: "ready", action: "work" });
		expect(merge?.transitions.map((transition) => transition.event)).toEqual([
			"start",
			"succeed",
		]);
		expect(validateManifest(manifest)).toEqual([]);
	});

	it("should provide exact and family lookup without unsafe prefix matching", () => {
		const registry = createKindRegistry(hierarchicalManifest());

		expect(registry.getExact("task")?.id).toBe("task");
		expect(registry.getExact("task:work")?.id).toBe("task:work");
		expect(registry.getFamily("task").map((kind) => kind.id)).toEqual([
			"task",
			"task:work",
			"task:work:merge",
		]);
		expect(registry.isMemberOf("task:work:merge", "task:work")).toBe(true);
		expect(registry.isMemberOf("taskish", "task")).toBe(false);
		expect(registry.getFamily("missing")).toEqual([]);
		expect(registry.isMemberOf("missing:child", "missing")).toBe(false);
	});

	it("should apply per-kind concurrency to hierarchical kind families", () => {
		const manifest = hierarchicalManifest();

		expect(
			concurrencyBlocking(
				{ kind: "task:work:merge", state: "ready", action: "work" },
				manifest,
				[
					{ workflow: { kind: "task", state: "running", action: "work" } },
					{ workflow: { kind: "task:work", state: "running", action: "work" } },
					{
						workflow: {
							kind: "task:work:merge",
							state: "running",
							action: "work",
						},
					},
				],
			),
		).toContainEqual({
			gate: "concurrency",
			scope: "kind",
			kind: "task",
			limit: 3,
			active: 3,
		});
	});

	it("should match workflow filters by kind family", () => {
		const manifest = hierarchicalManifest();

		expect(
			workflowMatchesFilter(
				{ kind: "task:work:merge", state: "ready", action: "work" },
				{ kind: "task", state: "ready", action: "work" },
				manifest,
			),
		).toBe(true);
		expect(
			workflowMatchesFilter(
				{ kind: "taskish", state: "ready", action: "work" },
				{ kind: "task", state: "ready", action: "work" },
				manifest,
			),
		).toBe(false);
	});

	it("should validate colon-containing kind ids by segment", () => {
		const issues = validateManifest({
			...hierarchicalManifest(),
			kinds: [
				{
					id: "task::work",
					label: "Invalid",
					initial: { state: "ready", action: "work" },
					transitions: [],
				},
			],
			commands: [],
		});

		expect(issues).toContainEqual({
			path: "$.kinds[0].id",
			message:
				"Kind id must use colon-separated lowercase identifier segments.",
		});
	});
});
