import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import type { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";
import type { CommandOutput, Parsed } from "./types.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
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
	addInitiativeDeclaredProjectEffect,
	attachWorkflowRecordToInitiativeEffect,
	detachWorkflowRecordFromInitiativeEffect,
	listWorkflowRecordsEffect,
	removeInitiativeDeclaredProjectEffect,
} from "../record-store.ts";
import { parseRecordId, type WorkflowRecord } from "../record-domain.ts";
import { inferProjectByPathEffect } from "../project-registry.ts";

type CommandHandler = typeof buildCommandHandler;
const projectPathPositionCount = 3;

export function createInitiativesCommands(
	commandHandler: CommandHandler = buildCommandHandler,
) {
	const initiativesCommand = CliCommand.make("initiatives", {
		project: Options.text("project").pipe(Options.optional),
		allRecords: Options.boolean("all-records"),
		json: Options.boolean("json"),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["initiatives"], runInitiativesEffect),
		),
		CliCommand.withDescription("List initiative records."),
	);
	const initiativeAttachCommand = CliCommand.make("attach", {
		initiative: Args.text({ name: "initiative" }),
		record: Args.text({ name: "record" }),
		json: Options.boolean("json"),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["initiative", "attach"], runInitiativeEffect, [
				"initiative",
				"record",
			]),
		),
		CliCommand.withDescription("Attach a record to an initiative."),
	);
	const initiativeDetachCommand = CliCommand.make("detach", {
		initiative: Args.text({ name: "initiative" }),
		record: Args.text({ name: "record" }),
		json: Options.boolean("json"),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["initiative", "detach"], runInitiativeEffect, [
				"initiative",
				"record",
			]),
		),
		CliCommand.withDescription("Detach a record from an initiative."),
	);
	const initiativeProjectAddCommand = CliCommand.make("add", {
		initiative: Args.text({ name: "initiative" }),
		project: Args.text({ name: "project" }),
		json: Options.boolean("json"),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["initiative", "project", "add"], runInitiativeEffect, [
				"initiative",
				"project",
			]),
		),
		CliCommand.withDescription("Add a declared project to an initiative."),
	);
	const initiativeProjectRemoveCommand = CliCommand.make("remove", {
		initiative: Args.text({ name: "initiative" }),
		project: Args.text({ name: "project" }),
		json: Options.boolean("json"),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["initiative", "project", "remove"], runInitiativeEffect, [
				"initiative",
				"project",
			]),
		),
		CliCommand.withDescription("Remove a declared project from an initiative."),
	);
	const initiativeProjectCommand = CliCommand.make("project").pipe(
		CliCommand.withHandler(
			commandHandler(["initiative", "project"], runInitiativeEffect),
		),
		CliCommand.withDescription("Maintain initiative project declarations."),
		CliCommand.withSubcommands([
			initiativeProjectAddCommand,
			initiativeProjectRemoveCommand,
		]),
	);
	const initiativeCommand = CliCommand.make("initiative").pipe(
		CliCommand.withHandler(commandHandler(["initiative"], runInitiativeEffect)),
		CliCommand.withDescription("Maintain initiative membership."),
		CliCommand.withSubcommands([
			initiativeAttachCommand,
			initiativeDetachCommand,
			initiativeProjectCommand,
		]),
	);
	return {
		initiativesCommand,
		initiativeCommand,
		registrations: [
			{ path: ["initiatives"], descriptor: initiativesCommand },
			{ path: ["initiative"], descriptor: initiativeCommand },
			{ path: ["initiative", "attach"], descriptor: initiativeAttachCommand },
			{ path: ["initiative", "detach"], descriptor: initiativeDetachCommand },
			{ path: ["initiative", "project"], descriptor: initiativeProjectCommand },
			{
				path: ["initiative", "project", "add"],
				descriptor: initiativeProjectAddCommand,
			},
			{
				path: ["initiative", "project", "remove"],
				descriptor: initiativeProjectRemoveCommand,
			},
		],
	};

	function runInitiativesEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const records = yield* listWorkflowRecordsEffect(storePath);
			const explicitProject = stringFlag(parsed.flags.project);
			const project =
				explicitProject ??
				(parsed.flags["all-records"] !== true
					? yield* inferProjectIdForCwdEffect(parsed, storePath)
					: undefined);
			return present(
				records.filter(
					(record) =>
						record.kind === "initiative" &&
						(project === undefined ||
							recordHasProject(record, records, project)),
				),
			);
		});
	}

	function runInitiativeEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			const memberPath = parsed.positionals.slice(0, 2).join(" ");
			const projectPath = parsed.positionals
				.slice(0, projectPathPositionCount)
				.join(" ");
			if (
				memberPath === "initiative attach" ||
				memberPath === "initiative detach"
			) {
				const initiativeId = yield* recordIdFromTextEffect(
					parsed.positionals[2],
				);
				const recordId = yield* recordIdFromTextEffect(parsed.positionals[3]);
				return present(
					memberPath === "initiative attach"
						? yield* attachWorkflowRecordToInitiativeEffect({
								storePath,
								initiativeId,
								recordId,
							})
						: yield* detachWorkflowRecordFromInitiativeEffect({
								storePath,
								initiativeId,
								recordId,
							}),
				);
			}
			if (
				projectPath === "initiative project add" ||
				projectPath === "initiative project remove"
			) {
				const initiativeId = yield* recordIdFromTextEffect(
					parsed.positionals[3],
				);
				const project = yield* parseProjectIdEffect(parsed.positionals[4]);
				return present(
					projectPath === "initiative project add"
						? yield* addInitiativeDeclaredProjectEffect({
								storePath,
								initiativeId,
								project,
							})
						: yield* removeInitiativeDeclaredProjectEffect({
								storePath,
								initiativeId,
								project,
							}),
				);
			}
			return yield* Effect.fail(
				usage("Usage: forge initiative <attach|detach|project>"),
			);
		});
	}
}

