import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";

import {
	parseAbsolutePath,
	type AbsolutePath,
	type WorktreeRecord,
} from "../domain.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
} from "../filesystem-store.ts";
import { parseRecordId, type RecordId } from "../record-domain.ts";
import { readTaskWorktreeBindingEffect } from "../record-store.ts";
import { listWorktreeRecordsEffect } from "../worktree-store.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
import type { CliCommandRegistration, CommandOutput, Parsed } from "./types.ts";

type CommandHandler = typeof buildCommandHandler;

const taskArg = Args.text({ name: "task" });
const presentationOptions = {
	json: Options.boolean("json").pipe(
		Options.withDescription("Render command output as JSON."),
	),
};

export type WorktreeNoBindingResult = {
	readonly task: RecordId;
	readonly binding: null;
	readonly message: string;
};

export type WorktreeListResult = {
	readonly worktrees: ReadonlyArray<WorktreeRecord>;
};

export type WorktreeDoctorResult = {
	readonly ok: boolean;
	readonly worktrees: number;
	readonly problems: ReadonlyArray<never>;
};

export function createWorktreeCommands(
	commandHandler: CommandHandler = buildCommandHandler,
) {
	const runCreateEffect = createRunCreateEffect();
	const runInfoEffect = createRunInfoEffect();
	const runRemoveEffect = createRunRemoveEffect();
	const runListEffect = createRunListEffect();
	const runDoctorEffect = createRunDoctorEffect();

	const createCommand = CliCommand.make("create", {
		task: taskArg,
		branch: Options.text("branch"),
		base: Options.text("base"),
		path: Options.text("path").pipe(Options.optional),
		copyManifest: Options.text("copy-manifest").pipe(Options.optional),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["worktree", "create"], runCreateEffect, ["task"]),
		),
		CliCommand.withDescription("Create a managed Forge git worktree."),
	);

	const infoCommand = CliCommand.make("info", {
		task: taskArg,
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["worktree", "info"], runInfoEffect, ["task"]),
		),
		CliCommand.withDescription("Show a Task's active worktree binding."),
	);

	const removeCommand = CliCommand.make("remove", {
		task: taskArg,
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["worktree", "remove"], runRemoveEffect, ["task"]),
		),
		CliCommand.withDescription("Remove a managed Forge git worktree."),
	);

	const listCommand = CliCommand.make("list", {
		all: Options.boolean("all").pipe(
			Options.withDescription("Include historical managed worktrees."),
		),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(commandHandler(["worktree", "list"], runListEffect)),
		CliCommand.withDescription("List managed Forge worktrees."),
	);

	const doctorCommand = CliCommand.make("doctor", {
		pruneMissing: Options.boolean("prune-missing").pipe(
			Options.withDescription(
				"Mark missing active worktrees missing and clear bindings.",
			),
		),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["worktree", "doctor"], runDoctorEffect),
		),
		CliCommand.withDescription("Diagnose managed Forge worktrees."),
	);

	const worktreeCommand = CliCommand.make("worktree").pipe(
		CliCommand.withDescription("Manage Forge-owned local git worktrees."),
		CliCommand.withSubcommands([
			createCommand,
			infoCommand,
			removeCommand,
			listCommand,
			doctorCommand,
		]),
	);

	return {
		worktreeCommand,
		createCommand,
		infoCommand,
		removeCommand,
		listCommand,
		doctorCommand,
		registrations: [
			{ path: ["worktree"], descriptor: worktreeCommand },
			{ path: ["worktree", "create"], descriptor: createCommand },
			{ path: ["worktree", "info"], descriptor: infoCommand },
			{ path: ["worktree", "remove"], descriptor: removeCommand },
			{ path: ["worktree", "list"], descriptor: listCommand },
			{ path: ["worktree", "doctor"], descriptor: doctorCommand },
		] satisfies ReadonlyArray<CliCommandRegistration>,
	};
}

function createRunCreateEffect() {
	return function runCreateEffect(
		_parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.fail(
			new ForgeError({
				kind: "config-invalid",
				message:
					"forge worktree create is registered but creation is not implemented yet.",
			}),
		);
	};
}

function createRunInfoEffect() {
	return function runInfoEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const taskId = parseTaskId(parsed);
			const binding = yield* readTaskWorktreeBindingEffect({
				storePath,
				taskId,
			});
			if (binding === null) {
				return present(
					noActiveBinding(taskId),
					0,
					noActiveBinding(taskId).message,
				);
			}
			return present(binding, 0, `${taskId}\t${binding.id}\t${binding.status}`);
		});
	};
}

function createRunRemoveEffect() {
	return function runRemoveEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const taskId = parseTaskId(parsed);
			const binding = yield* readTaskWorktreeBindingEffect({
				storePath,
				taskId,
			});
			if (binding === null) {
				return present(
					noActiveBinding(taskId),
					0,
					noActiveBinding(taskId).message,
				);
			}
			return yield* Effect.fail(
				new ForgeError({
					kind: "config-invalid",
					message:
						"forge worktree remove is registered but removal is not implemented yet.",
				}),
			);
		});
	};
}

function createRunListEffect() {
	return function runListEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const worktrees = yield* listWorktreeRecordsEffect(storePath);
			return present({ worktrees });
		});
	};
}

function createRunDoctorEffect() {
	return function runDoctorEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const worktrees = yield* listWorktreeRecordsEffect(storePath);
			return present({ ok: true, worktrees: worktrees.length, problems: [] });
		});
	};
}

function parseTaskId(parsed: Parsed): RecordId {
	const value = parsed.positionals.at(-1);
	if (value === undefined) {
		throw new ForgeError({
			kind: "config-invalid",
			message: "Missing task id.",
		});
	}
	return parseRecordId(Number(value));
}

function noActiveBinding(task: RecordId): WorktreeNoBindingResult {
	return {
		task,
		binding: null,
		message: `Task ${task} has no active worktree binding.`,
	};
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
		const config = yield* loadForgeConfigEffect({ homeDirectory });
		return config.storePath;
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
