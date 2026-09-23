import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { expect, it } from "vitest";

import { parseAbsolutePath, parseProjectId } from "../../src/domain.ts";
import { isForgeError } from "../../src/errors.ts";
import {
	ensureStoreRoot,
	readStoreManifest,
} from "../../src/filesystem-store.ts";
import type { RecordId } from "../../src/record-domain.ts";
import {
	addInitiativeDeclaredProject,
	addRecordComment,
	addRecordCommentEffect,
	addWorkflowRecordDependency,
	attachWorkflowRecordToInitiative,
	completeWorkflowRecord,
	createWorkflowRecord,
	createWorkflowRecordEffect,
	formatRecordCommentMarkdown,
	formatWorkflowRecordMarkdown,
	listRecordComments,
	listRecordHistory,
	listRecordHistoryEffect,
	listRecordUpdates,
	listWorkflowRecordReadiness,
	listWorkflowRecordReadinessEffect,
	listWorkflowRecordsEffect,
	parseWorkflowRecordMarkdown,
	readRecordDependencyView,
	readRecordTree,
	readWorkflowRecord,
	readWorkflowRecordEffect,
	removeInitiativeDeclaredProject,
	removeWorkflowRecordDependency,
	replaceRecordCommentFromEditedMarkdown,
	replaceWorkflowRecordFromEditedMarkdown,
	selectNextWorkflowRecord,
	startWorkflowRecord,
	startWorkflowRecordEffect,
} from "../../src/record-store.ts";
import { runForgePromise } from "../../src/runtime.ts";
import {
	paddedRecordId,
	recordFilePath,
	storeRootPaths,
} from "../../src/store-paths.ts";

const fixedDate = new Date("2026-09-19T00:00:00.000Z");
const laterDate = new Date("2026-09-20T00:00:00.000Z");
const doneUpdateSequence = 3;
const missingRecordId = 999 as RecordId;

function failureFromExit(exit: Exit.Exit<unknown, unknown>) {
	if (!Exit.isFailure(exit)) {
		throw new Error("Expected Effect to fail.");
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag !== "Some") {
		throw new Error("Expected typed Effect failure.");
	}
	return failure.value;
}

async function tempStore() {
	const storePath = parseAbsolutePath(
		await mkdtemp(path.join(os.tmpdir(), "forge-record-store-")),
	);
	await ensureStoreRoot({ storePath, now: fixedDate });
	return storePath;
}

it("when creating a workflow record, it should allocate a global id and write canonical Markdown plus indexes", async () => {
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

	expect(record.id).toBe(1);
	expect((await readStoreManifest(storePath)).nextRecordId).toBe(2);

	const filePath = recordFilePath(storePath, "spec", record.id);
	expect(await readFile(filePath, "utf8")).toBe(
		`---\nid: 1\ntitle: Implement scoped workflow records\nkind: spec\nsubkind: null\nstate: ready\nresolution: null\nscope:\n  type: project\n  project: harness\nparent: null\ninitiative: null\ndependsOn: []\ngeneratedBy: null\ntags: []\nprofile: null\ncreatedAt: "2026-09-19T00:00:00.000Z"\nupdatedAt: "2026-09-19T00:00:00.000Z"\n---\n\n## Outcome\n\nCreate records.\n`,
	);

	const paths = storeRootPaths(storePath);
	expect(JSON.parse(await readFile(paths.byIdIndex, "utf8"))).toEqual({
		"1": { kind: "spec", path: "records/spec/000/000001.md" },
	});
	expect(JSON.parse(await readFile(paths.byProjectIndex, "utf8"))).toEqual({
		harness: [1],
	});
});

it("when creating a child record, it should persist parent/scope validation and relationship indexes", async () => {
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

	expect(child.id).toBe(2);
	const relationships = JSON.parse(
		await readFile(storeRootPaths(storePath).relationshipsIndex, "utf8"),
	);
	expect(relationships["1"].children).toEqual([2]);
	expect(relationships["2"].parent).toEqual(1);

	await expect(
		(() =>
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
			}))(),
	).rejects.toThrow(/child scope is not compatible with parent scope/);
});

