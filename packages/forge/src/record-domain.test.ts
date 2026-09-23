import assert from "node:assert/strict";
import test from "node:test";

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
} from "./record-domain.ts";

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

test("when parsing spec frontmatter, it should accept the canonical record snapshot", () => {
	assert.deepEqual(parseRecordFrontmatter(baseSpec), baseSpec);
});

test("when allocating a record id, it should use and advance the global manifest counter", () => {
	const result = allocateRecordId({
		manifest: {
			schemaVersion: 1,
			nextRecordId: allocatedRecordId,
			createdAt: fixedDate.toISOString(),
			updatedAt: fixedDate.toISOString(),
		},
		now: new Date("2026-09-20T00:00:00.000Z"),
	});

	assert.equal(result.recordId, allocatedRecordId);
	assert.equal(result.manifest.nextRecordId, nextRecordIdAfterAllocation);
	assert.equal(result.manifest.updatedAt, "2026-09-20T00:00:00.000Z");
});

test("when parsing invalid placement fields, it should reject the frontmatter with a record validation error", () => {
	assert.throws(
		() =>
			parseRecordFrontmatter({
				...baseSpec,
				scope: { type: "global" },
			}),
		/record-kind 'spec' requires project scope/,
	);

	assert.throws(
		() =>
			parseRecordFrontmatter({
				...baseSpec,
				kind: "task",
				subkind: "research",
			}),
		/record-kind 'task' requires a parent/,
	);

	assert.throws(
		() =>
			parseRecordFrontmatter({
				...baseSpec,
				id: 15,
				kind: "grilling",
				parent: 12,
				initiative: 16,
			}),
		/only spec and wayfinder records may belong to an initiative/,
	);
});

test("when validating parent placement, it should enforce compatible child scopes", () => {
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
	assert.doesNotThrow(() => validateRecordPlacement(child, { parent }));

	const outsiderChild = parseRecordFrontmatter({
		...baseSpec,
		id: 14,
		kind: "task",
		subkind: null,
		parent: parent.id,
		scope: { type: "project", project: "forge" },
	});
	assert.throws(
		() => validateRecordPlacement(outsiderChild, { parent }),
		/child scope is not compatible with parent scope/,
	);
});

test("when validating frontmatter edits, it should allow editable metadata and reject immutable fields", () => {
	const before = parseRecordFrontmatter(baseSpec);
	assert.deepEqual(
		validateFrontmatterEdit(before, {
			...before,
			title: "Updated title",
			tags: ["phase-2"],
			profile: "implement",
		}),
		{
			changed: ["title", "tags", "profile"],
		},
	);

	assert.throws(
		() =>
			validateFrontmatterEdit(before, {
				...before,
				state: "done",
			}),
		/field 'state' is not editable through record frontmatter edits/,
	);
});

test("when parsing record ids, it should require positive safe integers", () => {
	assert.equal(parseRecordId(1), 1);
	assert.throws(() => parseRecordId(0), /record id must be a positive integer/);
});

test("when validating initiative membership, it should require a declared project", () => {
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

	assert.doesNotThrow(() => validateInitiativeMembership(member, initiative));
	assert.throws(
		() => validateInitiativeMembership(outsider, initiative),
		/initiative does not declare project 'forge'/,
	);
});

test("when editing initiative declared projects, it should protect projects with open members", () => {
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

	assert.deepEqual(
		validateInitiativeDeclaredProjectsEdit(initiative, afterAdd, [
			initiative,
			member,
		]),
		{ added: ["forge"], removed: [] },
	);
	assert.throws(
		() =>
			validateInitiativeDeclaredProjectsEdit(initiative, after, [
				initiative,
				member,
			]),
		/cannot remove declared project 'harness' while member 13 uses it/,
	);
});

test("when validating a dependency edge, it should reject parent-child edges, incompatible scopes, and cycles", () => {
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

	assert.throws(
		() =>
			validateDependencyEdge({
				record: child,
				dependsOn: parent,
				records: [parent, child, sibling, outsider],
			}),
		/direct dependency edges between parents and children are disallowed/,
	);
	assert.throws(
		() =>
			validateDependencyEdge({
				record: child,
				dependsOn: outsider,
				records: [parent, child, sibling, outsider],
			}),
		/dependency scopes are not compatible/,
	);
	assert.throws(
		() =>
			validateDependencyEdge({
				record: sibling,
				dependsOn: child,
				records: [{ ...child, dependsOn: [sibling.id] }, sibling],
			}),
		/dependency would create a cycle/,
	);
});

test("when validating cross-project dependencies, it should allow shared initiative members", () => {
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

	assert.doesNotThrow(() =>
		validateDependencyEdge({
			record: docsSpec,
			dependsOn: harnessSpec,
			records: [initiative, harnessSpec, docsSpec],
		}),
	);
});

test("when diagnosing readiness, it should report dependency and parent availability blockers", () => {
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

	assert.deepEqual(
		diagnoseRecordReadiness(child, [parent, dependency, child]),
		{
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
		},
	);
});

