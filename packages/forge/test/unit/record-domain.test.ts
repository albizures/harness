import { expect, it } from "vitest";

import {
	allocateNextCommentId,
	allocateRecordId,
	buildCombinedRecordHistory,
	buildDependencyGraph,
	buildRecordDependencyView,
	buildRecordTree,
	completeRecordLifecycle,
	createRecordUpdate,
	diagnoseRecordReadiness,
	parseRecordComment,
	parseRecordFrontmatter,
	parseRecordId,
	relationshipIndexRequirementFields,
	selectNextRecord,
	startRecordLifecycle,
	validateCommentEdit,
	validateDependencyEdge,
	validateFrontmatterEdit,
	validateInitiativeDeclaredProjectsEdit,
	validateInitiativeMembership,
	validateRecordPlacement,
} from "../../src/record-domain.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");
const allocatedRecordId = 67;
const nextRecordIdAfterAllocation = 68;
const blockedDependencyId = 14;
const secondCommentId = 2;

const baseSpec = {
	id: 12,
	title: "Implement workflow records",
	kind: "spec",
	subkind: null,
	state: "ready",
	resolution: null,
	scope: { type: "project", project: "harness" },
	parent: null,
	initiative: null,
	dependsOn: [],
	generatedBy: null,
	tags: [],
	profile: null,
	createdAt: fixedDate.toISOString(),
	updatedAt: fixedDate.toISOString(),
};

it("when parsing spec frontmatter, it should accept the canonical record snapshot", () => {
	expect(parseRecordFrontmatter(baseSpec)).toEqual(baseSpec);
});

it("when allocating a record id, it should use and advance the global manifest counter", () => {
	const result = allocateRecordId({
		manifest: {
			schemaVersion: 1,
			nextRecordId: allocatedRecordId,
			createdAt: fixedDate.toISOString(),
			updatedAt: fixedDate.toISOString(),
		},
		now: new Date("2026-09-20T00:00:00.000Z"),
	});

	expect(result.recordId).toBe(allocatedRecordId);
	expect(result.manifest.nextRecordId).toBe(nextRecordIdAfterAllocation);
	expect(result.manifest.updatedAt).toBe("2026-09-20T00:00:00.000Z");
});

it("when parsing invalid placement fields, it should reject the frontmatter with a record validation error", () => {
	expect(() =>
		parseRecordFrontmatter({
			...baseSpec,
			scope: { type: "global" },
		}),
	).toThrow(/record-kind 'spec' requires project scope/);

	expect(() =>
		parseRecordFrontmatter({
			...baseSpec,
			kind: "task",
			subkind: "research",
		}),
	).toThrow(/record-kind 'task' requires a parent/);

	expect(() =>
		parseRecordFrontmatter({
			...baseSpec,
			id: 15,
			kind: "grilling",
			parent: 12,
			initiative: 16,
		}),
	).toThrow(/only spec and wayfinder records may belong to an initiative/);
});

it("when validating parent placement, it should enforce compatible child scopes", () => {
	const parent = parseRecordFrontmatter({
		...baseSpec,
		kind: "wayfinder",
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});
	const child = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		kind: "task",
		subkind: null,
		parent: parent.id,
		scope: { type: "project", project: "harness" },
	});
	expect(() => validateRecordPlacement(child, { parent })).not.toThrow();

	const outsiderChild = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		kind: "task",
		subkind: null,
		parent: parent.id,
		scope: { type: "project", project: "forge" },
	});
	expect(() => validateRecordPlacement(outsiderChild, { parent })).toThrow(
		/child scope is not compatible with parent scope/,
	);
});

it("when validating frontmatter edits, it should allow editable metadata and reject immutable fields", () => {
	const before = parseRecordFrontmatter(baseSpec);
	expect(
		validateFrontmatterEdit(before, {
			...before,
			title: "Updated title",
			tags: ["phase-2"],
			profile: "implement",
		}),
	).toEqual({
		changed: ["title", "tags", "profile"],
	});

	expect(() =>
		validateFrontmatterEdit(before, {
			...before,
			state: "done",
		}),
	).toThrow(/field 'state' is not editable through record frontmatter edits/);
});

