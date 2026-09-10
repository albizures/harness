import type { JsonValue } from "type-fest";
import type { Envelope } from "./envelope.ts";
import type { ManifestCommand, WorkflowManifest } from "../domain/manifest/schema.ts";
import type { Tracker } from "../ports/tracker.ts";
import {
	readOption,
	readInput as internalReadInput,
} from "./commands/shared.ts";

export type CommandHandlerContext = {
	command: ManifestCommand;
	manifest: WorkflowManifest;
	tracker: Tracker;
	input: JsonValue;
	issueId?: string;
	args?: Array<string>;
	stdin?: string;
};

export type CommandHandlerResult = Envelope | JsonValue;

export type CommandHandler = ((
	context: CommandHandlerContext,
) => CommandHandlerResult | Promise<CommandHandlerResult>) & {
	/**
	 * Raw handlers own CLI option/input parsing. Core still validates command
	 * declaration and handler output, but does not assume JSON input semantics.
	 */
	rawInput?: true;
};

export type CommandHandlers = Record<string, CommandHandler>;

export async function readInput(
	context: CommandHandlerContext,
): Promise<[path: string, content: string]> {
	const { args = [], stdin } = context;
	const inputPath = readOption(args, "--input");
	if (inputPath === undefined) {
		throw new Error("No input file available");
	}

	const raw = await internalReadInput(inputPath, stdin);

	return [inputPath, raw];
}
