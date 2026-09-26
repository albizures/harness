import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

import { isCliEntrypoint, runCli, runCliMain } from "../../src/cli.ts";
import { runForgePromise } from "../../src/runtime.ts";

const packageRoot = new URL("../../", import.meta.url);

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

it("when the package is created, it should expose the forge binary and checks", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("package.json", packageRoot), "utf8"),
	);
	expect(manifest.name).toBe("@albizures/forge");
	expect(manifest.bin.forge).toBe("./dist/cli.js");
	expect(manifest.exports["."]).toBe("./dist/index.js");
	expect(manifest.files).toEqual(["dist"]);
	expect(manifest.scripts.build).toBe("tsc -p tsconfig.build.json");
	expect(manifest.scripts.typecheck).toBe(
		"tsc --noEmit --project tsconfig.json",
	);
	expect(manifest.scripts.test).toBe(
		"vitest run --config ../../vitest.config.mts",
	);
	expect(manifest.dependencies["@effect/cli"]).toEqual(expect.any(String));
});

it("when the binary is launched through a symlink, it should still run as the CLI entrypoint", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "forge-cli-entrypoint-"));
	const target = path.join(temp, "cli.js");
	const link = path.join(temp, "forge");
	await writeFile(target, "");
	await symlink(target, link);

	expect(isCliEntrypoint(pathToFileURL(target).href, link)).toBe(true);
});

it("when the CLI main effect runs, it should set the process exit code through the Forge runtime", async () => {
	const stdout = capture();
	const stderr = capture();
	const processState: { exitCode?: string | number } = {};

	await runForgePromise(
		runCliMain(
			["--help"],
			{ stdout: stdout.stream, stderr: stderr.stream, env: { HOME: "/tmp" } },
			processState,
		),
	);

	expect(processState.exitCode).toBe(0);
	expect(stdout.text()).toMatch(/Forge personal workflow CLI/);
	expect(stderr.text()).toBe("");
});

describe("when CLI commands use Promise-facing file adapters", () => {
	it("should read body files while preserving the Promise CLI interface", async () => {
		const home = await mkdtemp(
			path.join(os.tmpdir(), "forge-cli-body-file-home-"),
		);
		const store = path.join(home, "store");
		const bodyFile = path.join(home, "body.md");
		await writeFile(bodyFile, "Body from file\n", "utf8");

		const stdout = capture();
		const code = await runTempStoreCli(
			[
				"new",
				"spec",
				"--title",
				"Promise adapter body",
				"--body-file",
				bodyFile,
				"--project",
				"harness",
				"--json",
			],
			{ home, store, stdout: stdout.stream },
		);

		expect(code).toBe(0);
		expect(JSON.parse(stdout.text())).toMatchObject({
			kind: "spec",
			body: "Body from file\n",
		});
	});
});

it("when the root command surface is invalid, it should use native Effect CLI errors", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["--plain"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Invalid subcommand for forge/);
	expect(stderr.text()).not.toMatch(/forge: Unknown flag/);
});

it("when unsupported flags follow known commands, it should use native Effect CLI errors", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["ready", "--plain", "x"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Received unknown argument: '--plain'/);
	expect(stderr.text()).not.toMatch(/forge: Unknown flag/);
});

it("when an unknown subcommand is supplied, it should use native Effect CLI validation", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["config", "nope"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Invalid subcommand for forge/);
	expect(stderr.text()).not.toMatch(/Usage: forge config/);
});

it("when config get receives extra positional input, it should use native Effect CLI validation", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["config", "get", "storePath", "extra"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Received unknown argument: 'extra'/);
	expect(stderr.text()).not.toMatch(/Usage: forge config/);
});

it("when injected runCli options are supplied, root flags parsed by the command surface should preserve them", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-injected-home-"),
	);
	const store = path.join(home, "store");
	const cwd = path.join(home, "workspace");
	const stdout = capture();
	const stderr = capture();

	const code = await runCli(["--store", store, "--cwd", cwd, "store", "path"], {
		cwd: "/should/not/win",
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: home },
	});

	expect(code).toBe(0);
	expect(stdout.text()).toContain(store);
	expect(stderr.text()).toBe("");
});