it("when parsing record ids, it should require positive safe integers", () => {
	expect(parseRecordId(1)).toBe(1);
	expect(() => parseRecordId(0)).toThrow(
		/record id must be a positive integer/,
	);
});

it("when validating initiative membership, it should require a declared project", () => {
	const initiative = parseRecordFrontmatter({
		...baseSpec,
		kind: "initiative",
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});
	const member = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		initiative: initiative.id,
	});
	const outsider = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		initiative: initiative.id,
		scope: { type: "project", project: "forge" },
	});

	expect(() => validateInitiativeMembership(member, initiative)).not.toThrow();
	expect(() => validateInitiativeMembership(outsider, initiative)).toThrow(
		/initiative does not declare project 'forge'/,
	);
});

it("when editing initiative declared projects, it should protect projects with open members", () => {
	const initiative = parseRecordFrontmatter({
		...baseSpec,
		kind: "initiative",
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});
	const after = parseRecordFrontmatter({
		...initiative,
		scope: { type: "project-set", projects: ["docs-site"] },
	});
	const member = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		initiative: initiative.id,
	});

	const afterAdd = parseRecordFrontmatter({
		...initiative,
		scope: { type: "project-set", projects: ["docs-site", "harness", "forge"] },
	});

	expect(
		validateInitiativeDeclaredProjectsEdit(initiative, afterAdd, [
			initiative,
			member,
		]),
	).toEqual({ added: ["forge"], removed: [] });
	expect(() =>
		validateInitiativeDeclaredProjectsEdit(initiative, after, [
			initiative,
			member,
		]),
	).toThrow(/cannot remove declared project 'harness' while member 13 uses it/);
});

it("when validating a dependency edge, it should reject parent-child edges, incompatible scopes, and cycles", () => {
	const parent = parseRecordFrontmatter(baseSpec);
	const child = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		kind: "task",
		parent: parent.id,
	});
	const sibling = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		kind: "task",
		parent: parent.id,
	});
	const outsider = parseRecordFrontmatter({
		...baseSpec,
		id: 15,
		scope: { type: "project", project: "other" },
	});

	expect(() =>
		validateDependencyEdge({
			record: child,
			dependsOn: parent,
			records: [parent, child, sibling, outsider],
		}),
	).toThrow(
		/direct dependency edges between parents and children are disallowed/,
	);
	expect(() =>
		validateDependencyEdge({
			record: child,
			dependsOn: outsider,
			records: [parent, child, sibling, outsider],
		}),
	).toThrow(/dependency scopes are not compatible/);
	expect(() =>
		validateDependencyEdge({
			record: sibling,
			dependsOn: child,
			records: [{ ...child, dependsOn: [sibling.id] }, sibling],
		}),
	).toThrow(/dependency would create a cycle/);
});

it("when validating cross-project dependencies, it should allow shared initiative members", () => {
	const initiative = parseRecordFrontmatter({
		...baseSpec,
		kind: "initiative",
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});
	const harnessSpec = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		initiative: initiative.id,
	});
	const docsSpec = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		initiative: initiative.id,
		scope: { type: "project", project: "docs-site" },
	});

	expect(() =>
		validateDependencyEdge({
			record: docsSpec,
			dependsOn: harnessSpec,
			records: [initiative, harnessSpec, docsSpec],
		}),
	).not.toThrow();
});

