import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import type { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";

import {
	parseAbsolutePath,
	parseWorktreeId,
	type AbsolutePath,
	type IsoDateTime,
	type WorktreeCopyManifestSnapshot,
	type WorktreeId,
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
	type WorktreeBinding,
} from "../record-domain.ts";
import {
	clearTaskWorktreeBindingEffect,
	readTaskWorktreeBindingEffect,
	readWorkflowRecordEffect,
	writeTaskWorktreeBindingEffect,
} from "../record-store.ts";
import { storeRootPaths } from "../store-paths.ts";
import {
	listWorktreeRecordsEffect,
	readWorktreeRecordEffect,
	writeWorktreeRecordEffect,
} from "../worktree-store.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
import type { CliCommandRegistration, CommandOutput, Parsed } from "./types.ts";

type CommandHandler = typeof buildCommandHandler;

const worktreeIdTimestampRadix = 36;
const worktreeIdRandomByteCount = 4;

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

export type WorktreeProblem = {
	readonly worktreeId: WorktreeId;
	readonly taskId: number;
	readonly code: string;
	readonly message: string;
};

export type WorktreeDoctorResult = {
	readonly ok: boolean;
	readonly worktrees: number;
	readonly problems: ReadonlyArray<WorktreeProblem>;
};

export type WorktreeInfoResult = {
	readonly worktree: WorktreeRecord;
	readonly problems: ReadonlyArray<WorktreeProblem>;
};

export type WorktreeCreateResult = {
	readonly worktree: WorktreeRecord;
	readonly binding: WorktreeBinding;
};

export type WorktreeRemoveResult = {
	readonly worktree: WorktreeRecord;
	readonly binding: null;
};

type PreparedCopyManifest = {
	readonly snapshot: WorktreeCopyManifestSnapshot;
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
			const copyManifest = optionalTextFlag(parsed, "copy-manifest");
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
			const copyManifests = yield* trySync(() =>
				readConfiguredCopyManifests({
					cwd: parsed.cwd,
					projectDefaultManifest: project.worktreeCopyManifest,
					explicitManifest: copyManifest,
				}),
			);
			const repositoryRoot = yield* trySync(() =>
				resolveRepositoryRoot(project.roots),
			);
			yield* trySync(() => validateBranchName(branch));
			const baseSha = yield* trySync(() =>
				resolveBaseSha(repositoryRoot, baseRef),
			);
			const existing = yield* validateExistingBindingEffect({
				storePath,
				taskId,
				branch,
				baseRef,
				requestedPath,
			});
			if (existing !== null) {
				return present(
					{
						worktree: existing,
						binding: { id: existing.id, status: "active" },
					},
					0,
					`Worktree ${existing.id} already active for task ${taskId}.`,
				);
			}
			const worktreeId = createWorktreeId(taskId);
			const worktreePath = yield* trySync(() =>
				resolveWorktreePath({
					storePath,
					projectId,
					worktreeId,
					requestedPath,
				}),
			);
			const now = new Date();
			const record = buildActiveWorktreeRecord({
				worktreeId,
				taskId,
				projectId,
				repositoryRoot,
				worktreePath,
				branch,
				baseRef,
				baseSha,
				now,
				copyManifests,
			});
			const created = yield* createManagedWorktreeEffect({
				storePath,
				record,
				copyManifests,
			});
			return present(created, 0, formatCreateMessage(taskId, created.worktree));
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
			const worktree = yield* readWorktreeRecordEffect({
				storePath,
				worktreeId: binding.id,
			});
			const problems = diagnoseWorktreeRecord(worktree);
			return present(
				{ worktree, problems },
				0,
				formatInfoMessage({ worktree, problems }),
			);
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
			const worktree = yield* readWorktreeRecordEffect({
				storePath,
				worktreeId: binding.id,
			});
			const removed = yield* removeManagedWorktreeEffect({
				storePath,
				taskId,
				worktree,
			});
			return present(
				removed,
				0,
				`Removed worktree ${removed.worktree.id} for task ${taskId}.`,
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
			const includeAll = parsed.flags.all === true;
			const worktrees = yield* listWorktreeRecordsEffect(storePath);
			return present({
				worktrees: includeAll
					? worktrees
					: worktrees.filter((worktree) => worktree.status === "active"),
			});
		});
	};
}