it("when the manifest allocation conflicts with an existing record file, it should fail loudly", async () => {
	const storePath = await tempStore();
	const conflictingPath = recordFilePath(storePath, "wayfinder", 1 as RecordId);
	await mkdir(path.dirname(conflictingPath), { recursive: true });
	await writeFile(conflictingPath, "already here", "utf8");

	await expect(
		(() =>
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
			}))(),
	).rejects.toThrow(
		/nextRecordId conflicts with existing record file.*forge store doctor/,
	);
});

it("when editing record Markdown, it should accept body and editable frontmatter but reject immutable changes", async () => {
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

	expect(edited.title).toBe("Edited spec");
	expect(edited.tags).toEqual(["phase-2"]);
	expect(edited.updatedAt).toBe(laterDate.toISOString());
	expect((await readWorkflowRecord(storePath, created.id)).body).toBe(
		"Edited body\n",
	);

	await expect(
		(() =>
			replaceWorkflowRecordFromEditedMarkdown({
				storePath,
				recordId: created.id,
				markdown: formatWorkflowRecordMarkdown({
					...edited,
					state: "done",
					resolution: "completed",
				}),
				now: laterDate,
			}))(),
	).rejects.toThrow(
		/field 'state' is not editable through record frontmatter edits/,
	);
});

it("when parsing record Markdown, it should validate filename kind and id", async () => {
	const parsed = parseWorkflowRecordMarkdown(
		`---\nid: 1\ntitle: Parsed\nkind: wayfinder\nsubkind: null\nstate: ready\nresolution: null\nscope:\n  type: global\nparent: null\ninitiative: null\ndependsOn: []\ngeneratedBy: null\ntags: []\nprofile: null\ncreatedAt: "2026-09-19T00:00:00.000Z"\nupdatedAt: "2026-09-19T00:00:00.000Z"\n---\n\nBody\n`,
		{ expectedId: 1 as RecordId, expectedKind: "wayfinder" },
	);
	expect(parsed.body).toBe("Body\n");

	expect(paddedRecordId(parsed.id)).toBe("000001");
	expect(() =>
		parseWorkflowRecordMarkdown(formatWorkflowRecordMarkdown(parsed), {
			expectedId: 2 as RecordId,
			expectedKind: "wayfinder",
		}),
	).toThrow(/record file id '1' does not match expected id '2'/);
});

it("when mutating dependencies, it should persist validated edges and rebuild relationship indexes", async () => {
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

	expect(updated.dependsOn).toEqual([blocker.id]);
	expect(updated.updatedAt).toBe(laterDate.toISOString());
	expect((await readWorkflowRecord(storePath, blocked.id)).dependsOn).toEqual([
		blocker.id,
	]);
	let relationships = JSON.parse(
		await readFile(storeRootPaths(storePath).relationshipsIndex, "utf8"),
	);
	expect(relationships[String(blocker.id)].dependents).toEqual([blocked.id]);
	expect(relationships[String(blocked.id)].dependsOn).toEqual([blocker.id]);

	await removeWorkflowRecordDependency({
		storePath,
		recordId: blocked.id,
		dependsOn: blocker.id,
		now: laterDate,
	});
	expect((await readWorkflowRecord(storePath, blocked.id)).dependsOn).toEqual(
		[],
	);
	relationships = JSON.parse(
		await readFile(storeRootPaths(storePath).relationshipsIndex, "utf8"),
	);
	expect(relationships[String(blocker.id)].dependents).toEqual([]);

	await expect(
		(() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: blocked.id,
				dependsOn: parent.id,
			}))(),
	).rejects.toThrow(
		/direct dependency edges between parents and children are disallowed/,
	);
});

it("when creating dependency edges, it should reject missing dependencies, incompatible scopes, and cycles", async () => {
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

	await expect(
		(() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: first.id,
				dependsOn: 999 as RecordId,
			}))(),
	).rejects.toThrow(/Record '999' was not found/);
	await expect(
		(() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: first.id,
				dependsOn: outsider.id,
			}))(),
	).rejects.toThrow(/dependency scopes are not compatible/);
	await expect(
		(() =>
			addWorkflowRecordDependency({
				storePath,
				recordId: first.id,
				dependsOn: second.id,
			}))(),
	).rejects.toThrow(/dependency would create a cycle/);
});