export type InitiativesCommands = ReturnType<typeof createInitiativesCommands>;

function readyStoreEffect(
	parsed: Parsed,
): Effect.Effect<AbsolutePath, unknown, FileSystem> {
	return Effect.gen(function* () {
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		const storePath =
			parsed.storeOverride === undefined
				? (yield* loadForgeConfigEffect({ homeDirectory })).storePath
				: yield* parseAbsolutePathEffect(parsed.storeOverride, "storePath");
		yield* ensureStoreRootEffect({ storePath });
		return storePath;
	});
}
function inferProjectIdForCwdEffect(
	parsed: Parsed,
	storePath: AbsolutePath,
): Effect.Effect<string | undefined, unknown, FileSystem> {
	return Effect.gen(function* () {
		const cwd = yield* parseAbsolutePathEffect(parsed.cwd, "cwd");
		return (yield* inferProjectByPathEffect({ storePath, cwd }))?.id;
	});
}
function recordHasProject(
	record: WorkflowRecord,
	records: ReadonlyArray<WorkflowRecord>,
	project: string,
): boolean {
	const projectId = parseProjectId(project);
	if (record.scope.type === "project") {
		return record.scope.project === projectId;
	}
	if (record.scope.type === "project-set") {
		return record.scope.projects.includes(projectId);
	}
	const initiativeId =
		record.scope.type === "initiative"
			? record.scope.initiative
			: record.initiative;
	if (initiativeId === null) {
		return false;
	}
	const initiative = records.find((candidate) => candidate.id === initiativeId);
	return (
		initiative?.scope.type === "project-set" &&
		initiative.scope.projects.includes(projectId)
	);
}
function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
	});
}
function parseProjectIdEffect(value: string | undefined) {
	return Effect.try({
		try: () => parseProjectId(value as string),
		catch: (error) => error,
	});
}
function recordIdFromTextEffect(value: string | undefined) {
	return Effect.try({
		try: () => parseRecordId(Number(value)),
		catch: (error) => error,
	});
}
function stringFlag(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function usage(message: string): ForgeError {
	return new ForgeError({ kind: "config-invalid", message });
}
