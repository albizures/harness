import * as PlatformCommand from "@effect/platform/Command";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { FileSystem } from "@effect/platform/FileSystem";
import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { Effect } from "effect";
import {
	fallbackEditor,
	readNodeStreamTextEffect,
	uniqueNodeProcessSuffix,
} from "../cli-node.ts";
import type { CommandOutput, Parsed } from "./types.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
import { parseAbsolutePath, type AbsolutePath } from "../domain.ts";
import { parseRecordId } from "../record-domain.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
	readTextFileEffect,
} from "../filesystem-store.ts";
import {
	addRecordCommentEffect,
	formatRecordCommentMarkdown,
	listRecordCommentsEffect,
	listRecordHistoryEffect,
	listRecordUpdatesEffect,
	replaceRecordCommentFromEditedMarkdownEffect,
} from "../record-store.ts";
import type {
	CommentId,
	RecordComment,
	RecordHistoryEntry,
	RecordId,
	RecordUpdate,
} from "../record-domain.ts";

type CommandHandler = typeof buildCommandHandler;

export function createCommentsCommands(
	commandHandler: CommandHandler = buildCommandHandler,
	help: (command: string) => string = (command) => `Usage: forge ${command}`,
) {
	const recordArg = Args.text({ name: "record" });
	const commentEditCommand = CliCommand.make("edit", {
		record: recordArg,
		comment: Args.text({ name: "comment" }),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["comment", "edit"], runCommentEffect, [
				"record",
				"comment",
			]),
		),
		CliCommand.withDescription("Edit a record comment."),
	);
	const commentCommand = CliCommand.make("comment", {
		record: Args.optional(recordArg),
		message: Options.text("message").pipe(Options.optional),
		messageFile: Options.text("message-file").pipe(Options.optional),
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["comment"], runCommentEffect, ["record"]),
		),
		CliCommand.withDescription("Add or edit record comments."),
		CliCommand.withSubcommands([commentEditCommand]),
	);
	const commentsCommand = CliCommand.make("comments", {
		record: recordArg,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["comments"], runCommentsEffect, ["record"]),
		),
		CliCommand.withDescription("List record comments."),
	);
	const updatesCommand = CliCommand.make("updates", { record: recordArg }).pipe(
		CliCommand.withHandler(
			commandHandler(["updates"], runUpdatesEffect, ["record"]),
		),
		CliCommand.withDescription("List record updates."),
	);
	const historyCommand = CliCommand.make("history", { record: recordArg }).pipe(
		CliCommand.withHandler(
			commandHandler(["history"], runHistoryEffect, ["record"]),
		),
		CliCommand.withDescription("List record history."),
	);
	return {
		commentCommand,
		commentsCommand,
		updatesCommand,
		historyCommand,
		registrations: [
			{ path: ["comment"], descriptor: commentCommand },
			{ path: ["comment", "edit"], descriptor: commentEditCommand },
			{ path: ["comments"], descriptor: commentsCommand },
			{ path: ["updates"], descriptor: updatesCommand },
			{ path: ["history"], descriptor: historyCommand },
		],
	};

	function runCommentEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, CommandExecutor | FileSystem> {
		return Effect.gen(function* () {
			const storePath = yield* readyStoreEffect(parsed);
			if (parsed.positionals[1] === "edit") {
				const [record, comment, ...tail] = parsed.positionals.slice(2);
				if (record === undefined || comment === undefined || tail.length > 0) {
					return yield* Effect.fail(usage(help("comment")));
				}
				const recordId = yield* recordIdFromTextEffect(record);
				const commentId = yield* parseCommentIdEffect(comment);
				const existing = yield* findRecordCommentEffect(
					storePath,
					recordId,
					commentId,
				);
				const temporaryPath = yield* commentEditTemporaryPathEffect(
					storePath,
					recordId,
					commentId,
				);
				const markdown = yield* editTemporaryFileEffect(
					temporaryPath,
					formatRecordCommentMarkdown(existing),
					parsed,
				);
				const edited = yield* replaceRecordCommentFromEditedMarkdownEffect({
					storePath,
					recordId,
					commentId,
					markdown,
				});
				return present({ updated: true, comment: edited });
			}
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				help("comment"),
			);
			return present(
				yield* addRecordCommentEffect({
					storePath,
					recordId: id,
					body: yield* readProseEffect(parsed),
				}),
			);
		});
	}
	function runCommentsEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return listEffect(
			parsed,
			"comments",
			listRecordCommentsEffect,
			formatRecordComments,
		);
	}
	function runUpdatesEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return listEffect(
			parsed,
			"updates",
			listRecordUpdatesEffect,
			formatRecordUpdates,
		);
	}
	function runHistoryEffect(
		parsed: Parsed,
	): Effect.Effect<CommandOutput, unknown, FileSystem> {
		return listEffect(
			parsed,
			"history",
			listRecordHistoryEffect,
			formatRecordHistory,
		);
	}
	function listEffect<T>(
		parsed: Parsed,
		name: string,
		list: (
			store: AbsolutePath,
			id: RecordId,
		) => Effect.Effect<ReadonlyArray<T>, unknown, FileSystem>,
		format: (items: ReadonlyArray<T>) => string,
	) {
		return Effect.gen(function* () {
			const id = yield* singleRecordIdEffect(
				parsed.positionals[1],
				parsed.positionals.slice(2),
				help(name),
			);
			const items = yield* list(yield* readyStoreEffect(parsed), id);
			return parsed.presentation === "json"
				? present(items)
				: present(items, 0, format(items));
		});
	}
}