function createRunDoctorEffect() {
	return function runDoctorEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const pruneMissing = parsed.flags["prune-missing"] === true;
			const worktrees = yield* listWorktreeRecordsEffect(storePath);
			const problems = worktrees.flatMap(diagnoseWorktreeRecord);
			if (pruneMissing) {
				for (const worktree of worktrees) {
					if (
						worktree.status !== "active" ||
						fs.existsSync(worktree.worktreePath)
					) {
						continue;
					}
					const missing = markWorktreeMissing(worktree);
					yield* writeWorktreeRecordEffect({ storePath, record: missing });
					const binding = yield* readTaskWorktreeBindingEffect({
						storePath,
						taskId: worktree.taskId as RecordId,
					});
					if (binding?.id === worktree.id) {
						yield* clearTaskWorktreeBindingEffect({
							storePath,
							taskId: worktree.taskId as RecordId,
						});
					}
				}
			}
			return present({
				ok: problems.length === 0,
				worktrees: worktrees.length,
				problems,
			});
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

function readAllLineageRecordsEffect(
	storePath: AbsolutePath,
	taskId: RecordId,
) {
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
		fail(
			`Task ${task.id} is a ${task.subkind} Task; worktrees are only for ordinary implementation Tasks.`,
		);
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

function resolveRepositoryRoot(
	roots: ReadonlyArray<AbsolutePath>,
): AbsolutePath {
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
		message:
			"Registered project roots do not resolve to a local git repository.",
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
		return git(repositoryRoot, [
			"rev-parse",
			"--verify",
			`${baseRef}^{commit}`,
		]);
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
	readonly worktreeId: WorktreeId;
	readonly requestedPath?: string;
}): AbsolutePath {
	const worktreeRoot = path.join(
		storeRootPaths(options.storePath).worktrees,
		options.projectId,
	);
	const candidate =
		options.requestedPath ?? path.join(worktreeRoot, options.worktreeId);
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
	readonly requestedPath?: string;
}) {
	return Effect.gen(function* () {
		const binding = yield* readTaskWorktreeBindingEffect({
			storePath: options.storePath,
			taskId: options.taskId,
		});
		if (binding === null) {
			return null;
		}
		const record = yield* readWorktreeRecordEffect({
			storePath: options.storePath,
			worktreeId: binding.id,
		});
		const requestedPathMatches =
			options.requestedPath === undefined ||
			record.worktreePath ===
				parseAbsolutePath(options.requestedPath, "worktreePath");
		if (
			record.status === "active" &&
			record.taskId === options.taskId &&
			record.branch === options.branch &&
			record.baseRef === options.baseRef &&
			requestedPathMatches &&
			fs.existsSync(record.worktreePath)
		) {
			return record;
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

function readConfiguredCopyManifests(options: {
	readonly cwd: string;
	readonly projectDefaultManifest?: AbsolutePath;
	readonly explicitManifest?: string;
}): ReadonlyArray<PreparedCopyManifest> {
	const manifests: Array<PreparedCopyManifest> = [];
	if (options.projectDefaultManifest !== undefined) {
		manifests.push(readCopyManifestPath(options.projectDefaultManifest));
	}
	if (options.explicitManifest !== undefined) {
		manifests.push(
			readCopyManifestPath(path.resolve(options.cwd, options.explicitManifest)),
		);
	}
	return manifests;
}

function readCopyManifestPath(manifestPath: string): PreparedCopyManifest {
	const absoluteManifestPath = parseAbsolutePath(manifestPath, "copyManifest");
	let decoded: unknown;
	try {
		decoded = JSON.parse(fs.readFileSync(absoluteManifestPath, "utf8"));
	} catch (error) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Copy manifest '${absoluteManifestPath}' is not readable JSON.`,
			cause: error,
			details: { manifestPath: absoluteManifestPath },
		});
	}
	const entries = normalizeCopyManifestEntries(decoded);
	return { snapshot: { manifestPath: absoluteManifestPath, entries } };
}

function normalizeCopyManifestEntries(
	value: unknown,
): WorktreeCopyManifestSnapshot["entries"] {
	if (
		typeof value !== "object" ||
		value === null ||
		!("copy" in value) ||
		!Array.isArray((value as { readonly copy: unknown }).copy)
	) {
		throw new ForgeError({
			kind: "config-invalid",
			message: 'Copy manifest must be JSON shaped like { "copy": [...] }.',
		});
	}
	const entries = new Map<
		string,
		WorktreeCopyManifestSnapshot["entries"][number]
	>();
	for (const entry of (value as { readonly copy: ReadonlyArray<unknown> })
		.copy) {
		if (typeof entry !== "object" || entry === null) {
			throw new ForgeError({
				kind: "config-invalid",
				message: "Copy manifest entries must be objects.",
			});
		}
		const rawPath = (entry as { readonly path?: unknown }).path;
		if (typeof rawPath !== "string" || rawPath.length === 0) {
			throw new ForgeError({
				kind: "config-invalid",
				message: "Copy manifest entry path must be a non-empty string.",
			});
		}
		validateCopyManifestPath(rawPath);
		entries.set(rawPath, {
			path: rawPath,
			optional: (entry as { readonly optional?: unknown }).optional === true,
		});
	}
	return [...entries.values()];
}

function validateCopyManifestPath(copyPath: string): void {
	const segments = copyPath.split(/[\\/]/u);
	if (
		path.isAbsolute(copyPath) ||
		segments.includes("..") ||
		segments.includes("") ||
		copyPath.endsWith("/") ||
		/[?*[\]]/u.test(copyPath)
	) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Copy manifest path '${copyPath}' is unsafe.`,
			details: { path: copyPath },
		});
	}
}

function applyCopyManifests(
	record: WorktreeRecord,
	manifests: ReadonlyArray<PreparedCopyManifest>,
): ReadonlyArray<string> {
	const copied: Array<string> = [];
	for (const entry of mergeCopyManifestEntries(manifests)) {
		const source = path.join(record.repositoryRoot, entry.path);
		const destination = path.join(record.worktreePath, entry.path);
		if (!fs.existsSync(source)) {
			if (entry.optional) {
				continue;
			}
			throw new ForgeError({
				kind: "config-invalid",
				message: `Required copy source '${entry.path}' does not exist.`,
				details: { path: entry.path, source },
			});
		}
		if (fs.statSync(source).isDirectory()) {
			throw new ForgeError({
				kind: "config-invalid",
				message: `Copy manifest path '${entry.path}' points to a directory; directories are not supported.`,
				details: { path: entry.path, source },
			});
		}
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(source, destination);
		copied.push(entry.path);
	}
	return copied;
}

function mergeCopyManifestEntries(
	manifests: ReadonlyArray<PreparedCopyManifest>,
): WorktreeCopyManifestSnapshot["entries"] {
	const entries = new Map<
		string,
		WorktreeCopyManifestSnapshot["entries"][number]
	>();
	for (const manifest of manifests) {
		for (const entry of manifest.snapshot.entries) {
			entries.set(entry.path, entry);
		}
	}
	return [...entries.values()];
}

function formatCreateMessage(taskId: RecordId, record: WorktreeRecord): string {
	return [
		`Created worktree ${record.id} for task ${taskId}.`,
		...record.copiedPaths.map((copiedPath) => `Copied ${copiedPath}.`),
	].join("\n");
}

function formatInfoMessage(result: WorktreeInfoResult): string {
	return [
		`${result.worktree.id}\t${result.worktree.status}\ttask:${result.worktree.taskId}\t${result.worktree.branch}\t${result.worktree.worktreePath}`,
		...result.problems.map(
			(problem) => `problem:${problem.code}\t${problem.message}`,
		),
	].join("\n");
}

function diagnoseWorktreeRecord(
	record: WorktreeRecord,
): ReadonlyArray<WorktreeProblem> {
	const problems: Array<WorktreeProblem> = [];
	if (record.status === "active" && !fs.existsSync(record.worktreePath)) {
		problems.push({
			worktreeId: record.id,
			taskId: record.taskId,
			code: "worktree-path-missing",
			message: `Active worktree path '${record.worktreePath}' is missing.`,
		});
		return problems;
	}
	if (record.status === "active") {
		try {
			const inside = git(record.worktreePath, [
				"rev-parse",
				"--is-inside-work-tree",
			]);
			if (inside !== "true") {
				problems.push({
					worktreeId: record.id,
					taskId: record.taskId,
					code: "worktree-git-invalid",
					message: `Active worktree path '${record.worktreePath}' is not a git worktree.`,
				});
			}
		} catch {
			problems.push({
				worktreeId: record.id,
				taskId: record.taskId,
				code: "worktree-git-invalid",
				message: `Active worktree path '${record.worktreePath}' is not a valid git worktree.`,
			});
		}
	}
	return problems;
}

function createManagedWorktreeEffect(options: {
	readonly storePath: AbsolutePath;
	readonly record: WorktreeRecord;
	readonly copyManifests: ReadonlyArray<PreparedCopyManifest>;
}): Effect.Effect<WorktreeCreateResult, unknown, FileSystem> {
	return Effect.gen(function* () {
		const binding: WorktreeBinding = {
			id: options.record.id,
			status: "active",
		};
		yield* trySync(() => createGitWorktree(options.record));
		const record = yield* trySync(() => ({
			...options.record,
			copiedPaths: applyCopyManifests(options.record, options.copyManifests),
		})).pipe(
			Effect.catchAll((error) =>
				rollbackCreateFailureEffect({
					storePath: options.storePath,
					record: options.record,
					cause: error,
				}),
			),
		);
		const persisted = yield* writeWorktreeRecordEffect({
			storePath: options.storePath,
			record,
		}).pipe(
			Effect.catchAll((error) =>
				rollbackCreateFailureEffect({
					storePath: options.storePath,
					record,
					cause: error,
				}),
			),
		);
		yield* writeTaskWorktreeBindingEffect({
			storePath: options.storePath,
			taskId: options.record.taskId as RecordId,
			binding,
		}).pipe(
			Effect.catchAll((error) =>
				rollbackCreateFailureEffect({
					storePath: options.storePath,
					record,
					cause: error,
				}),
			),
		);
		return { worktree: persisted, binding };
	});
}

function rollbackCreateFailureEffect(options: {
	readonly storePath: AbsolutePath;
	readonly record: WorktreeRecord;
	readonly cause: unknown;
}): Effect.Effect<never, unknown, FileSystem> {
	return Effect.gen(function* () {
		const removed = tryRemoveGitWorktree(options.record);
		yield* clearTaskWorktreeBindingEffect({
			storePath: options.storePath,
			taskId: options.record.taskId as RecordId,
		}).pipe(Effect.catchAll(() => Effect.void));
		if (!removed) {
			const invalid = markWorktreeInvalid(
				options.record,
				"create-rollback-failed",
				"Worktree create failed and Forge could not fully roll back the git worktree. Remove or repair it manually, then retry.",
				options.cause,
			);
			yield* writeWorktreeRecordEffect({
				storePath: options.storePath,
				record: invalid,
			}).pipe(Effect.catchAll(() => Effect.void));
		}
		return yield* Effect.fail(options.cause);
	});
}

function createGitWorktree(record: WorktreeRecord): void {
	fs.mkdirSync(path.dirname(record.worktreePath), { recursive: true });
	try {
		execFileSync(
			"git",
			[
				"worktree",
				"add",
				"-b",
				record.branch,
				record.worktreePath,
				record.baseSha,
			],
			{
				cwd: record.repositoryRoot,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Failed to create git worktree '${record.worktreePath}' for branch '${record.branch}'.`,
			cause: error,
			details: {
				repositoryRoot: record.repositoryRoot,
				worktreePath: record.worktreePath,
				branch: record.branch,
			},
		});
	}
}

function removeManagedWorktreeEffect(options: {
	readonly storePath: AbsolutePath;
	readonly taskId: RecordId;
	readonly worktree: WorktreeRecord;
}): Effect.Effect<WorktreeRemoveResult, unknown, FileSystem> {
	return Effect.gen(function* () {
		yield* trySync(() =>
			validateRemovableWorktree(options.taskId, options.worktree),
		);
		yield* trySync(() => removeCleanGitWorktree(options.worktree));
		const removed = yield* writeWorktreeRecordEffect({
			storePath: options.storePath,
			record: markWorktreeRemoved(options.worktree),
		});
		const binding = yield* readTaskWorktreeBindingEffect({
			storePath: options.storePath,
			taskId: options.taskId,
		});
		if (binding?.id === options.worktree.id) {
			yield* clearTaskWorktreeBindingEffect({
				storePath: options.storePath,
				taskId: options.taskId,
			});
		}
		return { worktree: removed, binding: null };
	});
}

function validateRemovableWorktree(
	taskId: RecordId,
	record: WorktreeRecord,
): void {
	if (record.status !== "active") {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Worktree ${record.id} is ${record.status}, not active.`,
			details: { worktreeId: record.id, status: record.status },
		});
	}
	if (record.taskId !== taskId) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Worktree ${record.id} belongs to task ${record.taskId}, not task ${taskId}.`,
			details: { worktreeId: record.id, taskId, recordTaskId: record.taskId },
		});
	}
	if (!fs.existsSync(record.worktreePath)) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Active worktree path '${record.worktreePath}' is missing. Run forge worktree doctor --prune-missing to clear missing bindings.`,
			details: { worktreeId: record.id, worktreePath: record.worktreePath },
		});
	}
	assertGitWorktreeClean(record);
}

