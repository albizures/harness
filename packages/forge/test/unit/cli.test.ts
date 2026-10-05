import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

import { isCliEntrypoint, runCliEffect, runCliMain } from "../../src/cli.ts";
import { renderRootHelp } from "../../src/cli-help.ts";
import { runTestEffect } from "../support/effect.ts";

const packageRoot = new URL("../../", import.meta.url);

function capture(
	capabilities: { readonly columns?: number; readonly isTTY?: boolean } = {},
) {
	let text = "";
	return {
		stream: {
			...capabilities,
			write(chunk: string) {
				text += chunk;
				return true;
			},
		},
		text: () => text,
	};
}

function runCli(
	args: ReadonlyArray<string>,
	options: Parameters<typeof runCliEffect>[1] = {},
) {
	return runTestEffect(runCliEffect(args, options));
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
	expect(manifest).not.toHaveProperty("exports");
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

	await runTestEffect(
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

describe("when CLI commands use Effect-facing file adapters", () => {
	it("should read body files through the Effect CLI invocation seam", async () => {
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

it("when tree receives extra positional input, it should use native Effect CLI validation", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["tree", "1", "extra"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Received unknown argument: 'extra'/);
	expect(stderr.text()).not.toMatch(/Usage: forge tree/);
});

it("when deps add misses its dependency flag, it should use native Effect CLI validation", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["deps", "add", "1"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Expected to find option: '--depends-on'/);
	expect(stderr.text()).not.toMatch(/Usage: forge deps/);
});

it("when initiative attach receives extra positional input, it should use native Effect CLI validation", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["initiative", "attach", "1", "2", "extra"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Received unknown argument: 'extra'/);
	expect(stderr.text()).not.toMatch(/Usage: forge initiative/);
});

it("when initiative project add misses its project argument, it should use native Effect CLI validation", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["initiative", "project", "add", "1"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});

	expect(code).toBe(1);
	expect(stdout.text()).toBe("");
	expect(stderr.text()).toMatch(/Missing argument <project>/);
	expect(stderr.text()).not.toMatch(/Usage: forge initiative/);
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

describe("when project lookup commands run through the Effect CLI command surface", () => {
	it("should preserve projects listing output and empty registry output", async () => {
		const home = await mkdtemp(
			path.join(os.tmpdir(), "forge-cli-projects-effect-"),
		);
		const store = path.join(home, "store");
		const stdout = capture();
		const stderr = capture();

		expect(
			await runCli(["--store", store, "projects"], {
				stdout: stdout.stream,
				stderr: stderr.stream,
				env: { HOME: home },
			}),
		).toBe(0);
		expect(stdout.text()).toBe("No projects registered.\n");
		expect(stderr.text()).toBe("");
	});

	it("should preserve projects JSON and here JSON current-directory inference", async () => {
		const home = await mkdtemp(
			path.join(os.tmpdir(), "forge-cli-here-effect-"),
		);
		const store = path.join(home, "store");
		const root = path.join(home, "repo");
		const nestedCwd = path.join(root, "packages", "app");
		const env = { HOME: home };
		let stdout = capture();
		let stderr = capture();

		expect(
			await runCli(
				[
					"--store",
					store,
					"project",
					"add",
					"harness",
					"--root",
					root,
					"--name",
					"Harness",
				],
				{ stdout: stdout.stream, stderr: stderr.stream, env },
			),
		).toBe(0);
		expect(stderr.text()).toBe("");

		stdout = capture();
		stderr = capture();
		expect(
			await runCli(["--store", store, "projects", "--json"], {
				stdout: stdout.stream,
				stderr: stderr.stream,
				env,
			}),
		).toBe(0);
		expect(JSON.parse(stdout.text())).toMatchObject([
			{ id: "harness", name: "Harness", roots: [root] },
		]);
		expect(stderr.text()).toBe("");

		stdout = capture();
		stderr = capture();
		expect(
			await runCli(["--store", store, "-C", nestedCwd, "here", "--json"], {
				stdout: stdout.stream,
				stderr: stderr.stream,
				env,
			}),
		).toBe(0);
		expect(JSON.parse(stdout.text())).toMatchObject({
			id: "harness",
			name: "Harness",
			roots: [root],
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
	expect(help).toMatch(/project root add/);
	expect(help).toMatch(/initiative project add/);
	expect(help).not.toMatch(/project project root/);
	expect(help).not.toMatch(/initiative initiative project/);
	expect(help).toMatch(/new spec/);
	expect(help).toMatch(/show/);
	expect(stderr.text()).toBe("");
});

describe("when root help is rendered for an output capability", () => {
	const maximumHelpLineLength = 120;
	it("should preserve the public command order and curated global options", async () => {
		const stdout = capture();
		const stderr = capture();
		const code = await runCli(["--help"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: "/tmp" },
		});
		const help = stdout.text();
		const commands = [
			"config",
			"store",
			"project",
			"new",
			"show",
			"summary",
			"start",
			"done",
			"comment",
			"comments",
			"updates",
			"history",
			"initiatives",
			"initiative",
			"list",
			"ready",
			"next",
			"tree",
			"deps",
			"open",
			"edit",
			"projects",
			"here",
		];
		expect(code).toBe(0);
		const commandPosition = (command: string) =>
			help
				.split("\n")
				.findIndex((line) => line.trimStart().startsWith(`${command} `));
		for (let index = 1; index < commands.length; index += 1) {
			expect(commandPosition(commands[index])).toBeGreaterThan(
				commandPosition(commands[index - 1]),
			);
		}
		const options = help.slice(help.indexOf("OPTIONS"));
		expect(options).toContain("--json");
		expect(options).toContain("--store <path>");
		expect(options).toContain("-C, --cwd <path>");
		expect(options).not.toContain("--profile");
		expect(stderr.text()).toBe("");
	});

	it("should use narrow, wide, and fallback widths without unsafe wrapping", async () => {
		const render = async (columns?: number) => {
			const stdout = capture({ columns });
			const stderr = capture();
			const code = await runCli(["--help"], {
				stdout: stdout.stream,
				stderr: stderr.stream,
				env: { HOME: "/tmp" },
			});
			expect(code).toBe(0);
			expect(stderr.text()).toBe("");
			return stdout.text();
		};
		const narrowWidth = 40;
		const wideWidth = 200;
		const narrow = await render(narrowWidth);
		const wide = await render(wideWidth);
		const fallback = await render();
		expect(narrow).not.toBe(wide);
		expect(fallback).toBe(narrow);
		for (const help of [narrow, wide, fallback]) {
			expect(
				help.split("\n").every((line) => line.length <= maximumHelpLineLength),
			).toBe(true);
			expect(help).toContain("project root add");
		}
	});

	it("should style headings only when color is supported", async () => {
		const nonTty = capture({ columns: 80, isTTY: false });
		const tty = capture({ columns: 80, isTTY: true });
		await runCli(["--help"], { stdout: nonTty.stream, env: { HOME: "/tmp" } });
		await runCli(["--help"], { stdout: tty.stream, env: { HOME: "/tmp" } });
		expect(nonTty.text()).not.toContain("\u001b[");
		expect(tty.text()).toContain("\u001b[");
	});

	it("should clamp width while preserving command names and wrapping descriptions", () => {
		const help = renderRootHelp(
			{
				description: "Description",
				commands: [
					{
						name: "a-command-name-that-is-longer-than-the-terminal",
						synopsis: "A description that should remain readable.",
					},
				],
				options: [],
				guidance: "Guidance",
			},
			{ width: 20 },
		);

		expect(help).toContain("a-command-name-that-is-longer-than-the-terminal");
		expect(
			help.split("\n").some((line) => line.length > maximumHelpLineLength),
		).toBe(false);
	});

	it("should style headings only when color is supported", () => {
		expect(renderRootHelp(undefined, { color: false })).not.toContain(
			"\u001b[",
		);
		expect(renderRootHelp(undefined, { color: true })).toContain("\u001b[");
	});
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

it("when summary runs for a Spec, it should render deterministic parent and direct child facts", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "forge-cli-summary-home-"));
	const store = path.join(home, "store");
	const env = { HOME: home };

	for (const args of [
		[
			"new",
			"spec",
			"--title",
			"Summarized spec",
			"--body",
			"Spec body",
			"--project",
			"harness",
		],
		[
			"new",
			"task",
			"--title",
			"Ship summary command",
			"--description",
			"Task body",
			"--parent",
			"1",
		],
		[
			"new",
			"grilling",
			"--title",
			"Clarify output",
			"--description",
			"Question body",
			"--parent",
			"1",
		],
	] as const) {
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	for (const args of [
		[
			"new",
			"task",
			"--title",
			"Prepare dependency",
			"--description",
			"Dependency body",
			"--parent",
			"1",
		],
		["comment", "2", "--message", "Latest meaningful comment"],
		["deps", "add", "2", "--depends-on", "4"],
	] as const) {
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	for (const args of [
		["done", "4", "--resolution", "prepared"],
		["done", "2", "--resolution", "implemented"],
		["done", "3", "--resolution", "answered"],
		["done", "1", "--resolution", "accepted"],
	] as const) {
		expect(await runTempStoreCli(args, { home, store, env })).toBe(0);
	}

	const stdout = capture();
	expect(
		await runTempStoreCli(["summary", "1"], {
			home,
			store,
			stdout: stdout.stream,
			env,
		}),
	).toBe(0);
	expect(stdout.text()).toBe(
		"1\tspec\tdone\taccepted\tSummarized spec\nchildren\n2\ttask\tdone\timplemented\tShip summary command\n  dependsOn\t4\ttask\tdone\tprepared\tPrepare dependency\n  latestComment\t1\tLatest meaningful comment\n3\tgrilling\tdone\tanswered\tClarify output\n4\ttask\tdone\tprepared\tPrepare dependency\n",
	);

	const jsonStdout = capture();
	expect(
		await runTempStoreCli(["summary", "1", "--json"], {
			home,
			store,
			stdout: jsonStdout.stream,
			env,
		}),
	).toBe(0);
	const summary = JSON.parse(jsonStdout.text());
	const expectedSummaryChildCount = 3;
	expect(summary.record).toMatchObject({
		id: 1,
		kind: "spec",
		title: "Summarized spec",
		state: "done",
		resolution: "accepted",
	});
	expect(summary.dependencies).toEqual({
		dependsOn: [],
		missing: [],
		blockers: { records: [], missing: [] },
	});
	expect(summary.latestComment).toBeNull();
	expect(summary.children).toHaveLength(expectedSummaryChildCount);
	expect(summary.children[0]).toMatchObject({
		record: {
			id: 2,
			kind: "task",
			title: "Ship summary command",
			state: "done",
			resolution: "implemented",
		},
		dependencies: {
			dependsOn: [
				{
					id: 4,
					kind: "task",
					title: "Prepare dependency",
					state: "done",
					resolution: "prepared",
				},
			],
			missing: [],
			blockers: { records: [], missing: [] },
		},
		latestComment: {
			id: 1,
			recordId: 2,
			body: "Latest meaningful comment\n",
		},
	});
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

it("when project add leaf help is requested, it should use generated leaf help", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["project", "add", "--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	const help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/Register a Forge project/);
	expect(help).toMatch(/<id>/);
	expect(help).toMatch(/--root/);
	expect(help).not.toMatch(/Add or remove project roots/);
	expect(stderr.text()).toBe("");
});

it("when nested command help is requested, it should not repeat internal command prefixes", async () => {
	for (const args of [
		["project", "--help"],
		["initiative", "--help"],
		["initiative", "project", "--help"],
	]) {
		const stdout = capture();
		const stderr = capture();
		const code = await runCli(args, {
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: "/tmp" },
		});

		expect(code).toBe(0);
		expect(stdout.text()).not.toMatch(/project project root/);
		expect(stdout.text()).not.toMatch(/initiative initiative project/);
		expect(stderr.text()).toBe("");
	}
});

it("when worktree command help is requested, it should expose the managed worktree surface", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["worktree", "--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	const help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/Manage Forge-owned local git worktrees/);
	expect(help).toMatch(/create/);
	expect(help).toMatch(/info/);
	expect(help).toMatch(/remove/);
	expect(help).toMatch(/list/);
	expect(help).toMatch(/doctor/);
	expect(stderr.text()).toBe("");
});

it("when worktree create help is requested, it should document branch and base flags", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(["worktree", "create", "--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	const help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/Create a managed Forge git worktree/);
	expect(help).toMatch(/<task>/);
	expect(help).toMatch(/--branch/);
	expect(help).toMatch(/--base/);
	expect(help).toMatch(/--path/);
	expect(help).toMatch(/--copy-manifest/);
	expect(stderr.text()).toBe("");
});

it("when worktree read commands find no active binding, they should exit successfully", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-worktree-home-"),
	);
	const store = path.join(home, "store");
	const env = { HOME: home };

	expect(
		await runTempStoreCli(
			[
				"new",
				"spec",
				"--title",
				"Worktree spec",
				"--body",
				"Spec body",
				"--project",
				"harness",
			],
			{ home, store, env },
		),
	).toBe(0);
	expect(
		await runTempStoreCli(
			[
				"new",
				"task",
				"--title",
				"Worktree task",
				"--description",
				"Task body",
				"--parent",
				"1",
			],
			{ home, store, env },
		),
	).toBe(0);

	for (const command of ["info", "remove"] as const) {
		const stdout = capture();
		const stderr = capture();
		expect(
			await runTempStoreCli(["worktree", command, "2"], {
				home,
				store,
				stdout: stdout.stream,
				stderr: stderr.stream,
				env,
			}),
		).toBe(0);
		expect(stdout.text()).toMatch(/Task 2 has no active worktree binding/);
		expect(stderr.text()).toBe("");
	}
});

it("when worktree list sees an empty store, it should render a stable empty result", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-worktree-list-home-"),
	);
	const store = path.join(home, "store");
	const stdout = capture();
	const stderr = capture();

	expect(
		await runTempStoreCli(["worktree", "list"], {
			home,
			store,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: home },
		}),
	).toBe(0);
	expect(stdout.text()).toBe("No managed worktrees.\n");
	expect(stderr.text()).toBe("");
});

it("when worktree doctor sees an empty store, it should report ok without mutation", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-worktree-doctor-home-"),
	);
	const store = path.join(home, "store");
	const stdout = capture();
	const stderr = capture();

	expect(
		await runTempStoreCli(["worktree", "doctor"], {
			home,
			store,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: home },
		}),
	).toBe(0);
	expect(stdout.text()).toBe("Worktree store ok.\n");
	expect(stderr.text()).toBe("");
});

it("when worktree list JSON is requested, it should emit the structured empty contract", async () => {
	const home = await mkdtemp(
		path.join(os.tmpdir(), "forge-cli-worktree-list-json-home-"),
	);
	const store = path.join(home, "store");
	const stdout = capture();

	expect(
		await runTempStoreCli(["worktree", "list", "--json"], {
			home,
			store,
			stdout: stdout.stream,
			env: { HOME: home },
		}),
	).toBe(0);
	expect(JSON.parse(stdout.text())).toEqual({ worktrees: [] });
});

it("when migrated record leaf help is requested, it should use generated leaf help", async () => {
	let stdout = capture();
	let stderr = capture();
	let code = await runCli(["new", "spec", "--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	let help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/--title/);
	expect(help).toMatch(/--body/);
	expect(help).not.toMatch(/Create Forge records/);
	expect(stderr.text()).toBe("");

	stdout = capture();
	stderr = capture();
	code = await runCli(["comment", "edit", "--help"], {
		stdout: stdout.stream,
		stderr: stderr.stream,
		env: { HOME: "/tmp" },
	});
	help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/Edit a record comment/);
	expect(help).toMatch(/<record>/);
	expect(help).toMatch(/<comment>/);
	expect(help).not.toMatch(/--message-file/);
	expect(stderr.text()).toBe("");
});

it("when project add leaf help is requested after root options, it should ignore root option values while routing help", async () => {
	const stdout = capture();
	const stderr = capture();
	const code = await runCli(
		["--store", "/tmp/forge-store", "project", "add", "--help"],
		{
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { HOME: "/tmp" },
		},
	);
	const help = stdout.text();
	expect(code).toBe(0);
	expect(help).toMatch(/Register a Forge project/);
	expect(help).toMatch(/<id>/);
	expect(help).toMatch(/--root/);
	expect(help).not.toMatch(/Forge personal workflow CLI/);
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