export type CommentsCommands = ReturnType<typeof createCommentsCommands>;

export function latestRecordComment(
	comments: ReadonlyArray<RecordComment>,
): RecordComment | null {
	return comments.length === 0 ? null : (comments[comments.length - 1] ?? null);
}
export function formatRecordComments(
	comments: ReadonlyArray<RecordComment>,
): string {
	return comments.length === 0
		? "No comments."
		: comments
				.map(
					(comment) =>
						`comment ${comment.id}\t${comment.createdAt}\n${comment.body.trimEnd()}`,
				)
				.join("\n\n");
}
export function formatRecordUpdates(
	updates: ReadonlyArray<RecordUpdate>,
): string {
	return updates.length === 0
		? "No updates."
		: updates
				.map(
					(update) =>
						`update ${update.sequence}\t${update.createdAt}\t${update.type}\t${update.summary}`,
				)
				.join("\n");
}
export function formatRecordHistory(
	history: ReadonlyArray<RecordHistoryEntry>,
): string {
	return history.length === 0
		? "No history."
		: history
				.map((entry) =>
					entry.kind === "comment"
						? `[comment] ${entry.comment.id}\t${entry.createdAt}\n${entry.comment.body.trimEnd()}`
						: `[update] ${entry.update.sequence}\t${entry.createdAt}\t${entry.update.type}\t${entry.update.summary}`,
				)
				.join("\n");
}

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
function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
	});
}
function usage(message: string): ForgeError {
	return new ForgeError({ kind: "config-invalid", message });
}
function recordIdFromTextEffect(value: string) {
	return Effect.try({
		try: () => parseRecordId(Number(value)),
		catch: (error) => error,
	});
}
function singleRecordIdEffect(
	value: string | undefined,
	rest: ReadonlyArray<string>,
	message: string,
) {
	return Effect.try({
		try: () => {
			if (value === undefined || rest.length > 0) {
				throw usage(message);
			}
			return parseRecordId(Number(value));
		},
		catch: (error) => error,
	});
}
function parseCommentIdEffect(value: string) {
	return Effect.try({
		try: () => {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) {
				throw usage(`Invalid comment id '${value}'.`);
			}
			return n as CommentId;
		},
		catch: (error) => error,
	});
}
function findRecordCommentEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
	commentId: CommentId,
) {
	return Effect.gen(function* () {
		const comment = (yield* listRecordCommentsEffect(storePath, recordId)).find(
			(candidate) => candidate.id === commentId,
		);
		if (comment === undefined) {
			return yield* Effect.fail(
				new ForgeError({
					kind: "record-not-found",
					message: `Comment '${commentId}' was not found for record '${recordId}'.`,
				}),
			);
		}
		return comment;
	});
}
function readProseEffect(parsed: Parsed) {
	return Effect.gen(function* () {
		const inline = stringFlag(parsed.flags.message);
		const file = stringFlag(parsed.flags["message-file"]);
		if ((inline === undefined) === (file === undefined)) {
			return yield* Effect.fail(
				usage(
					"Provide exactly one of --message <md>, --message-file <file>, or --message -.",
				),
			);
		}
		if (file !== undefined) {
			return yield* readTextFileEffect(file);
		}
		if (inline === "-") {
			return yield* readNodeStreamTextEffect(parsed.stdin);
		}
		if (inline === undefined) {
			return yield* Effect.fail(
				usage(
					"Provide exactly one of --message <md>, --message-file <file>, or --message -.",
				),
			);
		}
		return inline;
	});
}
function stringFlag(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function commentEditTemporaryPathEffect(
	storePath: AbsolutePath,
	recordId: RecordId,
	commentId: CommentId,
) {
	return Effect.try({
		try: () =>
			parseAbsolutePath(
				`${storePath}/comment-${recordId}-${commentId}.edit-${uniqueNodeProcessSuffix()}.md`,
				"temporaryPath",
			),
		catch: (error) => error,
	});
}
function editTemporaryFileEffect(
	filePath: AbsolutePath,
	initialContent: string,
	parsed: Parsed,
) {
	return Effect.gen(function* () {
		const fs = yield* FileSystem;
		yield* fs.writeFileString(filePath, initialContent);
		yield* runEditorEffect(filePath, parsed);
		return yield* readTextFileEffect(filePath);
	}).pipe(
		Effect.ensuring(
			Effect.gen(function* () {
				const fs = yield* FileSystem;
				yield* fs.remove(filePath, { recursive: false }).pipe(Effect.ignore);
			}).pipe(Effect.ignore),
		),
	);
}
function runEditorEffect(filePath: AbsolutePath, parsed: Parsed) {
	const editor = fallbackEditor(parsed.env);
	if (editor === undefined || editor.trim() === "") {
		return Effect.fail(usage("EDITOR must be set to edit records."));
	}
	return PlatformCommand.make(
		`${editor} '${filePath.replaceAll("'", `'\\''`)}'`,
	).pipe(
		PlatformCommand.runInShell(true),
		PlatformCommand.stdin("inherit"),
		PlatformCommand.stdout("inherit"),
		PlatformCommand.stderr("inherit"),
		PlatformCommand.env(parsed.env),
		PlatformCommand.exitCode,
		Effect.flatMap((code) =>
			Number(code) === 0
				? Effect.void
				: Effect.fail(
						new ForgeError({
							kind: "config-invalid",
							message: `Editor exited with code ${code}.`,
						}),
					),
		),
	);
}