function assertGitWorktreeClean(record: WorktreeRecord): void {
	let status: string;
	try {
		status = git(record.worktreePath, [
			"status",
			"--porcelain",
			"--untracked-files=all",
		]);
	} catch (error) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Active worktree path '${record.worktreePath}' is not a valid git worktree.`,
			cause: error,
			details: { worktreeId: record.id, worktreePath: record.worktreePath },
		});
	}
	if (status.length > 0) {
		throw new ForgeError({
			kind: "record-invalid",
			message: `Worktree ${record.id} has uncommitted changes; refusing to remove dirty worktree.`,
			details: {
				worktreeId: record.id,
				worktreePath: record.worktreePath,
				status,
			},
		});
	}
}

function removeCleanGitWorktree(record: WorktreeRecord): void {
	try {
		execFileSync("git", ["worktree", "remove", record.worktreePath], {
			cwd: record.repositoryRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw new ForgeError({
			kind: "config-invalid",
			message: `Failed to remove git worktree '${record.worktreePath}'.`,
			cause: error,
			details: {
				repositoryRoot: record.repositoryRoot,
				worktreePath: record.worktreePath,
			},
		});
	}
}

function tryRemoveGitWorktree(record: WorktreeRecord): boolean {
	try {
		if (!fs.existsSync(record.worktreePath)) {
			return true;
		}
		execFileSync(
			"git",
			["worktree", "remove", "--force", record.worktreePath],
			{
				cwd: record.repositoryRoot,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		return true;
	} catch {
		return false;
	}
}

function buildActiveWorktreeRecord(options: {
	readonly worktreeId: WorktreeId;
	readonly taskId: RecordId;
	readonly projectId: WorktreeRecord["projectId"];
	readonly repositoryRoot: AbsolutePath;
	readonly worktreePath: AbsolutePath;
	readonly branch: string;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly now: Date;
	readonly copyManifests?: ReadonlyArray<PreparedCopyManifest>;
}): WorktreeRecord {
	const timestamp = iso(options.now);
	return {
		id: options.worktreeId,
		taskId: options.taskId,
		projectId: options.projectId,
		repositoryRoot: options.repositoryRoot,
		worktreePath: options.worktreePath,
		branch: options.branch,
		baseRef: options.baseRef,
		baseSha: options.baseSha,
		status: "active",
		copyManifests:
			options.copyManifests?.map((manifest) => manifest.snapshot) ?? [],
		copiedPaths: [],
		diagnostics: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function markWorktreeInvalid(
	record: WorktreeRecord,
	code: string,
	message: string,
	cause: unknown,
): WorktreeRecord {
	return {
		...record,
		status: "invalid",
		diagnostics: [
			...record.diagnostics,
			{
				code,
				message,
				details: { cause: formatDiagnosticCause(cause) },
			},
		],
		updatedAt: iso(new Date()),
	};
}

function markWorktreeMissing(record: WorktreeRecord): WorktreeRecord {
	return {
		...record,
		status: "missing",
		diagnostics: [
			...record.diagnostics,
			{
				code: "worktree-path-missing",
				message: `Active worktree path '${record.worktreePath}' was missing during prune.`,
			},
		],
		updatedAt: iso(new Date()),
	};
}

function markWorktreeRemoved(record: WorktreeRecord): WorktreeRecord {
	return {
		...record,
		status: "removed",
		updatedAt: iso(new Date()),
	};
}

function createWorktreeId(taskId: RecordId): WorktreeId {
	return parseWorktreeId(
		`wt_task_${taskId}_${Date.now().toString(worktreeIdTimestampRadix)}_${crypto.randomBytes(worktreeIdRandomByteCount).toString("hex")}`,
	);
}

function iso(date: Date): IsoDateTime {
	return date.toISOString() as IsoDateTime;
}

function formatDiagnosticCause(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
}

function pathIsInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
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
