import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isCliEntrypoint, runCli } from "./cli.ts";

const packageRoot = new URL("../", import.meta.url);

function capture() {
	let text = "";
	return {
		stream: {
			write(chunk: string) {
				text += chunk;
				return true;
			},
		},
		text: () => text,
	};
}

async function runTempStoreCli(
	args: ReadonlyArray<string>,
	options: {
		readonly home: string;
		readonly store: string;
		readonly cwd?: string;
		readonly stdin?: NodeJS.ReadableStream;
		readonly stdout?: Pick<NodeJS.WriteStream, "write">;
		readonly stderr?: Pick<NodeJS.WriteStream, "write">;
		readonly env?: NodeJS.ProcessEnv;
	},
) {
	const stdout = options.stdout ?? capture().stream;
	const stderr = options.stderr ?? capture().stream;
	return runCli(["--store", options.store, ...args], {
		cwd: options.cwd,
		stdin: options.stdin,
		stdout,
		stderr,
		env: { HOME: options.home, ...options.env },
	});
}

test("when the package is created, it should expose the forge binary and checks", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("package.json", packageRoot), "utf8"),
	);
	assert.equal(manifest.name, "@albizures/forge");
	assert.equal(manifest.bin.forge, "./dist/cli.js");
	assert.equal(manifest.exports["."], "./dist/index.js");
	assert.deepEqual(manifest.files, ["dist"]);
	assert.equal(manifest.scripts.build, "tsc -p tsconfig.build.json");
	assert.equal(
		manifest.scripts.typecheck,
		"tsc --noEmit --project tsconfig.json",
	);
	assert.equal(manifest.scripts.test, "node --test");
});

test("when the binary is launched through a symlink, it should still run as the CLI entrypoint", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "forge-cli-entrypoint-"));
	const target = path.join(temp, "cli.js");
	const link = path.join(temp, "forge");
	await writeFile(target, "");
	await symlink(target, link);

	assert.equal(isCliEntrypoint(pathToFileURL(target).href, link), true);
});

test("when help is requested, it should describe the Phase 2 command surface", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	assert.equal(code, 0);
	assert.match(stdout.text(), /forge config get/);
	assert.match(stdout.text(), /forge project add/);
	assert.match(stdout.text(), /forge new spec/);
	assert.match(stdout.text(), /forge show/);
	assert.equal(stderr.text(), "");
});

