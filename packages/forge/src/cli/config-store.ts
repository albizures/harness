import * as Args from "@effect/cli/Args";
import * as CliCommand from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import type { FileSystem } from "@effect/platform/FileSystem";
import { Effect } from "effect";
import type { CommandOutput, Parsed } from "./types.ts";
import { commandHandler as buildCommandHandler, present } from "./support.ts";
import { decodeConfigSetInput } from "../command-inputs.ts";
import { parseAbsolutePath, type AbsolutePath } from "../domain.ts";
import { ForgeError } from "../errors.ts";
import {
	ensureStoreRootEffect,
	loadForgeConfigEffect,
	storeDoctorEffect,
	writeForgeConfigEffect,
} from "../filesystem-store.ts";

type CommandHandler = typeof buildCommandHandler;

const presentationOptions = {
	json: Options.boolean("json").pipe(
		Options.withDescription("Render command output as JSON."),
	),
};

export function createConfigStoreCommands(
	commandHandler: CommandHandler = buildCommandHandler,
) {
	const configGetCommand = CliCommand.make("get", {
		key: Args.optional(Args.text({ name: "storePath" })),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["config", "get"], runConfigGetEffect, ["key"]),
		),
		CliCommand.withDescription("Print the Forge config or a config value."),
	);
	const configSetCommand = CliCommand.make("set", {
		key: Args.text({ name: "storePath" }),
		value: Args.text({ name: "absolute-path" }),
		...presentationOptions,
	}).pipe(
		CliCommand.withHandler(
			commandHandler(["config", "set"], runConfigSetEffect, ["key", "value"]),
		),
		CliCommand.withDescription("Set a Forge config value."),
	);
	const configCommand = CliCommand.make("config").pipe(
		CliCommand.withHandler(commandHandler(["config"], runConfigEffect)),
		CliCommand.withDescription("Read or update Forge CLI configuration."),
		CliCommand.withSubcommands([configGetCommand, configSetCommand]),
	);

	const storePathCommand = CliCommand.make("path").pipe(
		CliCommand.withHandler(
			commandHandler(["store", "path"], runStorePathEffect),
		),
		CliCommand.withDescription("Print the active Forge store path."),
	);
	const storeDoctorCommand = CliCommand.make("doctor").pipe(
		CliCommand.withHandler(
			commandHandler(["store", "doctor"], runStoreDoctorEffect),
		),
		CliCommand.withDescription("Validate the active Forge store."),
	);
	const storeCommand = CliCommand.make("store").pipe(
		CliCommand.withHandler(commandHandler(["store"], runStoreEffect)),
		CliCommand.withDescription("Inspect the configured Forge store."),
		CliCommand.withSubcommands([storePathCommand, storeDoctorCommand]),
	);

	return {
		configCommand,
		storeCommand,
		registrations: [
			{ path: ["config"], descriptor: configCommand },
			{ path: ["config", "get"], descriptor: configGetCommand },
			{ path: ["config", "set"], descriptor: configSetCommand },
			{ path: ["store"], descriptor: storeCommand },
			{ path: ["store", "path"], descriptor: storePathCommand },
			{ path: ["store", "doctor"], descriptor: storeDoctorCommand },
		],
	};
}

export type ConfigStoreCommands = ReturnType<typeof createConfigStoreCommands>;

function runConfigEffect(
	_parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.fail(usage("Usage: forge config <get|set>"));
}

function runConfigGetEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		const key = parsed.positionals[2];
		if (key !== undefined && key !== "storePath") {
			return yield* Effect.fail(usage("Usage: forge config get [storePath]"));
		}
		const storePathOverride =
			parsed.storeOverride === undefined
				? undefined
				: yield* parseAbsolutePathEffect(parsed.storeOverride, "storePath");
		const config = yield* loadForgeConfigEffect({
			homeDirectory,
			storePathOverride,
		});
		return present(key === "storePath" ? config.storePath : config);
	});
}

function runConfigSetEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const [key, value, ...tail] = parsed.positionals.slice(2);
		if (key === undefined || value === undefined || tail.length > 0) {
			return yield* Effect.fail(
				usage("Usage: forge config set storePath <absolute-path>"),
			);
		}
		const homeDirectory = yield* parseAbsolutePathEffect(
			parsed.homeDirectory,
			"homeDirectory",
		);
		const input = yield* Effect.try({
			try: () => decodeConfigSetInput({ key, value }),
			catch: (error) => error,
		});
		const config = { storePath: input.value };
		yield* writeForgeConfigEffect({ homeDirectory, config });
		yield* ensureStoreRootEffect({ storePath: input.value });
		return present({ updated: true, ...config });
	});
}

function runStoreEffect(
	_parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, never> {
	return Effect.fail(usage("Usage: forge store <path|doctor>"));
}

function runStorePathEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.map(resolveStorePathEffect(parsed), (storePath) =>
		present(storePath),
	);
}

function runStoreDoctorEffect(
	parsed: Parsed,
): Effect.Effect<CommandOutput, unknown, FileSystem> {
	return Effect.gen(function* () {
		const storePath = yield* resolveStorePathEffect(parsed);
		const report = yield* storeDoctorEffect({ storePath });
		return present(report, report.ok ? 0 : 2);
	});
}

function parseAbsolutePathEffect(value: string, field: string) {
	return Effect.try({
		try: () => parseAbsolutePath(value, field),
		catch: (error) => error,
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
		const config = yield* loadForgeConfigEffect({ homeDirectory });
		return config.storePath;
	});
}

function usage(message: string): ForgeError {
	return new ForgeError({ kind: "config-invalid", message });
}