describe("when store commands run through the Effect CLI command surface", () => {
	it("should preserve store path human output", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-store-path-"));
		const store = path.join(home, "store");
		const stdout = capture();
		const stderr = capture();

		const code = await runCli(["--store", store, "store", "path"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: home },
		});

		expect(code).toBe(0);
		expect(stdout.text()).toBe(`${store}\n`);
		expect(stderr.text()).toBe("");
	});

	it("should preserve store doctor JSON output shape and failing exit code", async () => {
		const home = await mkdtemp(
			path.join(os.tmpdir(), "forge-cli-store-doctor-"),
		);
		const store = path.join(home, "missing-store");
		const stdout = capture();
		const stderr = capture();

		const code = await runCli(["--store", store, "store", "doctor", "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: home },
		});

		expect(code).toBe(2);
		expect(JSON.parse(stdout.text())).toMatchObject({
			ok: false,
			problems: expect.arrayContaining([
				expect.objectContaining({
					path: store,
					message: "Required store directory is missing.",
					repairable: true,
				}),
			]),
			repaired: [],
		});
		expect(stderr.text()).toBe("");
	});
});

it("when help is requested, it should describe the generated Effect CLI command surface", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	const help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/Forge personal workflow CLI/);
	expect(help).toMatch(/COMMANDS/);
	expect(help).toMatch(/config get/);
	expect(help).toMatch(/project add/);
	expect(help).toMatch(/new spec/);
	expect(help).toMatch(/show/);
	expect(stderr.text()).toBe("");
});