test("when record CLI commands run, they should create, inspect, and list workflow records", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-record-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	let stdout = capture();
	assert.equal(
		await runCli(
			[
				"--store",
				store,
				"new",
				"spec",
				"--title",
				"Build record CLI",
				"--body",
				"Spec body",
				"--project",
				"harness",
				"--json",
			],
			{ stdout: stdout.stream, env },
		),
		0,
	);
	const spec = JSON.parse(stdout.text());
	assert.equal(spec.id, 1);
	assert.equal(spec.kind, "spec");

	stdout = capture();
	assert.equal(
		await runCli(
			[
				"--store",
				store,
				"new",
				"task",
				"--title",
				"Write tests",
				"--description",
				"-",
				"--parent",
				"1",
				"--kind",
				"review",
				"--json",
			],
			{ stdout: stdout.stream, env, stdin: Readable.from(["Task body\n"]) },
		),
		0,
	);
	const task = JSON.parse(stdout.text());
	assert.equal(task.id, 2);
	assert.equal(task.body, "Task body\n");
	assert.equal(task.subkind, "review");

	stdout = capture();
	assert.equal(
		await runCli(["--store", store, "show", "1", "--json"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).relationships.children, [2]);

	stdout = capture();
	assert.equal(
		await runCli(["--store", store, "list", "--kind", "task"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /2\ttask\tready\tWrite tests/);

	stdout = capture();
	assert.equal(
		await runCli(["--store", store, "open", "2"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /records\/task\/000\/000002\.md/);
});

test("when temp-store record commands run, they should cover creation, inspection, and guarded edits", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-temp-store-home-"),
	);
	const store = path.join(home, "store");
	const projectRoot = path.join(home, "repo");
	const nestedCwd = path.join(projectRoot, "packages", "app");
	const env = { HOME: home };
	const specId = 1;
	const wayfinderId = 2;
	const taskId = 3;
	const grillingId = 4;
	const executableFileMode = 0o755;

	let stdout = capture();
	assert.equal(
		await runTempStoreCli(
			[
				"project",
				"add",
				"harness",
				"--root",
				projectRoot,
				"--name",
				"Harness",
				"--json",
			],
			{ home, store, stdout: stdout.stream },
		),
		0,
	);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			[
				"new",
				"spec",
				"--title",
				"Inferred project spec",
				"--body",
				"Initial spec body",
				"--json",
			],
			{ home, store, cwd: nestedCwd, stdout: stdout.stream },
		),
		0,
	);
	const spec = JSON.parse(stdout.text());
	assert.equal(spec.id, specId);
	assert.deepEqual(spec.scope, { type: "project", project: "harness" });

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			[
				"new",
				"wayfinder",
				"--title",
				"Global wayfinder",
				"--body",
				"Wayfinder body",
				"--scope",
				"global",
				"--json",
			],
			{ home, store, stdout: stdout.stream },
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).id, wayfinderId);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			[
				"new",
				"task",
				"--title",
				"Implementation task",
				"--description",
				"Task body",
				"--parent",
				"1",
				"--json",
			],
			{ home, store, stdout: stdout.stream },
		),
		0,
	);
	const task = JSON.parse(stdout.text());
	assert.equal(task.id, taskId);
	assert.deepEqual(task.dependsOn, []);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			[
				"new",
				"grilling",
				"--title",
				"Clarify scope",
				"--description",
				"Question body",
				"--parent",
				"1",
				"--json",
			],
			{ home, store, stdout: stdout.stream },
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).id, grillingId);

	const stderr = capture();
	assert.notEqual(
		await runTempStoreCli(
			[
				"new",
				"task",
				"--title",
				"Nested task",
				"--description",
				"Invalid body",
				"--parent",
				"3",
			],
			{ home, store, stderr: stderr.stream },
		),
		0,
	);
	assert.match(stderr.text(), /parent must be a spec or wayfinder/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["show", "1", "--json"], {
			home,
			store,
			stdout: stdout.stream,
		}),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).relationships.children, [
		taskId,
		grillingId,
	]);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["list", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
		}),
		0,
	);
	assert.match(stdout.text(), /1\tspec\tready\tInferred project spec/);
	assert.match(stdout.text(), /3\ttask\tready\tImplementation task/);
	assert.match(stdout.text(), /4\tgrilling\tready\tClarify scope/);
	assert.doesNotMatch(stdout.text(), /Global wayfinder/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["open", "3"], {
			home,
			store,
			stdout: stdout.stream,
		}),
		0,
	);
	assert.match(stdout.text(), /records\/task\/000\/000003\.md/);

	const editor = path.join(home, "forge-test-editor.cjs");
	await writeFile(
		editor,
		`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.argv[2];
let text = fs.readFileSync(file, "utf8");
switch (process.env.FORGE_TEST_EDIT_MODE) {
  case "title-body":
    text = text.replace(/^title: .*$/m, "title: Edited task");
    text = text.replace("Task body\\n", "Edited task body\\n");
    break;
  case "immutable":
    text = text.replace(/^id: 3$/m, "id: 999");
    break;
  case "lifecycle":
    text = text.replace(/^state: ready$/m, "state: in-progress");
    break;
  case "relationship":
    text = text.replace(/^parent: 1$/m, "parent: 2");
    break;
  default:
    throw new Error("unknown edit mode " + process.env.FORGE_TEST_EDIT_MODE);
}
fs.writeFileSync(file, text);
`,
		"utf8",
	);
	await chmod(editor, executableFileMode);

	stdout = capture();
	process.env.FORGE_TEST_EDIT_MODE = "title-body";
	try {
		assert.equal(
			await runTempStoreCli(["edit", "3", "--json"], {
				home,
				store,
				stdout: stdout.stream,
				env: { ...env, EDITOR: editor },
			}),
			0,
		);
	} finally {
		delete process.env.FORGE_TEST_EDIT_MODE;
	}
	const edited = JSON.parse(stdout.text()).record;
	assert.equal(edited.title, "Edited task");
	assert.equal(edited.body, "Edited task body\n");

	for (const [mode, rejection] of [
		["immutable", /record file id '999' does not match expected id '3'/],
		["lifecycle", /field 'state' is not editable/],
		["relationship", /field 'parent' is not editable/],
	] as const) {
		const editStderr = capture();
		process.env.FORGE_TEST_EDIT_MODE = mode;
		try {
			assert.notEqual(
				await runTempStoreCli(["edit", "3"], {
					home,
					store,
					stderr: editStderr.stream,
					env: { ...env, EDITOR: editor },
				}),
				0,
			);
		} finally {
			delete process.env.FORGE_TEST_EDIT_MODE;
		}
		assert.match(editStderr.text(), rejection);
	}
});

