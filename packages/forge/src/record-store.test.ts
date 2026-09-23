import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseAbsolutePath, parseProjectId } from "./domain.ts";
import { ensureStoreRoot, readStoreManifest } from "./filesystem-store.ts";
import type { RecordId } from "./record-domain.ts";
import {
	addInitiativeDeclaredProject,
	addRecordComment,
	addWorkflowRecordDependency,
	attachWorkflowRecordToInitiative,
	completeWorkflowRecord,
	createWorkflowRecord,
	formatRecordCommentMarkdown,
	formatWorkflowRecordMarkdown,
	listRecordComments,
	listRecordHistory,
	listRecordUpdates,
	listWorkflowRecordReadiness,
	parseWorkflowRecordMarkdown,
	readRecordDependencyView,
	readRecordTree,
	readWorkflowRecord,
	removeInitiativeDeclaredProject,
	removeWorkflowRecordDependency,
	replaceRecordCommentFromEditedMarkdown,
	replaceWorkflowRecordFromEditedMarkdown,
	selectNextWorkflowRecord,
	startWorkflowRecord,
} from "./record-store.ts";
import {
	paddedRecordId,
	recordFilePath,
	storeRootPaths,
} from "./store-paths.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");
const laterDate = new Date("2026-09-20T00:00:00.000Z");
const doneUpdateSequence = 3;

async function tempStore() {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-record-store-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	return storePath;
}

test("when creating a workflow record, it should allocate a global id and write canonical Markdown plus indexes", async () => {
	const storePath = await tempStore();
	const record = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Implement scoped workflow records",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "## Outcome\n\nCreate records.\n",
		},
	});

	assert.equal(record.id, 1);
	assert.equal((await readStoreManifest(storePath)).nextRecordId, 2);

	const filePath = recordFilePath(storePath, "spec", record.id);
	assert.equal(
		await readFile(filePath, "utf8"),
		`---\nid: 1\ntitle: Implement scoped workflow records\nkind: spec\nsubkind: null\nstate: ready\nresolution: null\nscope:\n  type: project\n  project: harness\nparent: null\ninitiative: null\ndependsOn: []\ngeneratedBy: null\ntags: []\nprofile: null\ncreatedAt: "2026-09-19T00:00:00.000Z"\nupdatedAt: "2026-09-19T00:00:00.000Z"\n---\n\n## Outcome\n\nCreate records.\n`,
	);

	const paths = storeRootPaths(storePath);
	assert.deepEqual(JSON.parse(await readFile(paths.byIdIndex, "utf8")), {
		"1": { kind: "spec", path: "records/spec/000/000001.md" },
	});
	assert.deepEqual(JSON.parse(await readFile(paths.byProjectIndex, "utf8")), {
		harness: [1],
	});
});

test("when creating a child record, it should persist parent/scope validation and relationship indexes", async () => {
	const storePath = await tempStore();
	const parent = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Parent spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Parent body\n",
		},
	});
	const child = await createWorkflowRecord({
		storePath,
		now: laterDate,
		input: {
			title: "Child task",
			kind: "task",
			subkind: "research",
			scope: parent.scope,
			parent: parent.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: "research",
			body: "Research it.\n",
		},
	});

	assert.equal(child.id, 2);
	const relationships = JSON.parse(
		await readFile(storeRootPaths(storePath).relationshipsIndex, "utf8"),
	);
	assert.deepEqual(relationships["1"].children, [2]);
	assert.deepEqual(relationships["2"].parent, 1);

	await assert.rejects(
		() =>
			createWorkflowRecord({
				storePath,
				now: laterDate,
				input: {
					title: "Wrong project",
					kind: "task",
					subkind: null,
					scope: { type: "project", project: parseProjectId("other") },
					parent: parent.id,
					initiative: null,
					dependsOn: [],
					generatedBy: null,
					tags: [],
					profile: null,
					body: "Nope.\n",
				},
			}),
		/child scope is not compatible with parent scope/,
	);
});