it("when diagnosing readiness, it should report dependency and parent availability blockers", () => {
	const parent = parseRecordFrontmatter({
		...baseSpec,
		state: "done",
		resolution: "completed",
	});
	const dependency = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		title: "Dependency",
	});
	const child = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		kind: "task",
		parent: parent.id,
		dependsOn: [dependency.id],
	});

	expect(diagnoseRecordReadiness(child, [parent, dependency, child])).toEqual({
		recordId: child.id,
		ready: false,
		reasons: [
			{
				kind: "dependency-open",
				recordId: dependency.id,
				message: "Dependency 13 is ready, not done.",
			},
			{
				kind: "parent-done",
				recordId: parent.id,
				message: "Parent 12 is done, so child 14 is no longer executable.",
			},
		],
	});
});

it("when diagnosing initiative readiness, it should require member work", () => {
	const initiative = parseRecordFrontmatter({
		...baseSpec,
		kind: "initiative",
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});
	const wayfinder = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		kind: "wayfinder",
		initiative: initiative.id,
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});

	expect(diagnoseRecordReadiness(initiative, [initiative])).toEqual({
		recordId: initiative.id,
		ready: false,
		reasons: [
			{
				kind: "initiative-empty",
				recordId: initiative.id,
				message:
					"Initiative 12 must have at least one member spec or member wayfinder before it can start.",
			},
		],
	});
	expect(
		diagnoseRecordReadiness(initiative, [initiative, wayfinder]).ready,
	).toBe(true);
});

it("when starting a record lifecycle, it should validate readiness and be idempotent", () => {
	const ready = parseRecordFrontmatter(baseSpec);
	const blocked = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		title: "Blocked task",
		kind: "task",
		parent: ready.id,
		dependsOn: [blockedDependencyId],
	});
	const openDependency = parseRecordFrontmatter({
		...baseSpec,
		id: blockedDependencyId,
		title: "Open dependency",
	});

	expect(startRecordLifecycle(ready, [ready], fixedDate)).toEqual({
		record: {
			...ready,
			state: "in-progress",
			updatedAt: fixedDate.toISOString(),
		},
		changed: true,
	});
	expect(
		startRecordLifecycle(
			{ ...ready, state: "in-progress" },
			[{ ...ready, state: "in-progress" }],
			fixedDate,
		),
	).toEqual({ record: { ...ready, state: "in-progress" }, changed: false });
	expect(() =>
		startRecordLifecycle(blocked, [ready, blocked, openDependency]),
	).toThrow(/Record 13 is blocked and cannot be started/);
});

it("when completing an initiative lifecycle, it should require terminal members", () => {
	const initiative = parseRecordFrontmatter({
		...baseSpec,
		kind: "initiative",
		scope: { type: "project-set", projects: ["docs-site", "harness"] },
	});
	const memberSpec = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		initiative: initiative.id,
	});
	const doneMemberSpec = parseRecordFrontmatter({
		...memberSpec,
		state: "done",
		resolution: "completed",
	});

	expect(() =>
		completeRecordLifecycle(initiative, [initiative, memberSpec], "completed"),
	).toThrow(/initiative records cannot be done while member 13 is ready/);
	expect(
		completeRecordLifecycle(
			initiative,
			[initiative, doneMemberSpec],
			"completed",
			fixedDate,
		),
	).toEqual({
		record: {
			...initiative,
			state: "done",
			resolution: "completed",
			updatedAt: fixedDate.toISOString(),
		},
		changed: true,
	});
});

it("when completing a record lifecycle, it should require valid resolutions, be idempotent, and enforce child gates", () => {
	const spec = parseRecordFrontmatter(baseSpec);
	const openChild = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		kind: "task",
		parent: spec.id,
	});
	const doneChild = parseRecordFrontmatter({
		...openChild,
		state: "done",
		resolution: "completed",
	});

	expect(() => completeRecordLifecycle(spec, [spec], "Completed")).toThrow(
		/resolution must be lowercase kebab-case/,
	);
	expect(() =>
		completeRecordLifecycle(spec, [spec, openChild], "completed"),
	).toThrow(/spec records cannot be done while child 13 is ready/);
	expect(
		completeRecordLifecycle(spec, [spec, doneChild], "completed", fixedDate),
	).toEqual({
		record: {
			...spec,
			state: "done",
			resolution: "completed",
			updatedAt: fixedDate.toISOString(),
		},
		changed: true,
	});
	expect(
		completeRecordLifecycle(
			{ ...spec, state: "done", resolution: "completed" },
			[{ ...spec, state: "done", resolution: "completed" }],
			"completed",
		),
	).toEqual({
		record: { ...spec, state: "done", resolution: "completed" },
		changed: false,
	});
	expect(() =>
		completeRecordLifecycle(
			{ ...spec, state: "done", resolution: "completed" },
			[{ ...spec, state: "done", resolution: "completed" }],
			"superseded",
		),
	).toThrow(/Done record 12 already has resolution 'completed'/);
});