test("when Phase 3 navigation commands run, they should mutate dependencies and select ready work", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-phase3-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	for (const args of [
		[
			"new",
			"spec",
			"--title",
			"Phase 3 spec",
			"--body",
			"Spec body",
			"--project",
			"harness",
		],
		[
			"new",
			"task",
			"--title",
			"First task",
			"--description",
			"First body",
			"--parent",
			"1",
		],
		[
			"new",
			"task",
			"--title",
			"Second task",
			"--description",
			"Second body",
			"--parent",
			"1",
		],
		[
			"new",
			"grilling",
			"--title",
			"Human checkpoint",
			"--description",
			"Question",
			"--parent",
			"1",
		],
	] as const) {
		assert.equal(await runTempStoreCli(args, { home, store, env }), 0);
	}

	let stdout = capture();
	assert.equal(
		await runTempStoreCli(["deps", "add", "3", "--depends-on", "2", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).dependsOn, [2]);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["deps", "3"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /3\ttask\tready\tSecond task/);
	assert.match(stdout.text(), /dependsOn\t2\ttask\tready\tFirst task/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["ready", "--blocked", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /3\ttask\tblocked\tSecond task/);
	assert.match(stdout.text(), /Dependency 2 is ready, not done\./);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["ready", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /2\ttask\tready\tFirst task/);
	assert.doesNotMatch(stdout.text(), /Second task/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["ready", "--include-hitl", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /4\tgrilling\tready\tHuman checkpoint/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["next", "--project", "harness", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).id, 2);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["next", "--include-hitl", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /2\ttask\tready\tFirst task/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["tree", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /1\tspec\tready\tPhase 3 spec/);
	assert.match(stdout.text(), / {2}3\ttask\tready\tSecond task/);

	const cycleStderr = capture();
	assert.notEqual(
		await runTempStoreCli(["deps", "add", "2", "--depends-on", "3"], {
			home,
			store,
			stderr: cycleStderr.stream,
			env,
		}),
		0,
	);
	assert.match(cycleStderr.text(), /dependency would create a cycle/);

	for (const args of [
		[
			"new",
			"spec",
			"--title",
			"Other project spec",
			"--body",
			"Other body",
			"--project",
			"other",
		],
		[
			"new",
			"task",
			"--title",
			"Other project task",
			"--description",
			"Other task body",
			"--parent",
			"5",
		],
	] as const) {
		assert.equal(await runTempStoreCli(args, { home, store, env }), 0);
	}

	const scopeStderr = capture();
	assert.notEqual(
		await runTempStoreCli(["deps", "add", "6", "--depends-on", "2"], {
			home,
			store,
			stderr: scopeStderr.stream,
			env,
		}),
		0,
	);
	assert.match(scopeStderr.text(), /dependency scopes are not compatible/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			["deps", "remove", "3", "--depends-on", "2", "--json"],
			{ home, store, stdout: stdout.stream, env },
		),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).dependsOn, []);
});

test("when Phase 5 initiative CLI commands run, they should create groups, mutate membership, and filter navigation", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-phase5-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	for (const args of [
		[
			"new",
			"initiative",
			"--title",
			"Cross-project launch",
			"--body",
			"Coordinate work",
			"--projects",
			"harness,docs-site",
		],
		[
			"new",
			"spec",
			"--title",
			"Harness spec",
			"--body",
			"Harness body",
			"--project",
			"harness",
			"--initiative",
			"1",
		],
		[
			"new",
			"wayfinder",
			"--title",
			"Shared route",
			"--body",
			"Map route",
			"--initiative",
			"1",
		],
	] as const) {
		assert.equal(await runTempStoreCli(args, { home, store, env }), 0);
	}

	let stdout = capture();
	assert.equal(
		await runTempStoreCli(["initiatives", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /1\tinitiative\tready\tCross-project launch/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["list", "--initiative", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /2\tspec\tready\tHarness spec/);
	assert.match(stdout.text(), /3\twayfinder\tready\tShared route/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			[
				"new",
				"spec",
				"--title",
				"Docs spec",
				"--body",
				"Docs body",
				"--project",
				"docs-site",
				"--json",
			],
			{ home, store, stdout: stdout.stream, env },
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).initiative, null);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["initiative", "attach", "1", "4", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).initiative, 1);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["deps", "add", "4", "--depends-on", "2", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).dependsOn, [2]);

	let stderr = capture();
	assert.notEqual(
		await runTempStoreCli(
			["initiative", "project", "remove", "1", "docs-site"],
			{
				home,
				store,
				stderr: stderr.stream,
				env,
			},
		),
		0,
	);
	assert.match(
		stderr.text(),
		/cannot remove declared project 'docs-site' while member 4 uses it/,
	);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["initiative", "detach", "1", "4", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).initiative, null);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			["initiative", "project", "remove", "1", "docs-site", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).scope.projects, ["harness"]);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			["initiative", "project", "add", "1", "docs-site", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()).scope.projects, [
		"docs-site",
		"harness",
	]);

	assert.equal(
		await runTempStoreCli(["deps", "remove", "4", "--depends-on", "2"], {
			home,
			store,
			env,
		}),
		0,
	);

	stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["deps", "add", "4", "--depends-on", "2"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(stderr.text(), /dependency scopes are not compatible/);
});