it("when record CLI commands run, they should create, inspect, and list workflow records", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-record-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	let stdout = capture();
	expect(
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
	).toBe(0);
	const spec = JSON.parse(stdout.text());
	expect(spec.id).toBe(1);
	expect(spec.kind).toBe("spec");

	stdout = capture();
	expect(
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
	).toBe(0);
	const task = JSON.parse(stdout.text());
	expect(task.id).toBe(2);
	expect(task.body).toBe("Task body\n");
	expect(task.subkind).toBe("review");

	stdout = capture();
	expect(
		await runCli(["--store", store, "show", "1", "--json"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).relationships.children).toEqual([2]);

	stdout = capture();
	expect(
		await runCli(["--store", store, "list", "--kind", "task"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/2\ttask\tready\tWrite tests/);

	stdout = capture();
	expect(
		await runCli(["--store", store, "open", "2"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/records\/task\/000\/000002\.md/);
});

it("when temp-store record commands run, they should cover creation, inspection, and guarded edits", async () => {
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
	expect(
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
	).toBe(0);

	stdout = capture();
	expect(
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
	).toBe(0);
	const spec = JSON.parse(stdout.text());
	expect(spec.id).toBe(specId);
	expect(spec.scope).toEqual({ type: "project", project: "harness" });

	stdout = capture();
	expect(
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
	).toBe(0);
	expect(JSON.parse(stdout.text()).id).toBe(wayfinderId);

	stdout = capture();
	expect(
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
	).toBe(0);
	const task = JSON.parse(stdout.text());
	expect(task.id).toBe(taskId);
	expect(task.dependsOn).toEqual([]);

	stdout = capture();
	expect(
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
	).toBe(0);
	expect(JSON.parse(stdout.text()).id).toBe(grillingId);

	const stderr = capture();
	expect(
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
	).not.toBe(0);
	expect(stderr.text()).toMatch(/parent must be a spec or wayfinder/);

	stdout = capture();
	expect(
		await runTempStoreCli(["show", "1", "--json"], {
			home,
			store,
			stdout: stdout.stream,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).relationships.children).toEqual([
		taskId,
		grillingId,
	]);

	stdout = capture();
	expect(
		await runTempStoreCli(["list", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/1\tspec\tready\tInferred project spec/);
	expect(stdout.text()).toMatch(/3\ttask\tready\tImplementation task/);
	expect(stdout.text()).toMatch(/4\tgrilling\tready\tClarify scope/);
	expect(stdout.text()).not.toMatch(/Global wayfinder/);

	stdout = capture();
	expect(
		await runTempStoreCli(["open", "3"], {
			home,
			store,
			stdout: stdout.stream,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/records\/task\/000\/000003\.md/);

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
		expect(
			await runTempStoreCli(["edit", "3", "--json"], {
				home,
				store,
				stdout: stdout.stream,
				env: { ...env, EDITOR: editor },
			}),
		).toBe(0);
	} finally {
		delete process.env.FORGE_TEST_EDIT_MODE;
	}
	const edited = JSON.parse(stdout.text()).record;
	expect(edited.title).toBe("Edited task");
	expect(edited.body).toBe("Edited task body\n");

	for (const [mode, rejection] of [
		["immutable", /record file id '999' does not match expected id '3'/],
		["lifecycle", /field 'state' is not editable/],
		["relationship", /field 'parent' is not editable/],
	] as const) {
		const editStderr = capture();
		process.env.FORGE_TEST_EDIT_MODE = mode;
		try {
			expect(
				await runTempStoreCli(["edit", "3"], {
					home,
					store,
					stderr: editStderr.stream,
					env: { ...env, EDITOR: editor },
				}),
			).not.toBe(0);
		} finally {
			delete process.env.FORGE_TEST_EDIT_MODE;
		}
		expect(editStderr.text()).toMatch(rejection);
	}
});

it("when Phase 3 navigation commands run, they should mutate dependencies and select ready work", async () => {
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
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	let stdout = capture();
	expect(
		await runTempStoreCli(["deps", "add", "3", "--depends-on", "2", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).dependsOn).toEqual([2]);

	stdout = capture();
	expect(
		await runTempStoreCli(["deps", "3"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/3\ttask\tready\tSecond task/);
	expect(stdout.text()).toMatch(/dependsOn\t2\ttask\tready\tFirst task/);

	stdout = capture();
	expect(
		await runTempStoreCli(["ready", "--blocked", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/3\ttask\tblocked\tSecond task/);
	expect(stdout.text()).toMatch(/Dependency 2 is ready, not done\./);

	stdout = capture();
	expect(
		await runTempStoreCli(["ready", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/2\ttask\tready\tFirst task/);
	expect(stdout.text()).not.toMatch(/Second task/);

	stdout = capture();
	expect(
		await runTempStoreCli(["ready", "--include-hitl", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/4\tgrilling\tready\tHuman checkpoint/);

	stdout = capture();
	expect(
		await runTempStoreCli(["next", "--project", "harness", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).id).toBe(2);

	stdout = capture();
	expect(
		await runTempStoreCli(["next", "--include-hitl", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/2\ttask\tready\tFirst task/);

	stdout = capture();
	expect(
		await runTempStoreCli(["tree", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/1\tspec\tready\tPhase 3 spec/);
	expect(stdout.text()).toMatch(/ {2}3\ttask\tready\tSecond task/);

	const cycleStderr = capture();
	expect(
		await runTempStoreCli(["deps", "add", "2", "--depends-on", "3"], {
			home,
			store,
			stderr: cycleStderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(cycleStderr.text()).toMatch(/dependency would create a cycle/);

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
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	const scopeStderr = capture();
	expect(
		await runTempStoreCli(["deps", "add", "6", "--depends-on", "2"], {
			home,
			store,
			stderr: scopeStderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(scopeStderr.text()).toMatch(/dependency scopes are not compatible/);

	stdout = capture();
	expect(
		await runTempStoreCli(
			["deps", "remove", "3", "--depends-on", "2", "--json"],
			{ home, store, stdout: stdout.stream, env },
		),
	).toBe(0);
	expect(JSON.parse(stdout.text()).dependsOn).toEqual([]);
});

it("when ready JSON is requested, it should emit the structured ready record contract", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-ready-json-home-"),
	);
	const store = path.join(home, "store");
	const env = { HOME: home };
	const specId = 1;
	const readyTaskId = 2;
	const grillingId = 4;

	for (const args of [
		[
			"new",
			"spec",
			"--title",
			"Ready JSON spec",
			"--body",
			"Spec body",
			"--project",
			"harness",
		],
		[
			"new",
			"task",
			"--title",
			"First ready task",
			"--description",
			"First body",
			"--parent",
			"1",
		],
		[
			"new",
			"task",
			"--title",
			"Blocked task",
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
			"Human checkpoint",
			"--description",
			"Question",
			"--parent",
			"1",
		],
	] as const) {
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	let stdout = capture();
	let stderr = capture();
	expect(
		await runTempStoreCli(["ready", "--project", "harness", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env,
		}),
	).toBe(0);
	expect(stderr.text()).toBe("");
	expect(stdout.text()).toMatch(/^\{\n\t"records": \[/);
	expect(stdout.text().endsWith("\n")).toBe(true);
	expect(JSON.parse(stdout.text())).toEqual({
		records: [
			{
				id: readyTaskId,
				kind: "task",
				state: "ready",
				title: "First ready task",
			},
		],
	});

	stdout = capture();
	expect(
		await runTempStoreCli(
			["ready", "--planning", "--project", "harness", "--json"],
			{ home, store, stdout: stdout.stream, env },
		),
	).toBe(0);
	expect(
		JSON.parse(stdout.text()).records.map(
			(record: { id: number }) => record.id,
		),
	).toEqual([specId, readyTaskId]);

	stdout = capture();
	expect(
		await runTempStoreCli(
			["ready", "--include-hitl", "--project", "harness", "--json"],
			{ home, store, stdout: stdout.stream, env },
		),
	).toBe(0);
	expect(
		JSON.parse(stdout.text()).records.map(
			(record: { id: number }) => record.id,
		),
	).toEqual([readyTaskId, grillingId]);

	stdout = capture();
	stderr = capture();
	expect(
		await runTempStoreCli(
			["ready", "--blocked", "--project", "harness", "--json"],
			{ home, store, stdout: stdout.stream, stderr: stderr.stream, env },
		),
	).not.toBe(0);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(
		/ready --json cannot be combined with --blocked/,
	);
});

it("when ready help is requested, it should use generated help and document the blocked incompatibility", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["ready", "--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	expect(code).toBe(0);
	expect(stdout.text()).toMatch(/DESCRIPTION/);
	expect(stdout.text()).toMatch(/--blocked/);
	expect(stdout.text()).toMatch(/JSON output is not supported with --blocked/);
	expect(stderr.text()).toBe("");
});

it("when Phase 5 initiative CLI commands run, they should create groups, mutate membership, and filter navigation", async () => {
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
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	let stdout = capture();
	expect(
		await runTempStoreCli(["initiatives", "--project", "harness"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/1\tinitiative\tready\tCross-project launch/);

	stdout = capture();
	expect(
		await runTempStoreCli(["list", "--initiative", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/2\tspec\tready\tHarness spec/);
	expect(stdout.text()).toMatch(/3\twayfinder\tready\tShared route/);

	stdout = capture();
	expect(
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
	).toBe(0);
	expect(JSON.parse(stdout.text()).initiative).toBe(null);

	stdout = capture();
	expect(
		await runTempStoreCli(["initiative", "attach", "1", "4", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).initiative).toBe(1);

	stdout = capture();
	expect(
		await runTempStoreCli(["deps", "add", "4", "--depends-on", "2", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).dependsOn).toEqual([2]);

	let stderr = capture();
	expect(
		await runTempStoreCli(
			["initiative", "project", "remove", "1", "docs-site"],
			{
				home,
				store,
				stderr: stderr.stream,
				env,
			},
		),
	).not.toBe(0);
	expect(stderr.text()).toMatch(
		/cannot remove declared project 'docs-site' while member 4 uses it/,
	);

	stdout = capture();
	expect(
		await runTempStoreCli(["initiative", "detach", "1", "4", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).initiative).toBe(null);

	stdout = capture();
	expect(
		await runTempStoreCli(
			["initiative", "project", "remove", "1", "docs-site", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
	).toBe(0);
	expect(JSON.parse(stdout.text()).scope.projects).toEqual(["harness"]);

	stdout = capture();
	expect(
		await runTempStoreCli(
			["initiative", "project", "add", "1", "docs-site", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
	).toBe(0);
	expect(JSON.parse(stdout.text()).scope.projects).toEqual([
		"docs-site",
		"harness",
	]);

	expect(
		await runTempStoreCli(["deps", "remove", "4", "--depends-on", "2"], {
			home,
			store,
			env,
		}),
	).toBe(0);

	stderr = capture();
	expect(
		await runTempStoreCli(["deps", "add", "4", "--depends-on", "2"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(/dependency scopes are not compatible/);
});

it("when Phase 5 initiative delivery runs, it should gate lifecycle and select first deliverables", async () => {
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
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	let stdout = capture();
	expect(
		await runTempStoreCli(["ready", "--initiative", initiativeId], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/3\ttask\tready\tFirst harness task/);
	expect(stdout.text()).not.toMatch(/5\ttask\tready\tFirst docs task/);

	stdout = capture();
	expect(
		await runTempStoreCli(["next", "--initiative", initiativeId, "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).id).toBe(Number(firstHarnessTaskId));

	let stderr = capture();
	expect(
		await runTempStoreCli(["done", initiativeId, "--resolution", "completed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(
		/initiative records cannot be done while member 2 is ready/,
	);

	for (const id of [firstHarnessTaskId, harnessSpecId] as const) {
		expect(
			await runTempStoreCli(["done", id, "--resolution", "completed"], {
				home,
				store,
				env,
			}),
		).toBe(0);
	}

	stdout = capture();
	expect(
		await runTempStoreCli(["ready", "--initiative", initiativeId], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/5\ttask\tready\tFirst docs task/);

	for (const id of [firstDocsTaskId, docsSpecId] as const) {
		expect(
			await runTempStoreCli(["done", id, "--resolution", "completed"], {
				home,
				store,
				env,
			}),
		).toBe(0);
	}

	stdout = capture();
	expect(
		await runTempStoreCli(
			["done", initiativeId, "--resolution", "completed", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
	).toBe(0);
	expect(JSON.parse(stdout.text()).state).toBe("done");

	stderr = capture();
	expect(
		await runTempStoreCli(["start", firstDocsTaskId], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(/Done record 5 cannot be started\./);
});

it("when Phase 4 lifecycle and history commands run, they should mutate records and present narrative streams", async () => {
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
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	let stderr = capture();
	expect(
		await runTempStoreCli(["done", "1", "--resolution", "completed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(
		/spec records cannot be done while child 2 is ready/,
	);

	stderr = capture();
	expect(
		await runTempStoreCli(["start", "3"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(/Dependency 2 is ready, not done\./);

	let stdout = capture();
	expect(
		await runTempStoreCli(["start", "2", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).state).toBe("in-progress");

	stderr = capture();
	expect(
		await runTempStoreCli(["done", "2", "--resolution", "Not Valid"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(/resolution must be lowercase kebab-case/);

	stdout = capture();
	expect(
		await runTempStoreCli(
			["done", "2", "--resolution", "completed", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
	).toBe(0);
	expect(JSON.parse(stdout.text()).resolution).toBe("completed");

	stderr = capture();
	expect(
		await runTempStoreCli(["done", "2", "--resolution", "changed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(/already has resolution 'completed'/);
	expect(
		await runTempStoreCli(["done", "3", "--resolution", "completed"], {
			home,
			store,
			env,
		}),
	).toBe(0);

	stderr = capture();
	expect(
		await runTempStoreCli(["done", "1", "--resolution", "completed"], {
			home,
			store,
			stderr: stderr.stream,
			env,
		}),
	).not.toBe(0);
	expect(stderr.text()).toMatch(
		/spec records cannot be done while child 4 is ready/,
	);
	expect(
		await runTempStoreCli(["done", "4", "--resolution", "answered"], {
			home,
			store,
			env,
		}),
	).toBe(0);

	await writeFile(note, "File note\n", "utf8");
	for (const args of [
		["comment", "1", "--message", "Inline note"],
		["comment", "1", "--message-file", note],
	] as const) {
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}
	expect(
		await runTempStoreCli(["comment", "1", "--message", "-"], {
			home,
			store,
			stdin: Readable.from(["Stdin note\n"]),
			env,
		}),
	).toBe(0);

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

	expect(
		await runTempStoreCli(["comment", "edit", "1", "1"], {
			home,
			store,
			env: { ...env, EDITOR: editor },
		}),
	).toBe(0);

	stdout = capture();
	expect(
		await runTempStoreCli(["comments", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/comment 1\t/);
	expect(stdout.text()).toMatch(/Edited inline note/);
	expect(stdout.text()).toMatch(/File note/);
	expect(stdout.text()).toMatch(/Stdin note/);

	stdout = capture();
	expect(
		await runTempStoreCli(["updates", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/update 1\t.*create\tCreated record\./);
	expect(stdout.text()).toMatch(/comment-edit\tEdited comment 1\./);

	stdout = capture();
	expect(
		await runTempStoreCli(["history", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/\[update\].*Created record\./);
	expect(stdout.text()).toMatch(/\[comment\] 1/);

	stdout = capture();
	expect(
		await runTempStoreCli(
			["done", "1", "--resolution", "completed", "--json"],
			{
				home,
				store,
				stdout: stdout.stream,
				env,
			},
		),
	).toBe(0);
	expect(JSON.parse(stdout.text()).state).toBe("done");

	stdout = capture();
	expect(
		await runTempStoreCli(["show", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/Recent comments/);
	expect(stdout.text()).toMatch(/Recent updates/);
});

it("when config and store commands run, they should write config and present store state", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	let stdout = capture();
	const stderr = capture();
	expect(
		await runCli(["config", "set", "storePath", store, "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text())).toEqual({
		updated: true,
		storePath: store,
	});
	expect(stderr.text()).toBe("");

	stdout = capture();
	expect(
		await runCli(["config", "get", "--json"], { stdout: stdout.stream, env }),
	).toBe(0);
	expect(JSON.parse(stdout.text())).toEqual({ storePath: store });

	stdout = capture();
	expect(
		await runCli(["config", "get", "storePath"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toBe(`${store}\n`);

	stdout = capture();
	expect(await runCli(["store", "path"], { stdout: stdout.stream, env })).toBe(
		0,
	);
	expect(stdout.text()).toBe(`${store}\n`);

	stdout = capture();
	expect(
		await runCli(["store", "doctor", "--json"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text()).ok).toBe(true);
});

it("when project commands run, they should register roots and infer the current project", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-project-home-"));
	const store = path.join(home, "store");
	const projectRoot = path.join(home, "repo");
	const nestedRoot = path.join(projectRoot, "packages", "app");
	const env = { HOME: home };

	let stdout = capture();
	expect(
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
	).toBe(0);
	expect(JSON.parse(stdout.text()).name).toBe("Harness Repo");

	stdout = capture();
	expect(
		await runCli(
			["--store", store, "project", "root", "add", "harness", nestedRoot],
			{ stdout: stdout.stream, env },
		),
	).toBe(0);
	expect(stdout.text()).toMatch(/harness\tHarness Repo/);

	stdout = capture();
	expect(
		await runCli(["--store", store, "projects"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toMatch(/harness\tHarness Repo/);

	stdout = capture();
	expect(
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
	).toBe(0);
	expect(JSON.parse(stdout.text()).id).toBe("harness");

	stdout = capture();
	expect(
		await runCli(
			["--store", store, "project", "root", "remove", "harness", nestedRoot],
			{
				stdout: stdout.stream,
				env,
			},
		),
	).toBe(0);
	expect(stdout.text().includes(nestedRoot)).toBe(false);

	stdout = capture();
	expect(
		await runCli(["--store", store, "project", "remove", "harness"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toBe("Removed project harness.\n");

	stdout = capture();
	expect(
		await runCli(["--store", store, "projects"], {
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toBe("No projects registered.\n");
});
