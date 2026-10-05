import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import type { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";
import type { CommandOutput, FlagValue, Parsed } from "./types.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
import {
	decodeProjectAddInput,
	decodeProjectRootInput,
} from "../command-inputs.ts";
import {
	parseAbsolutePath,
	parseProjectId,
	type AbsolutePath,
} from "../domain.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
} from "../filesystem-store.ts";
import {
	addProjectEffect,
	addProjectRootEffect,
	inferProjectByPathEffect,
	listProjectsEffect,
	removeProjectEffect,
	removeProjectRootEffect,
} from "../project-registry.ts";

type CommandHandler = typeof buildCommandHandler;

const projectRootArgumentsOffset = 3;

export function createProjectsCommands(
	commandHandler: CommandHandler = buildCommandHandler,
) {
	const projectAddCommand = CliCommand.make("add", {
		id: Args.text({ name: "id" }),
		root: Options.text("root").pipe(
			Options.withDescription("Project root path."),
		),
		name: Options.text("name").pipe(
			Options.optional,
			Options.withDescription("Human-readable project name."),
		),
		remote: Options.text("remote").pipe(
			Options.optional,
			Options.withDescription("Project remote URL."),
		),
		worktreeCopyManifest: Options.text("worktree-copy-manifest").pipe(
			Options.optional,
			Options.withDescription(
				"Absolute path to this project's default worktree copy manifest.",
			),
		),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["project", "add"], runProjectAddEffect, ["id"]),
		),
		CliCommand.withDescription("Register a Forge project."),
	);
	const projectRootAddCommand = CliCommand.make("add", {
		id: Args.text({ name: "id" }),
		root: Args.text({ name: "path" }),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["project", "root", "add"], runProjectRootEffect, [
				"id",
				"root",
			]),
		),
		CliCommand.withDescription("Add a root to a project."),
	);
	const projectRootRemoveCommand = CliCommand.make("remove", {
		id: Args.text({ name: "id" }),
		root: Args.text({ name: "path" }),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["project", "root", "remove"], runProjectRootEffect, [
				"id",
				"root",
			]),
		),
		CliCommand.withDescription("Remove a root from a project."),
	);
	const projectRootCommand = CliCommand.make("root").pipe(
		CliCommand.withHandler(
			commandHandler(["project", "root"], runProjectEffect),
		),
		CliCommand.withDescription("Add or remove project roots."),
		CliCommand.withSubcommands([
			projectRootAddCommand,
			projectRootRemoveCommand,
		]),
	);
	const projectRemoveCommand = CliCommand.make("remove", {
		id: Args.text({ name: "id" }),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["project", "remove"], runProjectRemoveEffect, ["id"]),
		),
		CliCommand.withDescription("Remove a Forge project."),
	);
	const projectCommand = CliCommand.make("project").pipe(
		CliCommand.withHandler(commandHandler(["project"], runProjectEffect)),
		CliCommand.withDescription("Register and maintain Forge projects."),
		CliCommand.withSubcommands([
			projectAddCommand,
			projectRootCommand,
			projectRemoveCommand,
		]),
	);
	const projectsCommand = CliCommand.make("projects").pipe(
		CliCommand.withHandler(commandHandler(["projects"], runProjectsEffect)),
		CliCommand.withDescription("List registered Forge projects."),
	);
	const hereCommand = CliCommand.make("here").pipe(
		CliCommand.withHandler(commandHandler(["here"], runHereEffect)),
		CliCommand.withDescription(
			"Infer the Forge project for the current directory.",
		),
	);

	return {
		projectCommand,
		projectsCommand,
		hereCommand,
		registrations: [
			{ path: ["project"], descriptor: projectCommand },
			{ path: ["project", "add"], descriptor: projectAddCommand },
			{ path: ["project", "root"], descriptor: projectRootCommand },
			{ path: ["project", "root", "add"], descriptor: projectRootAddCommand },
			{
				path: ["project", "root", "remove"],
				descriptor: projectRootRemoveCommand,
			},
			{ path: ["project", "remove"], descriptor: projectRemoveCommand },
			{ path: ["projects"], descriptor: projectsCommand },
			{ path: ["here"], descriptor: hereCommand },
		],
	};
}

export type ProjectsCommands = ReturnType<typeof createProjectsCommands>;

function runProjectEffect(
	_parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.fail(usage("Usage: forge project <add|root|remove>"));
}

function runProjectAddEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [id] = parsed.positionals.slice(2);
		const input = yield* Effect.try({
			try: () =>
				decodeProjectAddInput({
					id,
					root: stringFlag(parsed.flags.root),
					name: getOptionalStringFlag(parsed, "name"),
					remote: getOptionalStringFlag(parsed, "remote"),
					worktreeCopyManifest: getOptionalStringFlag(
						parsed,
						"worktree-copy-manifest",
					),
				}),
			catch: (error) => error,
		});
		const storePath = yield* readyStoreEffect(parsed);
		return present(yield* addProjectEffect({ storePath, ...input }));
	});
}

function runProjectRootEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [id, root] = parsed.positionals.slice(projectRootArgumentsOffset);
		const input = yield* Effect.try({
			try: () => decodeProjectRootInput({ id, root }),
			catch: (error) => error,
		});
		const storePath = yield* readyStoreEffect(parsed);
		const operation =
			parsed.positionals[2] === "add"
				? addProjectRootEffect({ storePath, ...input })
				: removeProjectRootEffect({ storePath, ...input });
		return present(yield* operation);
	});
}

function runProjectRemoveEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [id] = parsed.positionals.slice(2);
		const storePath = yield* readyStoreEffect(parsed);
		const projectId = yield* parseProjectIdEffect(id, "id");
		yield* removeProjectEffect({ storePath, id: projectId });
		return present({ removed: projectId });
	});
}

function runProjectsEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		return present(yield* listProjectsEffect(storePath));
	});
}

function runHereEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* readyStoreEffect(parsed);
		const cwd = yield* parseAbsolutePathEffect(parsed.cwd, "cwd");
		const project = yield* inferProjectByPathEffect({ storePath, cwd });
		if (project === undefined) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "project-not-found",
					message:
						"No registered project matches the current directory. Run `forge project add <id> --root <path>`.",
				}),
			);
		}
		return present(project);
	});
}

function resolveStorePathEffect(
	parsed: Parsed,
): Effect.Effect<AbsolutePath, unknown, FileSystem> {
	return Effect.gen(function* () {
		if (parsed.storeOverride !== undefined) {
			return yield* parseAbsolutePathEffect(parsed.storeOverride, "storePath");
		}
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		return (yield* loadForgeConfigEffect({ homeDirectory })).storePath;
	});
}

function readyStoreEffect(
	parsed: Parsed,
): Effect.Effect<AbsolutePath, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* resolveStorePathEffect(parsed);
		yield* ensureStoreRootEffect({ storePath });
		return storePath;
	});
}

function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
	});
}

function parseProjectIdEffect(value: string | undefined, field: string) {
	return Effect.try({
		try: () => {
			if (value === undefined) {
				throw usage(`${field} is required.`);
			}
			return parseProjectId(value);
		},
		catch: (error) => error,
	});
}

function getOptionalStringFlag(
	parsed: Parsed,
	name: string,
): string | undefined {
	return stringFlag(parsed.flags[name]);
}

function stringFlag(value: FlagValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function usage(message: string): ForgeError {
	return new ForgeError({ kind: "config-invalid", message });
}