test("when Phase 5 initiative delivery runs, it should gate lifecycle and select first deliverables", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-phase5-delivery-home-"),
	);
	const store = path.join(home, "store");
	const env = { HOME: home };
	const initiativeId = "1";
	const harnessSpecId = "2";
	const firstHarnessTaskId = "3";
	const docsSpecId = "4";
	const firstDocsTaskId = "5";

	for (const args of [
		[
			"new",
			"initiative",
			"--title",
			"Launch suite",
			"--body",
			"Ship coordinated work",
			"--projects",
			"harness,docs-site",
		],
		[
			"new",
			"spec",
			"--title",
			"Harness deliverable",
			"--body",
			"Build harness side",
			"--project",
			"harness",
			"--initiative",
			initiativeId,
		],
		[
			"new",
			"task",
			"--title",
			"First harness task",
			"--description",
			"Create first deliverable",
			"--parent",
			harnessSpecId,
		],
		[
			"new",
			"spec",
			"--title",
			"Docs deliverable",
			"--body",
			"Build docs side",
			"--project",
			"docs-site",
			"--initiative",
			initiativeId,
		],
		[
			"new",
			"task",
			"--title",
			"First docs task",
			"--description",
			"Publish docs after harness",
			"--parent",
			docsSpecId,
			"--depends-on",
			firstHarnessTaskId,
		],
	] as const) {
		assert.equal(await runTempStoreCli(args, { home, store, env }), 0);
	}

	let stdout = capture();
	assert.equal(
		await runTempStoreCli(["ready", "--initiative", initiativeId], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /3\ttask\tready\tFirst harness task/);
	assert.doesNotMatch(stdout.text(), /5\ttask\tready\tFirst docs task/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["next", "--initiative", initiativeId, "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).id, Number(firstHarnessTaskId));

	let stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["done", initiativeId, "--resolution", "completed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(
		stderr.text(),
		/initiative records cannot be done while member 2 is ready/,
	);

	for (const id of [firstHarnessTaskId, harnessSpecId] as const) {
		assert.equal(
			await runTempStoreCli(["done", id, "--resolution", "completed"], {
				home,
				store,
				env,
			}),
			0,
		);
	}

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["ready", "--initiative", initiativeId], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /5\ttask\tready\tFirst docs task/);

	for (const id of [firstDocsTaskId, docsSpecId] as const) {
		assert.equal(
			await runTempStoreCli(["done", id, "--resolution", "completed"], {
				home,
				store,
				env,
			}),
			0,
		);
	}

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			["done", initiativeId, "--resolution", "completed", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).state, "done");

	stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["start", firstDocsTaskId], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(stderr.text(), /Done record 5 cannot be started\./);
});