it("when handling comments and updates, it should validate identity, edits, and combined history order", () => {
	const comment = parseRecordComment({
		id: 1,
		recordId: baseSpec.id,
		createdAt: fixedDate.toISOString(),
		updatedAt: fixedDate.toISOString(),
		body: "Initial note",
	});
	const edited = { ...comment, body: "Edited note" };
	expect(allocateNextCommentId(comment.recordId, [comment])).toBe(
		secondCommentId,
	);
	expect(validateCommentEdit(comment, edited)).toEqual(edited);
	expect(() =>
		validateCommentEdit(comment, parseRecordComment({ ...edited, id: 2 })),
	).toThrow(/comment frontmatter field 'id' is not editable/);
	expect(() =>
		validateCommentEdit(
			comment,
			parseRecordComment({
				...edited,
				updatedAt: "2026-09-20T00:00:00.000Z",
			}),
		),
	).toThrow(/comment frontmatter field 'updatedAt' is not editable/);
	const update = createRecordUpdate({
		recordId: comment.recordId,
		updates: [],
		type: "create",
		summary: "Created record",
		now: new Date("2026-09-18T00:00:00.000Z"),
	});
	expect(
		buildCombinedRecordHistory({
			comments: [comment],
			updates: [update],
		}),
	).toEqual([
		{
			kind: "update",
			createdAt: update.createdAt,
			update,
		},
		{ kind: "comment", createdAt: fixedDate.toISOString(), comment },
	]);
});

it("when selecting next work, it should use executable candidates then oldest record id", () => {
	const spec = parseRecordFrontmatter(baseSpec);
	const doneDependency = parseRecordFrontmatter({
		...baseSpec,
		id: 13,
		title: "Done dependency",
		state: "done",
		resolution: "completed",
	});
	const task = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		kind: "task",
		parent: spec.id,
		dependsOn: [doneDependency.id],
	});
	const grilling = parseRecordFrontmatter({
		...baseSpec,
		id: 15,
		kind: "grilling",
		parent: spec.id,
	});

	expect(selectNextRecord([spec, doneDependency, task, grilling])?.id).toBe(
		task.id,
	);
	expect(
		selectNextRecord([spec, doneDependency, task, grilling], {
			includeHitl: true,
			planning: true,
		})?.id,
	).toBe(spec.id);
	expect(buildDependencyGraph([task, doneDependency])).toEqual({
		[String(doneDependency.id)]: { dependsOn: [], dependents: [task.id] },
		[String(task.id)]: { dependsOn: [doneDependency.id], dependents: [] },
	});
	expect(buildRecordTree(spec, [spec, task, grilling])).toEqual({
		record: spec,
		children: [
			{ record: task, children: [] },
			{ record: grilling, children: [] },
		],
	});
	expect(buildRecordDependencyView(task, [task, doneDependency])).toEqual({
		record: task,
		dependsOn: [doneDependency],
		dependents: [],
		missingDependencies: [],
	});
	expect(relationshipIndexRequirementFields).toEqual([
		"parent",
		"children",
		"initiative",
		"initiativeMembers",
		"dependsOn",
		"dependents",
		"generatedBy",
		"generated",
	]);
});