it("when persisting lifecycle transitions, it should update the record and append ordered updates", async () => {
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
	expect(started.state).toBe("in-progress");
	expect(
		(await startWorkflowRecord({ storePath, recordId: spec.id })).state,
	).toBe("in-progress");

	const done = await completeWorkflowRecord({
		storePath,
		recordId: spec.id,
		resolution: "completed",
		now: new Date("2026-09-21T00:00:00.000Z"),
	});
	expect(done.state).toBe("done");
	expect(done.resolution).toBe("completed");
	expect(
		(await listRecordUpdates(storePath, spec.id)).map((update) => [
			update.sequence,
			update.type,
		]),
	).toEqual([
		[1, "create"],
		[2, "start"],
		[doneUpdateSequence, "done"],
	]);
});

it("when persisting comments, it should store editable comment files and combine history with updates", async () => {
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
	expect((await listRecordComments(storePath, spec.id))[0]).toEqual(comment);

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
	expect(edited.body).toBe("Edited note\n");
	expect(edited.updatedAt).toBe("2026-09-21T00:00:00.000Z");
	await expect(
		(() =>
			replaceRecordCommentFromEditedMarkdown({
				storePath,
				recordId: spec.id,
				commentId: comment.id,
				markdown: formatRecordCommentMarkdown({ ...edited, id: 2 as never }),
			}))(),
	).rejects.toThrow(/comment id '2' does not match expected id '1'/);
	expect(
		(await listRecordHistory(storePath, spec.id)).map((entry) => entry.kind),
	).toEqual(["update", "update", "comment", "update"]);
});

it("when mutating initiative membership and declared projects, it should persist indexes and history events", async () => {
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
	expect(JSON.parse(await readFile(paths.byInitiativeIndex, "utf8"))).toEqual({
		"1": {
			declaredProjects: ["docs", "harness"],
			members: [spec.id],
			projects: ["harness"],
		},
	});
	expect(
		JSON.parse(await readFile(paths.relationshipsIndex, "utf8"))["1"]
			.initiativeMembers,
	).toEqual([spec.id]);
	expect(
		(await listRecordUpdates(storePath, spec.id)).map((update) => update.type),
	).toEqual(["create", "initiative-attach"]);
	expect(
		(await listRecordUpdates(storePath, initiative.id)).map(
			(update) => update.type,
		),
	).toEqual(["create", "initiative-project-add"]);
	await expect(
		(() =>
			removeInitiativeDeclaredProject({
				storePath,
				initiativeId: initiative.id,
				project: parseProjectId("harness"),
			}))(),
	).rejects.toThrow(
		/cannot remove declared project 'harness' while member 2 uses it/,
	);
});

it("when querying initiative scoped navigation, it should include initiative records and members", async () => {
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

	expect(
		(
			await listWorkflowRecordReadiness(storePath, {
				project: parseProjectId("docs"),
				planning: true,
			})
		).map((diagnosis) => diagnosis.recordId),
	).toEqual([initiative.id, wayfinder.id]);
	expect(
		(
			await selectNextWorkflowRecord(storePath, {
				initiative: initiative.id,
				planning: true,
			})
		)?.id,
	).toBe(initiative.id);
});

it("when using Effect read APIs, it should read records, history, readiness, and lists", async () => {
	const storePath = await tempStore();
	const spec = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Effect-read spec",
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
	const task = await createWorkflowRecord({
		storePath,
		now: fixedDate,
		input: {
			title: "Effect-read task",
			kind: "task",
			subkind: null,
			scope: spec.scope,
			parent: spec.id,
			initiative: null,
			dependsOn: [],
			generatedBy: null,
			tags: [],
			profile: null,
			body: "Task body\n",
		},
	});
	await addRecordComment({
		storePath,
		recordId: task.id,
		body: "Effect comment\n",
		now: laterDate,
	});

	expect(
		(await runForgePromise(listWorkflowRecordsEffect(storePath))).map(
			(record) => record.id,
		),
	).toEqual([spec.id, task.id]);
	expect(
		(await runForgePromise(readWorkflowRecordEffect(storePath, task.id))).body,
	).toBe("Task body\n");
	expect(
		(await runForgePromise(listRecordHistoryEffect(storePath, task.id))).map(
			(entry) => entry.kind,
		),
	).toEqual(["update", "update", "comment"]);
	expect(
		(await runForgePromise(listWorkflowRecordReadinessEffect(storePath))).map(
			(diagnosis) => diagnosis.recordId,
		),
	).toEqual([task.id]);
});