test("when Phase 4 lifecycle and history commands run, they should mutate records and present narrative streams", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-phase4-home-"));
	const store = path.join(home, "store");
	const note = path.join(home, "note.md");
	const env = { HOME: home };
	const executableFileMode = 0o755;

	for (const args of [
		[
			"new",
			"spec",
			"--title",
			"Phase 4 spec",
			"--body",
			"Spec body",
			"--project",
			"harness",
		],
		[
			"new",
			"task",
			"--title",
			"Do work",
			"--description",
			"Task body",
			"--parent",
			"1",
		],
		[
			"new",
			"task",
			"--title",
			"Blocked work",
			"--description",
			"Blocked body",
			"--parent",
			"1",
			"--depends-on",
			"2",
		],
		[
			"new",
			"grilling",
			"--title",
			"Resolve open question",
			"--description",
			"Question body",
			"--parent",
			"1",
		],
	] as const) {
		assert.equal(await runTempStoreCli(args, { home, store, env }), 0);
	}

	let stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["done", "1", "--resolution", "completed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(
		stderr.text(),
		/spec records cannot be done while child 2 is ready/,
	);

	stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["start", "3"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(stderr.text(), /Dependency 2 is ready, not done\./);

	let stdout = capture();
	assert.equal(
		await runTempStoreCli(["start", "2", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).state, "in-progress");

	stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["done", "2", "--resolution", "Not Valid"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(stderr.text(), /resolution must be lowercase kebab-case/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			["done", "2", "--resolution", "completed", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).resolution, "completed");

	stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["done", "2", "--resolution", "changed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(stderr.text(), /already has resolution 'completed'/);
	assert.equal(
		await runTempStoreCli(["done", "3", "--resolution", "completed"], {
			home,
			store,
			env,
		}),
		0,
	);

	stderr = capture();
	assert.notEqual(
		await runTempStoreCli(["done", "1", "--resolution", "completed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.match(
		stderr.text(),
		/spec records cannot be done while child 4 is ready/,
	);
	assert.equal(
		await runTempStoreCli(["done", "4", "--resolution", "answered"], {
			home,
			store,
			env,
		}),
		0,
	);

	await writeFile(note, "File note\n", "utf8");
	for (const args of [
		["comment", "1", "--message", "Inline note"],
		["comment", "1", "--message-file", note],
	] as const) {
		assert.equal(await runTempStoreCli(args, { home, store, env }), 0);
	}
	assert.equal(
		await runTempStoreCli(["comment", "1", "--message", "-"], {
			home,
			store,
			stdin: Readable.from(["Stdin note\n"]),
			env,
		}),
		0,
	);

	const editor = path.join(home, "forge-comment-editor.cjs");
	await writeFile(
		editor,
		`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.argv[2];
let text = fs.readFileSync(file, "utf8");
text = text.replace("Inline note", "Edited inline note");
fs.writeFileSync(file, text);
`,
		"utf8",
	);
	await chmod(editor, executableFileMode);

	assert.equal(
		await runTempStoreCli(["comment", "edit", "1", "1"], {
			home,
			store,
			env: { ...env, EDITOR: editor },
		}),
		0,
	);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["comments", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /comment 1\t/);
	assert.match(stdout.text(), /Edited inline note/);
	assert.match(stdout.text(), /File note/);
	assert.match(stdout.text(), /Stdin note/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["updates", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /update 1\t.*create\tCreated record\./);
	assert.match(stdout.text(), /comment-edit\tEdited comment 1\./);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["history", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /\[update\].*Created record\./);
	assert.match(stdout.text(), /\[comment\] 1/);

	stdout = capture();
	assert.equal(
		await runTempStoreCli(
			["done", "1", "--resolution", "completed", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).state, "done");

	stdout = capture();
	assert.equal(
		await runTempStoreCli(["show", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /Recent comments/);
	assert.match(stdout.text(), /Recent updates/);
});

test("when config and store commands run, they should write config and present store state", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	let stdout = capture();
	const stderr = capture();
	assert.equal(
		await runCli(["config", "set", "storePath", store, "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			env,
		}),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()), {
		updated: true,
		storePath: store,
	});
	assert.equal(stderr.text(), "");

	stdout = capture();
	assert.equal(
		await runCli(["config", "get", "--json"], { stdout: stdout.stream, env }),
		0,
	);
	assert.deepEqual(JSON.parse(stdout.text()), { storePath: store });

	stdout = capture();
	assert.equal(
		await runCli(["config", "get", "storePath"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(stdout.text(), `${store}\n`);

	stdout = capture();
	assert.equal(
		await runCli(["store", "path"], { stdout: stdout.stream, env }),
		0,
	);
	assert.equal(stdout.text(), `${store}\n`);

	stdout = capture();
	assert.equal(
		await runCli(["store", "doctor", "--json"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).ok, true);
});

test("when project commands run, they should register roots and infer the current project", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-project-home-"));
	const store = path.join(home, "store");
	const projectRoot = path.join(home, "repo");
	const nestedRoot = path.join(projectRoot, "packages", "app");
	const env = { HOME: home };

	let stdout = capture();
	assert.equal(
		await runCli(
			[
				"--store",
				store,
				"project",
				"add",
				"harness",
				"--root",
				projectRoot,
				"--name",
				"Harness Repo",
				"--remote",
				"git@example.test:harness.git",
				"--json",
			],
			{ stdout: stdout.stream, env },
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).name, "Harness Repo");

	stdout = capture();
	assert.equal(
		await runCli(
			["--store", store, "project", "root", "add", "harness", nestedRoot],
			{ stdout: stdout.stream, env },
		),
		0,
	);
	assert.match(stdout.text(), /harness\tHarness Repo/);

	stdout = capture();
	assert.equal(
		await runCli(["--store", store, "projects"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.match(stdout.text(), /harness\tHarness Repo/);

	stdout = capture();
	assert.equal(
		await runCli(
			[
				"--store",
				store,
				"--cwd",
				path.join(nestedRoot, "src"),
				"here",
				"--json",
			],
			{
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.equal(JSON.parse(stdout.text()).id, "harness");

	stdout = capture();
	assert.equal(
		await runCli(
			["--store", store, "project", "root", "remove", "harness", nestedRoot],
			{
				stdout: stdout.stream,
				env,
			},
		),
		0,
	);
	assert.equal(stdout.text().includes(nestedRoot), false);

	stdout = capture();
	assert.equal(
		await runCli(["--store", store, "project", "remove", "harness"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(stdout.text(), "Removed project harness.\n");

	stdout = capture();
	assert.equal(
		await runCli(["--store", store, "projects"], {
			stdout: stdout.stream,
			env,
		}),
		0,
	);
	assert.equal(stdout.text(), "No projects registered.\n");
});