test("when the manifest allocation conflicts with an existing record file, it should fail loudly", async () => {
	const storePath = await tempStore();
	const conflictingPath = recordFilePath(storePath, "wayfinder", 1 as RecordId);
	await mkdir(path.dirname(conflictingPath), { recursive: true });
	await writeFile(conflictingPath, "already here", "utf8");

	await assert.rejects(
		() =>
			createWorkflowRecord({
				storePath,
				now: fixedDate,
				input: {
					title: "Conflicting spec",
					kind: "spec",
					subkind: null,
					scope: { type: "project", project: parseProjectId("harness") },
					parent: null,
					initiative: null,
					dependsOn: [],
					generatedBy: null,
					tags: [],
					profile: null,
					body: "Body\n",
				},
			}),
		/nextRecordId conflicts with existing record file.*forge store doctor/,
	);
});

test("when editing record Markdown, it should accept body and editable frontmatter but reject immutable changes", async () => {
	const storePath = await tempStore();
	const created = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Editable spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Original\n",
		},
	});
	const editedMarkdown = formatWorkflowRecordMarkdown({
		...created,
		title: "Edited spec",
		tags: ["phase-2"],
		body: "Edited body\n",
	});

	const edited = await replaceWorkflowRecordFromEditedMarkdown({
		storePath,
		recordId: created.id,
		markdown: editedMarkdown,
		now: laterDate,
	});

	assert.equal(edited.title, "Edited spec");
	assert.deepEqual(edited.tags, ["phase-2"]);
	assert.equal(edited.updatedAt, laterDate.toISOString());
	assert.equal(
		(await readWorkflowRecord(storePath, created.id)).body,
		"Edited body\n",
	);

	await assert.rejects(
		() =>
			replaceWorkflowRecordFromEditedMarkdown({
				storePath,
				recordId: created.id,
				markdown: formatWorkflowRecordMarkdown({
					...edited,
					state: "done",
					resolution: "completed",
				}),
				now: laterDate,
			}),
		/field 'state' is not editable through record frontmatter edits/,
	);
});

test("when parsing record Markdown, it should validate filename kind and id", async () => {
	const parsed = parseWorkflowRecordMarkdown(
		`---\nid: 1\ntitle: Parsed\nkind: wayfinder\nsubkind: null\nstate: ready\nresolution: null\nscope:\n  type: global\nparent: null\ninitiative: null\ndependsOn: []\ngeneratedBy: null\ntags: []\nprofile: null\ncreatedAt: "2026-09-19T00:00:00.000Z"\nupdatedAt: "2026-09-19T00:00:00.000Z"\n---\n\nBody\n`,
		{ expectedId: 1 as RecordId, expectedKind: "wayfinder" },
	);
	assert.equal(parsed.body, "Body\n");

	assert.equal(paddedRecordId(parsed.id), "000001");
	assert.throws(
		() =>
			parseWorkflowRecordMarkdown(formatWorkflowRecordMarkdown(parsed), {
				expectedId: 2 as RecordId,
				expectedKind: "wayfinder",
			}),
		/record file id '1' does not match expected id '2'/,
	);
});

test("when mutating dependencies, it should persist validated edges and rebuild relationship indexes", async () => {
	const storePath = await tempStore();
	const parent = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Parent spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Parent body\n",
		},
	});
	const blocker = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Blocker task",
			kind: "task",
			subkind: null,
			scope: parent.scope,
			parent: parent.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Blocker body\n",
		},
	});
	const blocked = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Blocked task",
			kind: "task",
			subkind: null,
			scope: parent.scope,
			parent: parent.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Blocked body\n",
		},
	});

	const updated = await addWorkflowRecordDependency({
		storePath,
		recordId: blocked.id,
		dependsOn: blocker.id,
		now: laterDate,
	});

	assert.deepEqual(updated.dependsOn, [blocker.id]);
	assert.equal(updated.updatedAt, laterDate.toISOString());
	assert.deepEqual(
		(await readWorkflowRecord(storePath, blocked.id)).dependsOn,
		[blocker.id],
	);
	let relationships = JSON.parse(
		await readFile(storeRootPaths(storePath).relationshipsIndex, "utf8"),
	);
	assert.deepEqual(relationships[String(blocker.id)].dependents, [blocked.id]);
	assert.deepEqual(relationships[String(blocked.id)].dependsOn, [blocker.id]);

	await removeWorkflowRecordDependency({
		storePath,
		recordId: blocked.id,
		dependsOn: blocker.id,
		now: laterDate,
	});
	assert.deepEqual(
		(await readWorkflowRecord(storePath, blocked.id)).dependsOn,
		[],
	);
	relationships = JSON.parse(
		await readFile(storeRootPaths(storePath).relationshipsIndex, "utf8"),
	);
	assert.deepEqual(relationships[String(blocker.id)].dependents, []);

	await assert.rejects(
		() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: blocked.id,
				dependsOn: parent.id,
			}),
		/direct dependency edges between parents and children are disallowed/,
	);
});