test("when diagnosing initiative readiness, it should require member work", () => {
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

	assert.deepEqual(diagnoseRecordReadiness(initiative, [initiative]), {
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
	assert.equal(
		diagnoseRecordReadiness(initiative, [initiative, wayfinder]).ready,
		true,
	);
});

test("when starting a record lifecycle, it should validate readiness and be idempotent", () => {
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

	assert.deepEqual(startRecordLifecycle(ready, [ready], fixedDate), {
		record: {
			...ready,
			state: "in-progress",
			updatedAt: fixedDate.toISOString(),
		},
		changed: true,
	});
	assert.deepEqual(
		startRecordLifecycle(
			{ ...ready, state: "in-progress" },
			[{ ...ready, state: "in-progress" }],
			fixedDate,
		),
		{ record: { ...ready, state: "in-progress" }, changed: false },
	);
	assert.throws(
		() => startRecordLifecycle(blocked, [ready, blocked, openDependency]),
		/Record 13 is blocked and cannot be started/,
	);
});

test("when completing an initiative lifecycle, it should require terminal members", () => {
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

	assert.throws(
		() =>
			completeRecordLifecycle(
				initiative,
				[initiative, memberSpec],
				"completed",
			),
		/initiative records cannot be done while member 13 is ready/,
	);
	assert.deepEqual(
		completeRecordLifecycle(
			initiative,
			[initiative, doneMemberSpec],
			"completed",
			fixedDate,
		),
		{
			record: {
				...initiative,
				state: "done",
				resolution: "completed",
				updatedAt: fixedDate.toISOString(),
			},
			changed: true,
		},
	);
});

test("when completing a record lifecycle, it should require valid resolutions, be idempotent, and enforce child gates", () => {
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

	assert.throws(
		() => completeRecordLifecycle(spec, [spec], "Completed"),
		/resolution must be lowercase kebab-case/,
	);
	assert.throws(
		() => completeRecordLifecycle(spec, [spec, openChild], "completed"),
		/spec records cannot be done while child 13 is ready/,
	);
	assert.deepEqual(
		completeRecordLifecycle(spec, [spec, doneChild], "completed", fixedDate),
		{
			record: {
				...spec,
				state: "done",
				resolution: "completed",
				updatedAt: fixedDate.toISOString(),
			},
			changed: true,
		},
	);
	assert.deepEqual(
		completeRecordLifecycle(
			{ ...spec, state: "done", resolution: "completed" },
			[{ ...spec, state: "done", resolution: "completed" }],
			"completed",
		),
		{
			record: { ...spec, state: "done", resolution: "completed" },
			changed: false,
		},
	);
	assert.throws(
		() =>
			completeRecordLifecycle(
				{ ...spec, state: "done", resolution: "completed" },
				[{ ...spec, state: "done", resolution: "completed" }],
				"superseded",
			),
		/Done record 12 already has resolution 'completed'/,
	);
});

test("when handling comments and updates, it should validate identity, edits, and combined history order", () => {
	const comment = parseRecordComment({
		id: 1,
		recordId: baseSpec.id,
		createdAt: fixedDate.toISOString(),
		updatedAt: fixedDate.toISOString(),
		body: "Initial note",
	});
	const edited = { ...comment, body: "Edited note" };
	assert.equal(
		allocateNextCommentId(comment.recordId, [comment]),
		secondCommentId,
	);
	assert.deepEqual(validateCommentEdit(comment, edited), edited);
	assert.throws(
		() =>
			validateCommentEdit(comment, parseRecordComment({ ...edited, id: 2 })),
		/comment frontmatter field 'id' is not editable/,
	);
	assert.throws(
		() =>
			validateCommentEdit(
				comment,
				parseRecordComment({
					...edited,
					updatedAt: "2026-09-20T00:00:00.000Z",
				}),
			),
		/comment frontmatter field 'updatedAt' is not editable/,
	);
	const update = createRecordUpdate({
		recordId: comment.recordId,
		updates: [],
		type: "create",
		summary: "Created record",
		now: new Date("2026-09-18T00:00:00.000Z"),
	});
	assert.deepEqual(
		buildCombinedRecordHistory({
			comments: [comment],
			updates: [update],
		}),
		[
			{
				kind: "update",
				createdAt: update.createdAt,
				update,
			},
			{ kind: "comment", createdAt: fixedDate.toISOString(), comment },
		],
	);
});

test("when selecting next work, it should use executable candidates then oldest record id", () => {
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

	assert.equal(
		selectNextRecord([spec, doneDependency, task, grilling])?.id,
		task.id,
	);
	assert.equal(
		selectNextRecord([spec, doneDependency, task, grilling], {
			includeHitl: true,
			planning: true,
		})?.id,
		spec.id,
	);
	assert.deepEqual(buildDependencyGraph([task, doneDependency]), {
		[String(doneDependency.id)]: { dependsOn: [], dependents: [task.id] },
		[String(task.id)]: { dependsOn: [doneDependency.id], dependents: [] },
	});
	assert.deepEqual(buildRecordTree(spec, [spec, task, grilling]), {
		record: spec,
		children: [
			{ record: task, children: [] },
			{ record: grilling, children: [] },
		],
	});
	assert.deepEqual(buildRecordDependencyView(task, [task, doneDependency]), {
		record: task,
		dependsOn: [doneDependency],
		dependents: [],
		missingDependencies: [],
	});
	assert.deepEqual(relationshipIndexRequirementFields, [
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