it("when using Effect mutation APIs, it should persist records, lifecycle, comments, and indexes", async () => {
	const storePath = await tempStore();

	const created = await runForgePromise(
		createWorkflowRecordEffect({
			storePath,
			now: fixedDate,
			input: {
				title: "Effect-created spec",
				kind: "spec",
				subkind: null,
				scope: { type: "project", project: parseProjectId("harness") },
				parent: null,
				initiative: null,
				dependsOn: [],
				generatedBy: null,
				tags: [],
				profile: null,
				body: "Created through Effect.\n",
			},
		}),
	);
	const started = await runForgePromise(
		startWorkflowRecordEffect({
			storePath,
			recordId: created.id,
			now: laterDate,
		}),
	);
	const comment = await runForgePromise(
		addRecordCommentEffect({
			storePath,
			recordId: created.id,
			body: "Mutated through Effect.\n",
			now: laterDate,
		}),
	);

	expect(created.id).toBe(1);
	expect(started.state).toBe("in-progress");
	expect(comment.id).toBe(1);
	expect((await readWorkflowRecord(storePath, created.id)).body).toBe(
		"Created through Effect.\n",
	);
	expect(
		JSON.parse(await readFile(storeRootPaths(storePath).byIdIndex, "utf8")),
	).toEqual({
		"1": { kind: "spec", path: "records/spec/000/000001.md" },
	});
});

it("when the Effect create API has invalid references, it should fail with a ForgeError", async () => {
	const storePath = await tempStore();

	const exit = await runForgePromise(
		Effect.exit(
			createWorkflowRecordEffect({
				storePath,
				now: fixedDate,
				input: {
					title: "Missing parent task",
					kind: "task",
					subkind: null,
					scope: { type: "project", project: parseProjectId("harness") },
					parent: missingRecordId,
					initiative: null,
					dependsOn: [],
					generatedBy: null,
					tags: [],
					profile: null,
					body: "Cannot place this task.\n",
				},
			}),
		),
	);
	const error = failureFromExit(exit);

	expect(isForgeError(error)).toBe(true);
	if (isForgeError(error)) {
		expect(error.kind).toBe("record-not-found");
		expect(error.details).toEqual({ recordId: missingRecordId });
	}
});

it("when the Effect read API misses a record, it should fail with a record-not-found ForgeError", async () => {
	const storePath = await tempStore();

	const exit = await runForgePromise(
		Effect.exit(readWorkflowRecordEffect(storePath, missingRecordId)),
	);
	const error = failureFromExit(exit);

	expect(isForgeError(error)).toBe(true);
	if (isForgeError(error)) {
		expect(error.kind).toBe("record-not-found");
		expect(error.details).toEqual({ recordId: missingRecordId });
	}
});

it("when querying relationship and readiness views, it should return deterministic store-backed results", async () => {
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

	expect(
		(await readRecordTree(storePath, spec.id)).children.map(
			(child) => child.record.id,
		),
	).toEqual([blocker.id, blocked.id]);
	expect(
		(await readRecordDependencyView(storePath, blocked.id)).dependsOn.map(
			(record) => record.id,
		),
	).toEqual([blocker.id]);
	expect(
		(await listWorkflowRecordReadiness(storePath, { blocked: false })).map(
			(diagnosis) => diagnosis.recordId,
		),
	).toEqual([blocker.id]);
	expect(
		(await listWorkflowRecordReadiness(storePath, { blocked: true })).map(
			(diagnosis) => diagnosis.recordId,
		),
	).toEqual([blocked.id]);
	expect((await selectNextWorkflowRecord(storePath))?.id).toBe(blocker.id);
});