test("when creating dependency edges, it should reject missing dependencies, incompatible scopes, and cycles", async () => {
	const storePath = await tempStore();
	const parent = await createWorkflowRecord({
		storePath,
		input: {
			title: "Parent spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Parent body\n",
		},
	});
	const first = await createWorkflowRecord({
		storePath,
		input: {
			title: "First task",
			kind: "task",
			subkind: null,
			scope: parent.scope,
			parent: parent.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "First body\n",
		},
	});
	const second = await createWorkflowRecord({
		storePath,
		input: {
			title: "Second task",
			kind: "task",
			subkind: null,
			scope: parent.scope,
			parent: parent.id,
			initiative: null,
			dependsOn: [first.id],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Second body\n",
		},
	});
	const outsider = await createWorkflowRecord({
		storePath,
		input: {
			title: "Outsider spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("other") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Outsider body\n",
		},
	});

	await assert.rejects(
		() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: first.id,
				dependsOn: 999 as RecordId,
			}),
		/Record '999' was not found/,
	);
	await assert.rejects(
		() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: first.id,
				dependsOn: outsider.id,
			}),
		/dependency scopes are not compatible/,
	);
	await assert.rejects(
		() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: first.id,
				dependsOn: second.id,
			}),
		/dependency would create a cycle/,
	);
});

test("when persisting lifecycle transitions, it should update the record and append ordered updates", async () => {
	const storePath = await tempStore();
	const spec = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Lifecycle spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Spec body\n",
		},
	});

	const started = await startWorkflowRecord({
		storePath,
		recordId: spec.id,
		now: laterDate,
	});
	assert.equal(started.state, "in-progress");
	assert.equal(
		(await startWorkflowRecord({ storePath, recordId: spec.id })).state,
		"in-progress",
	);

	const done = await completeWorkflowRecord({
		storePath,
		recordId: spec.id,
		resolution: "completed",
		now: new Date("2026-09-21T00:00:00.000Z"),
	});
	assert.equal(done.state, "done");
	assert.equal(done.resolution, "completed");
	assert.deepEqual(
		(await listRecordUpdates(storePath, spec.id)).map((update) => [
			update.sequence,
			update.type,
		]),
		[
			[1, "create"],
			[2, "start"],
			[doneUpdateSequence, "done"],
		],
	);
});

test("when persisting comments, it should store editable comment files and combine history with updates", async () => {
	const storePath = await tempStore();
	const spec = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Commented spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Spec body\n",
		},
	});
	const comment = await addRecordComment({
		storePath,
		recordId: spec.id,
		body: "Manual note\n",
		now: laterDate,
	});
	assert.deepEqual((await listRecordComments(storePath, spec.id))[0], comment);

	const edited = await replaceRecordCommentFromEditedMarkdown({
		storePath,
		recordId: spec.id,
		commentId: comment.id,
		markdown: formatRecordCommentMarkdown({
			...comment,
			body: "Edited note\n",
		}),
		now: new Date("2026-09-21T00:00:00.000Z"),
	});
	assert.equal(edited.body, "Edited note\n");
	assert.equal(edited.updatedAt, "2026-09-21T00:00:00.000Z");
	await assert.rejects(
		() =>
			replaceRecordCommentFromEditedMarkdown({
				storePath,
				recordId: spec.id,
				commentId: comment.id,
				markdown: formatRecordCommentMarkdown({ ...edited, id: 2 as never }),
			}),
		/comment id '2' does not match expected id '1'/,
	);
	assert.deepEqual(
		(await listRecordHistory(storePath, spec.id)).map((entry) => entry.kind),
		["update", "update", "comment", "update"],
	);
});

