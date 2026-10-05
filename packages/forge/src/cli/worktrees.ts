import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
import { readProjectEffect } from "../project-registry.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
} from "../filesystem-store.ts";
import {
	diagnoseRecordReadiness,
	parseRecordId,
	type RecordId,
	type WorkflowRecord,
} from "../record-domain.ts";
import {
	readTaskWorktreeBindingEffect,
	readWorkflowRecordEffect,
} from "../record-store.ts";
import { storeRootPaths } from "../store-paths.ts";
import {
	listWorktreeRecordsEffect,
	readWorktreeRecordEffect,
} from "../worktree-store.ts";
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

export type WorktreeCreateValidationResult = {
	readonly task: RecordId;
	readonly project: string;
	readonly repositoryRoot: AbsolutePath;
	readonly branch: string;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly worktreePath: AbsolutePath;
	readonly validated: true;
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
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const taskId = parseTaskId(parsed);
			const branch = requireTextFlag(parsed, "branch");
			const baseRef = requireTextFlag(parsed, "base");
			const requestedPath = optionalTextFlag(parsed, "path");
			const records = yield* Effect.all([
				readWorkflowRecordEffect(storePath, taskId),
				readAllLineageRecordsEffect(storePath, taskId),
			]);
			const [task, lineage] = records;
			yield* trySync(() => validateEligibleTask(task, lineage));
			if (task.scope.type !== "project") {
				return yield* Effect.fail(
					new ForgeError({
						kind: "record-invalid",
						message: `Task ${task.id} must have project scope to create a worktree.`,
					}),
				);
			}
			const projectId = task.scope.project;
			const project = yield* readProjectEffect(storePath, projectId);
			const repositoryRoot = yield* trySync(() =>
				resolveRepositoryRoot(project.roots),
			);
			yield* trySync(() => validateBranchName(branch));
			const baseSha = yield* trySync(() => resolveBaseSha(repositoryRoot, baseRef));
			const worktreePath = yield* trySync(() => resolveWorktreePath({
				storePath,
				projectId,
				taskId,
				requestedPath,
			}));
			yield* validateExistingBindingEffect({
				storePath,
				taskId,
				branch,
				baseRef,
				worktreePath,
			});
			const result: WorktreeCreateValidationResult = {
				task: taskId,
				project: projectId,
				repositoryRoot,
				branch,
				baseRef,
				baseSha,
				worktreePath,
				validated: true,
			};
			return present(
				result,
				0,
				`Worktree create validation passed for task ${taskId}.`,
			);
		});
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

function requireTextFlag(parsed: Parsed, name: string): string {
	const value = parsed.flags[name];
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	throw new ForgeError({
		kind: "config-invalid",
		message: `Missing required --${name} value.`,
	});
}

function optionalTextFlag(parsed: Parsed, name: string): string | undefined {
	const value = parsed.flags[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAllLineageRecordsEffect(storePath: AbsolutePath, taskId: RecordId) {
	return Effect.gen(function* () {
		const lineage: Array<WorkflowRecord> = [];
		let current = yield* readWorkflowRecordEffect(storePath, taskId);
		lineage.push(current);
		while (current.parent !== null) {
			current = yield* readWorkflowRecordEffect(storePath, current.parent);
			lineage.push(current);
		}
		return lineage;
	});
}

function validateEligibleTask(
	task: WorkflowRecord,
	lineage: ReadonlyArray<WorkflowRecord>,
): void {
	const records = [...lineage];
	const specAncestor = lineage.find((candidate) => candidate.kind === "spec");
	const readiness = diagnoseRecordReadiness(task, records);
	const fail = (message: string) => {
		throw new ForgeError({
			kind: "record-invalid",
			message,
			details: { recordId: task.id },
		});
	};
	if (task.kind !== "task") {
		fail(`Record ${task.id} is a ${task.kind}, not an ordinary Task.`);
	}
	if (task.subkind !== null) {
		fail(`Task ${task.id} is a ${task.subkind} Task; worktrees are only for ordinary implementation Tasks.`);
	}
	if (task.state === "done") {
		fail(`Task ${task.id} is done and cannot receive a worktree.`);
	}
	if (task.parent === null || specAncestor === undefined) {
		fail(`Task ${task.id} is not under a Spec lineage.`);
	}
	if (lineage.some((candidate) => candidate.kind === "wayfinder")) {
		fail(`Task ${task.id} is under a Wayfinder, not a Spec.`);
	}
	if (!readiness.ready) {
		fail(
			`Task ${task.id} is not executable: ${readiness.reasons.map((reason) => reason.message).join(" ")}`,
		);
	}
}

function resolveRepositoryRoot(roots: ReadonlyArray<AbsolutePath>): AbsolutePath {
	for (const root of roots) {
		if (!fs.existsSync(root)) {
			continue;
		}
		try {
			const resolved = git(root, ["rev-parse", "--show-toplevel"]);
			return parseAbsolutePath(resolved, "repositoryRoot");
		} catch {
			// Try the next registered root.
		}
	}
	throw new ForgeError({
		kind: "project-invalid",
		message: "Registered project roots do not resolve to a local git repository.",
		details: { roots },
	});
}

function validateBranchName(branch: string): void {
	try {
		execFileSync("git", ["check-ref-format", "--branch", branch], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Invalid git branch name '${branch}'.`,
			cause: error,
			details: { branch },
		});
	}
}

function resolveBaseSha(repositoryRoot: AbsolutePath, baseRef: string): string {
	try {
		return git(repositoryRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
	} catch (error) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Base ref '${baseRef}' does not resolve to a local commit.`,
			cause: error,
			details: { baseRef, repositoryRoot },
		});
	}
}

function resolveWorktreePath(options: {
	readonly storePath: AbsolutePath;
	readonly projectId: string;
	readonly taskId: RecordId;
	readonly requestedPath?: string;
}): AbsolutePath {
	const worktreeRoot = path.join(
		storeRootPaths(options.storePath).worktrees,
		options.projectId,
	);
	const candidate = options.requestedPath ?? path.join(worktreeRoot, String(options.taskId));
	const absolute = parseAbsolutePath(candidate, "worktreePath");
	if (!pathIsInside(absolute, worktreeRoot)) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Worktree path must be inside Forge worktree root '${worktreeRoot}'.`,
			details: { worktreePath: absolute, worktreeRoot },
		});
	}
	return absolute;
}

function validateExistingBindingEffect(options: {
	readonly storePath: AbsolutePath;
	readonly taskId: RecordId;
	readonly branch: string;
	readonly baseRef: string;
	readonly worktreePath: AbsolutePath;
}) {
	return Effect.gen(function* () {
		const binding = yield* readTaskWorktreeBindingEffect({
			storePath: options.storePath,
			taskId: options.taskId,
		});
		if (binding === null) {
			return;
		}
		const record = yield* readWorktreeRecordEffect({
			storePath: options.storePath,
			worktreeId: binding.id,
		});
		if (
			record.status === "active" &&
			record.taskId === options.taskId &&
			record.branch === options.branch &&
			record.baseRef === options.baseRef &&
			record.worktreePath === options.worktreePath &&
			fs.existsSync(record.worktreePath)
		) {
			return;
		}
		return yield* Effect.fail(
			new ForgeError({
				kind: "record-invalid",
				message: `Task ${options.taskId} already has an active worktree binding '${binding.id}'.`,
				details: { taskId: options.taskId, worktreeId: binding.id },
			}),
		);
	});
}

function pathIsInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
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

function trySync<A>(thunk: () => A): Effect.Effect<A, unknown, never> {
	return Effect.try({ try: thunk, catch: (error) => error });
}
