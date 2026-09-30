import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import type { FileSystem } from "@effect/platform/FileSystem";
import type { Effect } from "effect";

export type Presentation = "human" | "json";

export type FlagValue = string | boolean | ReadonlyArray<string>;

export type CliOutput = Pick<NodeJS.WriteStream, "write"> & {
	readonly columns?: number;
	readonly isTTY?: boolean;
};

export type CliInvocationContext = {
	readonly presentation: Presentation;
	readonly cwd: string;
	readonly homeDirectory: string;
	readonly storeOverride?: string;
	readonly stdin: NodeJS.ReadableStream;
	readonly stdout: CliOutput;
	readonly stderr: CliOutput;
	readonly env: NodeJS.ProcessEnv;
};

export type CommandOutput = {
	readonly value: unknown;
	readonly code: number;
	readonly human?: string;
};

export type Parsed = CliInvocationContext & {
	readonly positionals: ReadonlyArray<string>;
	readonly flags: Readonly<Record<string, FlagValue>>;
};

export type CliAction = (
	parsed: Parsed,
) => Effect.Effect<CommandOutput, unknown, CommandExecutor | FileSystem>;

export type CliCommandRegistration = {
	readonly path: ReadonlyArray<string>;
	readonly descriptor: unknown;
};