test("when mutating initiative membership and declared projects, it should persist indexes and history events", async () => {
	const storePath = await tempStore();
	const initiative = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Cross-project initiative",
			kind: "initiative",
			subkind: null,
			scope: { type: "project-set", projects: [parseProjectId("harness")] },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Coordinate work.\n",
		},
	});
	const spec = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Harness spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Spec body\n",
		},
	});

	await attachWorkflowRecordToInitiative({
		storePath,
		recordId: spec.id,
		initiativeId: initiative.id,
		now: laterDate,
	});
	await addInitiativeDeclaredProject({
		storePath,
		initiativeId: initiative.id,
		project: parseProjectId("docs"),
		now: new Date("2026-09-21T00:00:00.000Z"),
	});

	const paths = storeRootPaths(storePath);
	assert.deepEqual(
		JSON.parse(await readFile(paths.byInitiativeIndex, "utf8")),
		{
			"1": {
				declaredProjects: ["docs", "harness"],
				members: [spec.id],
				projects: ["harness"],
			},
		},
	);
	assert.deepEqual(
		JSON.parse(await readFile(paths.relationshipsIndex, "utf8"))["1"]
			.initiativeMembers,
		[spec.id],
	);
	assert.deepEqual(
		(await listRecordUpdates(storePath, spec.id)).map((update) => update.type),
		["create", "initiative-attach"],
	);
	assert.deepEqual(
		(await listRecordUpdates(storePath, initiative.id)).map(
			(update) => update.type,
		),
		["create", "initiative-project-add"],
	);
	await assert.rejects(
		() =>
			removeInitiativeDeclaredProject({
				storePath,
				initiativeId: initiative.id,
				project: parseProjectId("harness"),
			}),
		/cannot remove declared project 'harness' while member 2 uses it/,
	);
});

test("when querying initiative scoped navigation, it should include initiative records and members", async () => {
	const storePath = await tempStore();
	const initiative = await createWorkflowRecord({
		storePath,
		input: {
			title: "Initiative",
			kind: "initiative",
			subkind: null,
			scope: {
				type: "project-set",
				projects: [parseProjectId("harness"), parseProjectId("docs")],
			},
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Initiative body\n",
		},
	});
	const wayfinder = await createWorkflowRecord({
		storePath,
		input: {
			title: "Shared wayfinder",
			kind: "wayfinder",
			subkind: null,
			scope: { type: "initiative", initiative: initiative.id },
			parent: null,
			initiative: initiative.id,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Wayfinder body\n",
		},
	});

	assert.deepEqual(
		(
			await listWorkflowRecordReadiness(storePath, {
				project: parseProjectId("docs"),
				planning: true,
			})
		).map((diagnosis) => diagnosis.recordId),
		[initiative.id, wayfinder.id],
	);
	assert.equal(
		(
			await selectNextWorkflowRecord(storePath, {
				initiative: initiative.id,
				planning: true,
			})
		)?.id,
		initiative.id,
	);
});

test("when querying relationship and readiness views, it should return deterministic store-backed results", async () => {
	const storePath = await tempStore();
	const spec = await createWorkflowRecord({
		storePath,
		input: {
			title: "Spec",
			kind: "spec",
			subkind: null,
			scope: { type: "project", project: parseProjectId("harness") },
			parent: null,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Spec body\n",
		},
	});
	const blocker = await createWorkflowRecord({
		storePath,
		input: {
			title: "Blocker",
			kind: "task",
			subkind: null,
			scope: spec.scope,
			parent: spec.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Blocker body\n",
		},
	});
	const blocked = await createWorkflowRecord({
		storePath,
		input: {
			title: "Blocked",
			kind: "task",
			subkind: null,
			scope: spec.scope,
			parent: spec.id,
			initiative: null,
			dependsOn: [blocker.id],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Blocked body\n",
		},
	});

	assert.deepEqual(
		(await readRecordTree(storePath, spec.id)).children.map(
			(child) => child.record.id,
		),
		[blocker.id, blocked.id],
	);
	assert.deepEqual(
		(await readRecordDependencyView(storePath, blocked.id)).dependsOn.map(
			(record) => record.id,
		),
		[blocker.id],
	);
	assert.deepEqual(
		(await listWorkflowRecordReadiness(storePath, { blocked: false })).map(
			(diagnosis) => diagnosis.recordId,
		),
		[blocker.id],
	);
	assert.deepEqual(
		(await listWorkflowRecordReadiness(storePath, { blocked: true })).map(
			(diagnosis) => diagnosis.recordId,
		),
		[blocked.id],
	);
	assert.equal((await selectNextWorkflowRecord(storePath))?.id, blocker.id);
});
