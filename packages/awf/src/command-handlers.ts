import type { JsonValue } from "type-fest";
import type { Envelope } from "./envelope.ts";
import type { ManifestCommand, WorkflowManifest } from "./manifest.ts";
import type { Tracker } from "./tracker.ts";

export type CommandHandlerContext = {
	command: ManifestCommand;
	manifest: WorkflowManifest;
	tracker: Tracker;
	input: JsonValue;
	issueId?: string;
};

export type CommandHandlerResult = Envelope | JsonValue;

export type CommandHandler = (
	context: CommandHandlerContext,
) => CommandHandlerResult | Promise<CommandHandlerResult>;

export type CommandHandlers = Record<string, CommandHandler>;
